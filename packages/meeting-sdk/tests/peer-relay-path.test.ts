import { afterEach, describe, expect, it, vi } from "vitest";
import { FakePeerConnection } from "./support/fakePeerConnection.js";
import { type EngineHarness, createP2PHarness, recordEvents } from "./support/harness.js";
import { joinedPair, sentPeerFrames, settle } from "./support/p2p.js";
import { connectionsOf, iso, pushRefresh, relayServers, setPathTypes } from "./support/relay.js";

const NOW = Date.UTC(2026, 9, 6, 12);
const LATER = NOW + 600_000;

type Kind = "direct" | "relayed";

/** The `webrtc.connected` payload toward `peerParticipantId` for the given local and remote sides. */
function report(peerParticipantId: string, localPath: Kind, remotePath: Kind) {
  const path: Kind = localPath === "relayed" || remotePath === "relayed" ? "relayed" : "direct";
  return { peerParticipantId, path, localPath, remotePath };
}

describe("peer media › reported media path", () => {
  let h: EngineHarness;

  function harness(local: string, remote: string): EngineHarness {
    h = createP2PHarness({ iceServers: relayServers(NOW + 60_000, "a"), iceServersExpireAt: iso(NOW + 60_000) });
    h.network.defaultCandidateTypes = { local, remote };
    return h;
  }

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    expect(h.realtime.handlerErrors).toEqual([]);
    h.cleanup();
  });

  const connectedReports = (participantId: string) =>
    sentPeerFrames(h, participantId)
      .filter((f) => f.type === "webrtc.connected")
      .map((f) => f.payload);

  it("first connect reports both sides relayed when both candidates are relays", async () => {
    harness("relay", "relay");
    const { lowId, highId } = await joinedPair(h);
    expect(connectedReports(lowId)).toEqual([report(highId, "relayed", "relayed")]);
    expect(connectedReports(highId)).toEqual([report(lowId, "relayed", "relayed")]);
  });

  it("first connect reports only the local side relayed when only the local candidate is a relay", async () => {
    harness("relay", "host");
    const { lowId, highId } = await joinedPair(h);
    expect(connectedReports(lowId)).toEqual([report(highId, "relayed", "direct")]);
  });

  it("first connect reports only the remote side relayed when only the remote candidate is a relay", async () => {
    harness("host", "relay");
    const { lowId, highId } = await joinedPair(h);
    expect(connectedReports(lowId)).toEqual([report(highId, "direct", "relayed")]);
  });

  it("first connect reports direct on both sides when neither candidate is a relay", async () => {
    harness("srflx", "host");
    const { lowId, highId } = await joinedPair(h);
    expect(connectedReports(lowId)).toEqual([report(highId, "direct", "direct")]);
    expect(connectedReports(highId)).toEqual([report(lowId, "direct", "direct")]);
  });

  it("treats a peer-reflexive remote candidate as direct", async () => {
    harness("host", "prflx");
    const { lowId, highId } = await joinedPair(h);
    expect(connectedReports(lowId)).toEqual([report(highId, "direct", "direct")]);
  });

  it("omits the path when stats are unavailable", async () => {
    harness("relay", "relay");
    vi.spyOn(FakePeerConnection.prototype, "getStats").mockRejectedValue(new DOMException("stats unavailable", "InvalidStateError"));
    const { lowId, highId } = await joinedPair(h);
    expect(connectedReports(lowId)).toEqual([{ peerParticipantId: highId }]);
  });

  it("reports the current path again after each reconnection", async () => {
    harness("host", "host");
    const { lowId, highId } = await joinedPair(h);
    const { lowPc } = connectionsOf(h);
    lowPc.setConnectionState("disconnected");
    await settle();
    const current = lowPc.selectedPair!;
    lowPc.setSelectedPair({ ...current, localType: "relay" });
    lowPc.setConnectionState("connected");
    await settle();
    expect(connectedReports(lowId)).toEqual([report(highId, "direct", "direct"), report(highId, "relayed", "direct")]);
  });

  describe("after a planned switch", () => {
    async function advance(ms: number): Promise<void> {
      await vi.advanceTimersByTimeAsync(ms);
      await settle();
    }

    it("re-sends the connected report with the current path once the switch completes", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"], now: NOW });
      harness("relay", "relay");
      const { lowId, highId } = await joinedPair(h);
      pushRefresh(h, [lowId], LATER);
      await settle();
      expect(connectedReports(lowId)).toHaveLength(1);
      await advance(1000);
      expect(h.realtime.restartResults).toEqual([{ from: lowId, peerParticipantId: highId, outcome: "completed" }]);
      expect(connectedReports(lowId)).toEqual([report(highId, "relayed", "relayed"), report(highId, "relayed", "relayed")]);
    });

    it("reports direct when the switch lands on a direct path", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"], now: NOW });
      harness("relay", "relay");
      const { lowId, highId } = await joinedPair(h);
      const { lowPc } = connectionsOf(h);
      const current = lowPc.selectedPair!;
      lowPc.scheduleNewPairAfterRestart(500, { localId: "fresh-host", localType: "host", remoteId: "fresh-remote", remoteType: "srflx" });
      expect(current.localType).toBe("relay");
      pushRefresh(h, [lowId], LATER);
      await settle();
      await advance(1000);
      expect(connectedReports(lowId).at(-1)).toEqual(report(highId, "direct", "direct"));
    });

    it("reports a one-side relay when the switch lands on a remote relay only", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"], now: NOW });
      harness("relay", "relay");
      const { lowId, highId } = await joinedPair(h);
      const { lowPc } = connectionsOf(h);
      lowPc.scheduleNewPairAfterRestart(500, { localId: "fresh-host", localType: "host", remoteId: "fresh-remote", remoteType: "relay" });
      pushRefresh(h, [lowId], LATER);
      await settle();
      await advance(1000);
      expect(connectedReports(lowId).at(-1)).toEqual(report(highId, "direct", "relayed"));
    });

    it("sends no extra connected report when the switch fails", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"], now: NOW });
      harness("relay", "relay");
      const { lowId } = await joinedPair(h);
      connectionsOf(h).lowPc.restartBehaviour = "never";
      pushRefresh(h, [lowId], LATER);
      await settle();
      await advance(15_000);
      expect(h.realtime.restartResults.map((r) => r.outcome)).toEqual(["failed"]);
      expect(connectedReports(lowId)).toHaveLength(1);
    });
  });

  describe("path recheck", () => {
    async function advance(ms: number): Promise<void> {
      await vi.advanceTimersByTimeAsync(ms);
      await settle();
    }

    function fakeTime(): void {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"], now: NOW });
    }

    it("reports again after 2 s when the remote side settles from peer-reflexive to relay", async () => {
      fakeTime();
      harness("host", "prflx");
      const { lowId, highId } = await joinedPair(h);
      expect(connectedReports(lowId)).toEqual([report(highId, "direct", "direct")]);
      setPathTypes(connectionsOf(h).lowPc, "host", "relay");
      await advance(2_000);
      expect(connectedReports(lowId)).toEqual([report(highId, "direct", "direct"), report(highId, "direct", "relayed")]);
    });

    it("sends nothing more while the path stays the same", async () => {
      fakeTime();
      harness("relay", "host");
      const { lowId } = await joinedPair(h);
      await advance(2_000);
      await advance(8_000);
      await advance(90_000);
      expect(connectedReports(lowId)).toHaveLength(1);
    });

    it("reports a change found at a periodic check", async () => {
      fakeTime();
      harness("host", "host");
      const { lowId, highId } = await joinedPair(h);
      await advance(10_000);
      setPathTypes(connectionsOf(h).lowPc, "relay", "host");
      await advance(29_000);
      expect(connectedReports(lowId)).toHaveLength(1);
      await advance(1_000);
      expect(connectedReports(lowId)).toEqual([report(highId, "direct", "direct"), report(highId, "relayed", "direct")]);
    });

    it("leaves the path to the switch while a switch is in progress", async () => {
      fakeTime();
      harness("relay", "relay");
      const { lowId } = await joinedPair(h);
      const { lowPc } = connectionsOf(h);
      lowPc.restartBehaviour = "never";
      pushRefresh(h, [lowId], LATER);
      await settle();
      setPathTypes(lowPc, "relay", "host");
      await advance(12_000);
      expect(connectedReports(lowId)).toHaveLength(1);
    });

    it("sends nothing while the connection is interrupted", async () => {
      fakeTime();
      harness("host", "host");
      const { lowId } = await joinedPair(h);
      const { lowPc } = connectionsOf(h);
      lowPc.setConnectionState("disconnected");
      await settle();
      setPathTypes(lowPc, "relay", "host");
      await advance(40_000);
      expect(connectedReports(lowId)).toHaveLength(1);
    });

    it("stops reading the path once the connection is closed", async () => {
      fakeTime();
      harness("host", "host");
      const { high } = await joinedPair(h);
      const { lowPc } = connectionsOf(h);
      const stats = vi.spyOn(lowPc, "getStats");
      await high.leave();
      await settle();
      stats.mockClear();
      await advance(60_000);
      expect(stats).not.toHaveBeenCalled();
    });
  });

  it("never exposes the path in public events", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"], now: NOW });
    harness("relay", "relay");
    const { low, lowId } = await joinedPair(h);
    const events = recordEvents(low, { media: true });
    const { lowPc } = connectionsOf(h);
    lowPc.setConnectionState("disconnected");
    await vi.advanceTimersByTimeAsync(10);
    lowPc.setConnectionState("connected");
    await settle();
    pushRefresh(h, [lowId], LATER);
    await settle();
    await vi.advanceTimersByTimeAsync(1000);
    await settle();
    const published = events.filter((e) => e.type === "media_connection_changed" || e.type === "remote_media_changed");
    expect(published.length).toBeGreaterThan(0);
    const text = JSON.stringify(published);
    for (const word of ["path", "relayed", "direct", "relay"]) expect(text).not.toContain(word);
  });
});
