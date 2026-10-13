import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type EngineHarness, createP2PHarness } from "./support/harness.js";
import { type Pair, joinedPair, sentPeerFrames, settle } from "./support/p2p.js";
import { connectionsOf, iso, pushRefresh, relayServers, setPathTypes } from "./support/relay.js";

const NOW = Date.UTC(2026, 9, 6, 12);
const LATER = NOW + 600_000;

describe("peer media › planned switch to fresh candidates", () => {
  let h: EngineHarness;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"], now: NOW });
    h = createP2PHarness({ iceServers: relayServers(NOW + 60_000, "a"), iceServersExpireAt: iso(NOW + 60_000) });
    h.network.defaultCandidateTypes = { local: "relay", remote: "relay" };
  });

  afterEach(() => {
    vi.useRealTimers();
    expect(h.realtime.handlerErrors).toEqual([]);
    h.cleanup();
  });

  async function advance(ms: number): Promise<void> {
    await vi.advanceTimersByTimeAsync(ms);
    await settle();
  }

  const typesSent = (participantId: string) => sentPeerFrames(h, participantId).map((f) => f.type);

  async function relayedOn(side: "low" | "high" | "both"): Promise<Pair & ReturnType<typeof connectionsOf>> {
    const pair = await joinedPair(h);
    const pcs = connectionsOf(h);
    if (side === "low") setPathTypes(pcs.highPc, "host", "relay");
    if (side === "high") setPathTypes(pcs.lowPc, "host", "relay");
    return { ...pair, ...pcs };
  }

  it("offerer on a relay: restarts, the answerer accepts the new offer, and the attempt completes", async () => {
    const { low, lowId, highId, lowPc, highPc } = await relayedOn("low");
    const camera = low.remoteMedia(highId).camera;
    const transceivers = highPc.getTransceivers();
    const before = lowPc.selectedPair?.localId;
    pushRefresh(h, [lowId], LATER);
    await settle();
    expect(lowPc.restartOffers).toBe(1);
    expect(highPc.restarts).toBe(1);
    expect(typesSent(highId).filter((t) => t === "webrtc.answer")).toHaveLength(2);
    expect(h.realtime.restartResults).toEqual([]);

    await advance(1000);
    expect(lowPc.selectedPair?.localId).not.toBe(before);
    expect(h.realtime.restartResults).toEqual([{ from: lowId, peerParticipantId: highId, outcome: "completed" }]);
    expect(highPc.getTransceivers()).toEqual(transceivers);
    expect(low.remoteMedia(highId).camera).toBe(camera);
    expect(low.mediaConnectionStatus(highId)).toBe("connected");
    expect(typesSent(highId)).not.toContain("webrtc.ice_restart");
  });

  it("answerer on a relay: asks the offerer to restart, then completes", async () => {
    const { lowId, highId, lowPc, highPc } = await relayedOn("high");
    pushRefresh(h, [highId], LATER);
    await settle();
    expect(typesSent(highId).filter((t) => t === "webrtc.ice_restart")).toHaveLength(1);
    const request = sentPeerFrames(h, highId).find((f) => f.type === "webrtc.ice_restart");
    expect(request?.payload).toEqual({ targetParticipantId: lowId });
    expect(lowPc.restartOffers).toBe(1);
    expect(highPc.restarts).toBe(1);

    await advance(1000);
    expect(h.realtime.restartResults).toEqual([{ from: highId, peerParticipantId: lowId, outcome: "completed" }]);
  });

  it("completes only once a new local candidate is selected", async () => {
    const { lowId, highId, lowPc } = await relayedOn("low");
    const current = lowPc.selectedPair;
    if (!current) throw new Error("not connected");
    lowPc.scheduleNewPairAfterRestart(3500, { ...current, localId: "fresh-relay" });
    pushRefresh(h, [lowId], LATER);
    await settle();
    await advance(3000);
    expect(h.realtime.restartResults).toEqual([]);
    await advance(1000);
    expect(h.realtime.restartResults).toEqual([{ from: lowId, peerParticipantId: highId, outcome: "completed" }]);
  });

  it("reports a failed attempt after 15 s and retries after 5, 10, then 20 s", async () => {
    const { low, lowId, highId, lowPc } = await relayedOn("low");
    lowPc.restartBehaviour = "never";
    pushRefresh(h, [lowId], LATER);
    await settle();
    const outcomes = () => h.realtime.restartResults.map((r) => r.outcome);
    expect(lowPc.restartOffers).toBe(1);

    await advance(14_999);
    expect(outcomes()).toEqual([]);
    await advance(1);
    expect(outcomes()).toEqual(["failed"]);

    await advance(4_999);
    expect(lowPc.restartOffers).toBe(1);
    await advance(1);
    expect(lowPc.restartOffers).toBe(2);

    await advance(15_000);
    expect(outcomes()).toEqual(["failed", "failed"]);
    await advance(9_999);
    expect(lowPc.restartOffers).toBe(2);
    await advance(1);
    expect(lowPc.restartOffers).toBe(3);

    for (const expected of [4, 5]) {
      await advance(15_000);
      await advance(19_999);
      expect(lowPc.restartOffers).toBe(expected - 1);
      await advance(1);
      expect(lowPc.restartOffers).toBe(expected);
    }
    expect(lowPc.closed).toBe(false);
    expect(low.mediaConnectionStatus(highId)).toBe("connected");
    expect(h.realtime.peerReports.filter((r) => r.type === "webrtc.failed")).toEqual([]);
  });

  it("stops retrying 5 s before the credentials expire and keeps the connection", async () => {
    const { low, lowId, highId, lowPc } = await relayedOn("low");
    lowPc.restartBehaviour = "never";
    pushRefresh(h, [lowId], NOW + 40_000);
    await settle();
    await advance(15_000);
    await advance(5_000);
    expect(lowPc.restartOffers).toBe(2);
    await advance(15_000);
    expect(h.realtime.restartResults.map((r) => r.outcome)).toEqual(["failed", "failed"]);
    await advance(120_000);
    expect(lowPc.restartOffers).toBe(2);
    expect(h.realtime.restartResults).toHaveLength(2);
    expect(lowPc.closed).toBe(false);
    expect(low.mediaConnectionStatus(highId)).toBe("connected");
  });

  it("a failed restart negotiation fails the attempt at once and keeps the connection", async () => {
    const { low, lowId, highId, lowPc } = await relayedOn("low");
    h.network.failNext("createOffer");
    pushRefresh(h, [lowId], LATER);
    await settle();
    expect(h.realtime.restartResults).toEqual([{ from: lowId, peerParticipantId: highId, outcome: "failed" }]);
    expect(lowPc.closed).toBe(false);
    expect(low.mediaConnectionStatus(highId)).toBe("connected");
    await advance(5_000);
    expect(lowPc.restartOffers).toBe(1);
    await advance(1_000);
    expect(h.realtime.restartResults.map((r) => r.outcome)).toEqual(["failed", "completed"]);
  });

  it("cancels every switch timer when the connection closes during a switch", async () => {
    const { high, lowId, lowPc } = await relayedOn("low");
    lowPc.restartBehaviour = "never";
    pushRefresh(h, [lowId], LATER);
    await settle();
    await high.leave();
    await settle();
    expect(lowPc.closed).toBe(true);
    await advance(120_000);
    expect(lowPc.restartOffers).toBe(1);
    expect(h.realtime.restartResults).toEqual([]);
  });

  it("restarts again for the answerer's request when its own restart already finished before that refresh", async () => {
    const { lowId, highId, lowPc, highPc } = await relayedOn("both");
    pushRefresh(h, [lowId], LATER, "b");
    await settle();
    expect(lowPc.restartOffers).toBe(1);
    expect(lowPc.signalingState).toBe("stable");
    pushRefresh(h, [highId], LATER + 1000, "c");
    await settle();
    expect(lowPc.restartOffers).toBe(2);
    expect(highPc.restarts).toBe(2);
    await advance(1000);
    expect(h.realtime.restartResults).toEqual(
      expect.arrayContaining([
        { from: lowId, peerParticipantId: highId, outcome: "completed" },
        { from: highId, peerParticipantId: lowId, outcome: "completed" },
      ]),
    );
    expect(h.realtime.restartResults.map((r) => r.outcome)).not.toContain("failed");
  });

  it("runs one restart negotiation when both sides refresh at the same time", async () => {
    const { lowId, highId, lowPc, highPc } = await relayedOn("both");
    pushRefresh(h, [lowId, highId], LATER);
    await settle();
    await advance(1000);
    expect(lowPc.restartOffers).toBe(1);
    expect(highPc.restarts).toBe(1);
    expect(h.realtime.restartResults).toEqual(
      expect.arrayContaining([
        { from: lowId, peerParticipantId: highId, outcome: "completed" },
        { from: highId, peerParticipantId: lowId, outcome: "completed" },
      ]),
    );
    expect(h.realtime.restartResults).toHaveLength(2);
  });
});
