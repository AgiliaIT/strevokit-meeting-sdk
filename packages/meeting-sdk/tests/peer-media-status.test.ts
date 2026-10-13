import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { MeetingEngine } from "../src/public/types.js";
import type { FakePeerConnection } from "./support/fakePeerConnection.js";
import { type EngineHarness, type RecordedEvent, createP2PHarness, eventsOfType, recordEvents } from "./support/harness.js";
import { orderedIds, settle } from "./support/p2p.js";

describe("peer media › connection status", () => {
  let h: EngineHarness;

  beforeEach(() => {
    h = createP2PHarness();
  });

  afterEach(() => {
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
});
