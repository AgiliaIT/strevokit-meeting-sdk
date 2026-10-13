import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type EngineHarness, createP2PHarness } from "./support/harness.js";
import { joinedPair, orderedIds, sentPeerFrames, settle } from "./support/p2p.js";
import { connectionsOf, iso, pushRefresh, relayServers } from "./support/relay.js";

const EXPIRES_AT = Date.now() + 600_000;

describe("peer media › connectivity server refresh", () => {
  let h: EngineHarness;

  beforeEach(() => {
    h = createP2PHarness({ iceServers: relayServers(EXPIRES_AT, "a"), iceServersExpireAt: iso(EXPIRES_AT) });
  });

  afterEach(() => {
    expect(h.realtime.handlerErrors).toEqual([]);
    h.cleanup();
  });

  const restartFrames = (participantId: string) =>
    sentPeerFrames(h, participantId).filter((f) => f.type === "webrtc.ice_restart" || f.type === "webrtc.ice_restart_result");

  it("keeps the latest list and uses it for a connection created after the other participant reconnects", async () => {
    const { lowId, highId } = await joinedPair(h);
    const fresh = pushRefresh(h, [lowId], EXPIRES_AT + 600_000);
    await settle();
    const before = h.network.connections.length;
    h.realtime.sendMessage("participant.reconnected", {}, highId, lowId);
    await settle();

    const created = h.network.connections[before];
    expect(created).toBeDefined();
    expect(created?.configuration.iceServers).toEqual(fresh);
  });

  it("replaces the server list on the open connection and keeps the browser's other settings", async () => {
    const { lowId } = await joinedPair(h);
    const { lowPc } = connectionsOf(h);
    const fresh = pushRefresh(h, [lowId], EXPIRES_AT + 600_000);
    await settle();
    expect(lowPc.configurationCalls).toHaveLength(1);
    expect(lowPc.configurationCalls[0]).toEqual({ bundlePolicy: "balanced", rtcpMuxPolicy: "require", iceCandidatePoolSize: 0, iceServers: fresh });
    expect(lowPc.configuration.iceServers).toEqual(fresh);
    expect(lowPc.closed).toBe(false);
  });

  it("does not restart a connection that is still being set up", async () => {
    h.network.autoConnect = false;
    const { lowId, highId } = await joinedPair(h);
    h.network.defaultCandidateTypes = { local: "relay", remote: "relay" };
    pushRefresh(h, [lowId, highId], EXPIRES_AT + 600_000);
    await settle();
    for (const pc of h.network.connections) {
      expect(pc.restartOffers).toBe(0);
      expect(pc.restarts).toBe(0);
      expect(pc.configurationCalls).toHaveLength(1);
    }
    expect(restartFrames(lowId)).toEqual([]);
    expect(restartFrames(highId)).toEqual([]);
  });

  it("leaves a direct connection alone: no restart and no frames", async () => {
    const { lowId, highId } = await joinedPair(h);
    pushRefresh(h, [lowId, highId], EXPIRES_AT + 600_000);
    await settle();
    await new Promise((resolve) => setTimeout(resolve, 1100));
    await settle();
    const { lowPc, highPc } = connectionsOf(h);
    expect(lowPc.selectedPair?.localType).toBe("host");
    expect([lowPc.restartOffers, lowPc.restarts, highPc.restarts]).toEqual([0, 0, 0]);
    expect(restartFrames(lowId)).toEqual([]);
    expect(restartFrames(highId)).toEqual([]);
    expect(h.realtime.restartResults).toEqual([]);
  });

  it("leaves a connection alone when only the other side sends through a relay", async () => {
    h.network.defaultCandidateTypes = { local: "host", remote: "relay" };
    const { lowId } = await joinedPair(h);
    pushRefresh(h, [lowId], EXPIRES_AT + 600_000);
    await settle();
    const { lowPc } = connectionsOf(h);
    expect(lowPc.restartOffers).toBe(0);
    expect(restartFrames(lowId)).toEqual([]);
  });

  it("ignores fresh servers that arrive before the meeting is joined", async () => {
    h.realtime.holdWelcome = true;
    const { low: lowId, high: highId } = orderedIds();
    const low = h.createEngine({ participantId: lowId });
    const high = h.createEngine({ participantId: highId });
    const joining = Promise.all([low.join(), high.join()]);
    await settle();
    expect(low.state).toBe("joining");
    pushRefresh(h, [lowId, highId], EXPIRES_AT + 600_000);
    await settle();
    h.realtime.releaseWelcome();
    await joining;
    await settle();

    expect(h.network.connections.length).toBeGreaterThan(0);
    for (const pc of h.network.connections) {
      expect(pc.configuration.iceServers).toEqual(relayServers(EXPIRES_AT, "a"));
      expect(pc.configurationCalls).toEqual([]);
    }
    expect(restartFrames(lowId)).toEqual([]);
  });
});
