import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MeetingEngine } from "../src/public/types.js";
import type { FakePeerConnection } from "./support/fakePeerConnection.js";
import { type EngineHarness, type RecordedEvent, createP2PHarness, eventsOfType, recordEvents } from "./support/harness.js";
import { orderedIds, sentPeerFrames, settle } from "./support/p2p.js";

describe("peer media › connection status", () => {
  let h: EngineHarness;

  beforeEach(() => {
    h = createP2PHarness();
  });

  afterEach(() => {
    vi.useRealTimers();
    expect(h.realtime.handlerErrors).toEqual([]);
    h.cleanup();
  });

  type Joined = {
    low: MeetingEngine;
    high: MeetingEngine;
    lowId: string;
    highId: string;
    lowEvents: RecordedEvent[];
    lowPc: FakePeerConnection;
  };

  async function pair(): Promise<Joined> {
    const { low: lowId, high: highId } = orderedIds();
    const low = h.createEngine({ participantId: lowId });
    const high = h.createEngine({ participantId: highId });
    const lowEvents = recordEvents(low, { media: true });
    await low.join();
    await high.join();
    await settle();
    const lowPc = h.network.connections[0];
    if (!lowPc) throw new Error("no connection");
    return { low, high, lowId, highId, lowEvents, lowPc };
  }

  const statuses = (events: RecordedEvent[], participantId: string) =>
    eventsOfType(events, "media_connection_changed")
      .filter((e) => e.participantId === participantId)
      .map((e) => e.status);

  const reportsFrom = (participantId: string) =>
    h.realtime.peerReports.filter((r) => r.from === participantId).map((r) => [r.type, r.peerParticipantId]);

  it("reports connecting, then connected, and tells the platform once", async () => {
    const { low, lowId, highId, lowEvents } = await pair();
    expect(statuses(lowEvents, highId)).toEqual(["connecting", "connected"]);
    expect(low.mediaConnectionStatus(highId)).toBe("connected");
    expect(reportsFrom(lowId)).toEqual([["webrtc.connected", highId]]);
  });

  it("reports an interruption and the recovery, each once", async () => {
    const { low, lowId, highId, lowEvents, lowPc } = await pair();
    lowPc.setConnectionState("disconnected");
    lowPc.setConnectionState("disconnected");
    await settle();
    expect(low.mediaConnectionStatus(highId)).toBe("interrupted");
    lowPc.setConnectionState("connected");
    lowPc.setConnectionState("connected");
    await settle();
    expect(statuses(lowEvents, highId)).toEqual(["connecting", "connected", "interrupted", "connected"]);
    expect(low.mediaConnectionStatus(highId)).toBe("connected");
    expect(reportsFrom(lowId)).toEqual([
      ["webrtc.connected", highId],
      ["webrtc.disconnected", highId],
      ["webrtc.connected", highId],
    ]);
  });

  it("keeps remote media through an interruption", async () => {
    const { low, high, highId, lowPc } = await pair();
    await high.enableCamera();
    await settle();
    const camera = low.remoteMedia(highId).camera;
    expect(camera).not.toBeNull();
    lowPc.setConnectionState("disconnected");
    await settle();
    expect(low.remoteMedia(highId).camera).toBe(camera);
  });

  it("clears the status when the other participant leaves, without a failure report", async () => {
    const { low, high, lowId, highId, lowEvents } = await pair();
    await high.leave();
    await settle();
    expect(statuses(lowEvents, highId).at(-1)).toBeNull();
    expect(low.mediaConnectionStatus(highId)).toBeNull();
    expect(h.realtime.peerReports.filter((r) => r.type === "webrtc.failed")).toEqual([]);
    expect(reportsFrom(lowId)).toEqual([["webrtc.connected", highId]]);
    const left = lowEvents.findIndex((e) => e.type === "participant_left");
    const cleared = lowEvents.findIndex((e) => e.type === "media_connection_changed" && e.event.status === null);
    expect(cleared).toBeGreaterThanOrEqual(0);
    expect(cleared).toBeLessThan(left);
  });

  it("uses iceConnectionState with the same mapping when connectionState is unavailable", async () => {
    h.network.withoutConnectionState = true;
    const { low, lowId, highId, lowEvents, lowPc } = await pair();
    expect(lowPc.connectionState).toBeUndefined();
    expect(low.mediaConnectionStatus(highId)).toBe("connected");
    lowPc.setConnectionState("disconnected");
    await settle();
    lowPc.setConnectionState("connected");
    await settle();
    expect(statuses(lowEvents, highId)).toEqual(["connecting", "connected", "interrupted", "connected"]);
    expect(reportsFrom(lowId).map(([type]) => type)).toEqual(["webrtc.connected", "webrtc.disconnected", "webrtc.connected"]);
  });

  it("an interruption before the first connection is not reported", async () => {
    h.network.autoConnect = false;
    const { low, lowId, highId, lowEvents, lowPc } = await pair();
    lowPc.setConnectionState("disconnected");
    await settle();
    expect(low.mediaConnectionStatus(highId)).toBe("connecting");
    expect(statuses(lowEvents, highId)).toEqual(["connecting"]);
    expect(reportsFrom(lowId)).toEqual([]);
  });

  describe("recovery while the meeting connection stays up", () => {
    type Entry = { level: string; message: string; fields: Record<string, string | number | boolean> | undefined };

    function recordingLogger(): { entries: Entry[]; logger: NonNullable<Parameters<typeof h.createEngine>[0]>["logger"] } {
      const entries: Entry[] = [];
      const write = (level: string) => (message: string, fields?: Record<string, string | number | boolean>) => {
        entries.push({ level, message, fields });
      };
      return { entries, logger: { debug: write("debug"), info: write("info"), warn: write("warn"), error: write("error") } };
    }

    const offers = (participantId: string) => sentPeerFrames(h, participantId).filter((f) => f.type === "webrtc.offer").length;

    it("restarts an interrupted connection after the hold, without waiting for it to fail", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
      const { low, lowId, highId, lowEvents, lowPc } = await pair();
      const sockets = h.realtime.sockets.length;
      const before = offers(lowId);
      lowPc.setConnectionState("disconnected");
      await vi.advanceTimersByTimeAsync(2_999);
      expect(lowPc.restartOffers).toBe(0);

      await vi.advanceTimersByTimeAsync(1);
      await settle();
      expect(lowPc.restartOffers).toBe(1);
      expect(lowPc.lastOfferWasRestart).toBe(true);
      expect(offers(lowId)).toBe(before + 1);
      expect(low.mediaConnectionStatus(highId)).toBe("interrupted");
      expect(low.state).toBe("joined");

      lowPc.setConnectionState("connected");
      await settle();
      expect(statuses(lowEvents, highId)).toEqual(["connecting", "connected", "interrupted", "connected"]);
      expect(h.realtime.sockets).toHaveLength(sockets);
      expect(h.network.connections).toHaveLength(2);
      expect(h.realtime.peerReports.filter((r) => r.type === "webrtc.failed")).toEqual([]);
    });

    it("does not restart when the connection heals within the hold", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
      const { lowPc } = await pair();
      lowPc.setConnectionState("disconnected");
      await vi.advanceTimersByTimeAsync(2_000);
      lowPc.setConnectionState("connected");
      await vi.advanceTimersByTimeAsync(10_000);
      await settle();
      expect(lowPc.restartOffers).toBe(0);
    });

    it("leaves the restart to the offerer when the answerer is interrupted", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
      const { low, lowId, highId, lowPc } = await pair();
      const highPc = h.network.connections.find((pc) => pc !== lowPc);
      if (!highPc) throw new Error("no answerer connection");
      const before = offers(lowId);
      highPc.setConnectionState("disconnected");
      await vi.advanceTimersByTimeAsync(30_000);
      expect(highPc.restartOffers).toBe(0);
      expect(offers(lowId)).toBe(before);
      expect(low.mediaConnectionStatus(highId)).toBe("connected");
    });

    it("restarts an interrupted connection at once on a network change, and only once", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
      const { lowId, lowPc } = await pair();
      const before = offers(lowId);
      lowPc.setConnectionState("disconnected");
      await vi.advanceTimersByTimeAsync(500);
      expect(lowPc.restartOffers).toBe(0);

      h.signalNetworkChange();
      await settle();
      expect(lowPc.restartOffers).toBe(1);
      expect(offers(lowId)).toBe(before + 1);

      lowPc.setConnectionState("connected");
      await settle();
      await vi.advanceTimersByTimeAsync(10_000);
      await settle();
      expect(lowPc.restartOffers).toBe(1);
    });

    it("reschedules interruption recovery after a busy restart finishes while still interrupted", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
      const { low, highId, lowPc } = await pair();
      lowPc.setConnectionState("disconnected");
      await settle();
      expect(low.mediaConnectionStatus(highId)).toBe("interrupted");

      // Start a restart immediately; when it finishes while still interrupted, recovery must be re-armed.
      h.signalNetworkChange();
      await settle();
      expect(lowPc.restartOffers).toBe(1);
      expect(low.mediaConnectionStatus(highId)).toBe("interrupted");

      await vi.advanceTimersByTimeAsync(2_999);
      expect(lowPc.restartOffers).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      await settle();
      expect(lowPc.restartOffers).toBe(2);
      expect(lowPc.lastOfferWasRestart).toBe(true);
    });

    it("ignores a network change while the connection is healthy", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
      const { lowPc } = await pair();
      h.signalNetworkChange();
      await vi.advanceTimersByTimeAsync(10_000);
      await settle();
      expect(lowPc.restartOffers).toBe(0);
    });

    it("stops listening for network changes once the engine is disposed", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
      const { low, lowPc } = await pair();
      lowPc.setConnectionState("disconnected");
      low.dispose();
      h.signalNetworkChange();
      await settle();
      expect(lowPc.restartOffers).toBe(0);
    });

    it("logs the trigger and outcome of each recovery without negotiation content", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
      const { entries, logger } = recordingLogger();
      const { low, high } = await (async () => {
        const { low: lowId, high: highId } = orderedIds();
        const lowEngine = h.createEngine({ participantId: lowId, logger });
        const highEngine = h.createEngine({ participantId: highId });
        await lowEngine.join();
        await highEngine.join();
        await settle();
        return { low: lowEngine, high: highEngine };
      })();
      expect(low.state).toBe("joined");
      expect(high.state).toBe("joined");
      const lowPc = h.network.connections[0];
      if (!lowPc) throw new Error("no connection");

      lowPc.setConnectionState("disconnected");
      await vi.advanceTimersByTimeAsync(3_000);
      await settle();
      lowPc.setConnectionState("connected");
      await settle();
      lowPc.setConnectionState("disconnected");
      h.signalNetworkChange();
      await settle();
      lowPc.setConnectionState("connected");
      await settle();

      const lifecycle = entries.filter((e) => e.message.startsWith("reconnect "));
      expect(lifecycle.map((e) => [e.message, e.fields?.trigger])).toEqual([
        ["reconnect attempt started", "media"],
        ["reconnect succeeded", "media"],
        ["reconnect attempt started", "network"],
        ["reconnect succeeded", "network"],
      ]);
      for (const entry of lifecycle) expect(entry.fields?.attempt).toBe(1);
      expect(typeof lifecycle[1]?.fields?.elapsedMs).toBe("number");
      const text = JSON.stringify(lifecycle);
      expect(text).not.toMatch(/sdp|candidate|token/i);
    });
  });
});
