import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MeetingEngine } from "../src/public/types.js";
import type { FakePeerConnection } from "./support/fakePeerConnection.js";
import { type EngineHarness, type RecordedEvent, createP2PHarness, eventsOfType, recordEvents } from "./support/harness.js";
import { orderedIds, sentPeerFrames, settle } from "./support/p2p.js";

const NO_REMOTE_MEDIA = { camera: null, microphone: null, screen: null };

describe("peer media › failures and recovery", () => {
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
    highEvents: RecordedEvent[];
    lowPc: FakePeerConnection;
  };

  async function pair(options: { devices?: boolean } = {}): Promise<Joined> {
    const { low: lowId, high: highId } = orderedIds();
    const low = h.createEngine({ participantId: lowId });
    const high = h.createEngine({ participantId: highId });
    const lowEvents = recordEvents(low, { media: true });
    const highEvents = recordEvents(high, { media: true });
    await low.join();
    await high.join();
    if (options.devices) {
      await Promise.all([low.enableCamera(), low.unmute(), high.enableCamera(), high.unmute()]);
    }
    await settle();
    const lowPc = h.network.connections.find((pc) => pc.transceivers.length > 0);
    if (!lowPc) throw new Error("no connection");
    return { low, high, lowId, highId, lowEvents, highEvents, lowPc };
  }

  const statuses = (events: RecordedEvent[], participantId: string) =>
    eventsOfType(events, "media_connection_changed")
      .filter((e) => e.participantId === participantId)
      .map((e) => e.status);

  const errorCodes = (events: RecordedEvent[]) => eventsOfType(events, "error").map((e) => e.error.code);

  const failures = () =>
    h.realtime.peerReports.filter((r) => r.type === "webrtc.failed").map((r) => [r.from, r.peerParticipantId, r.reason]);

  const offersFrom = (participantId: string) => sentPeerFrames(h, participantId).filter((f) => f.type === "webrtc.offer").length;

  it("fails with connection_timeout when no connection is made in time, and stays joined", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    h.network.autoConnect = false;
    const { low, high, lowId, highId, lowEvents, lowPc } = await pair();
    await vi.advanceTimersByTimeAsync(29_999);
    expect(low.mediaConnectionStatus(highId)).toBe("connecting");
    expect(failures()).toEqual([]);

    await vi.advanceTimersByTimeAsync(1);
    await settle();
    expect(statuses(lowEvents, highId)).toEqual(["connecting", "failed"]);
    expect(failures()).toEqual(
      expect.arrayContaining([
        [lowId, highId, "connection_timeout"],
        [highId, lowId, "connection_timeout"],
      ]),
    );
    expect(errorCodes(lowEvents)).toEqual(["media_connection_failed"]);
    expect(lowPc.closed).toBe(true);
    expect(low.remoteMedia(highId)).toEqual(NO_REMOTE_MEDIA);
    expect(low.state).toBe("joined");
    expect(high.state).toBe("joined");
    expect(low.participants.map((p) => p.id)).toEqual([highId]);
  });

  it("a connection that fails after connecting reports connection_failed", async () => {
    const { low, lowId, highId, lowEvents, lowPc } = await pair({ devices: true });
    expect(low.remoteMedia(highId).camera).not.toBeNull();
    lowPc.setConnectionState("failed");
    await settle();
    expect(failures()).toContainEqual([lowId, highId, "connection_failed"]);
    expect(low.mediaConnectionStatus(highId)).toBe("failed");
    expect(low.remoteMedia(highId)).toEqual(NO_REMOTE_MEDIA);
    expect(eventsOfType(lowEvents, "remote_media_changed").filter((e) => e.stream === null).map((e) => e.kind).sort()).toEqual([
      "camera",
      "microphone",
    ]);
    expect(errorCodes(lowEvents)).toEqual(["media_connection_failed"]);
    expect(low.state).toBe("joined");
  });

  it("a rejected createOffer reports negotiation_failed from the offerer", async () => {
    h.network.failNext("createOffer");
    const { low, lowId, highId, lowEvents } = await pair();
    expect(failures()).toEqual([[lowId, highId, "negotiation_failed"]]);
    expect(low.mediaConnectionStatus(highId)).toBe("failed");
    expect(errorCodes(lowEvents)).toEqual(["media_connection_failed"]);
  });

  it("a rejected setRemoteDescription reports negotiation_failed from the side applying it", async () => {
    h.network.failNext("setRemoteDescription");
    const { high, lowId, highId, highEvents } = await pair();
    expect(failures()).toContainEqual([highId, lowId, "negotiation_failed"]);
    expect(high.mediaConnectionStatus(lowId)).toBe("failed");
    expect(errorCodes(highEvents)).toEqual(["media_connection_failed"]);
  });

  it("does not retry after a failure", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { low, lowId, highId, lowPc } = await pair();
    lowPc.setConnectionState("failed");
    await settle();
    const connections = h.network.connections.length;
    const offers = offersFrom(lowId);
    await vi.advanceTimersByTimeAsync(120_000);
    await settle();
    expect(h.network.connections).toHaveLength(connections);
    expect(offersFrom(lowId)).toBe(offers);
    expect(low.mediaConnectionStatus(highId)).toBe("failed");
  });

  it("never exposes raw exception text in events or errors", async () => {
    h.network.failNext("createOffer");
    const { lowEvents, highEvents } = await pair();
    const text = JSON.stringify(
      [...lowEvents, ...highEvents].map((entry) =>
        entry.type === "error" ? { code: entry.event.error.code, message: entry.event.error.message, cause: String(entry.event.error.cause) } : entry,
      ),
    );
    expect(text).not.toContain("fake createOffer failure");
    expect(text).not.toContain("OperationError");
    for (const error of eventsOfType(lowEvents, "error").map((e) => e.error)) expect(error.cause).toBeUndefined();
  });

  it("a reconnecting peer gets a fresh connection without a failure report, and media flows again", async () => {
    const { low, high, lowId, highId, lowEvents, lowPc } = await pair({ devices: true });
    const offersBefore = offersFrom(lowId);

    const replacement = h.createEngine({ participantId: highId });
    await replacement.join();
    await Promise.all([replacement.enableCamera(), replacement.unmute()]);
    await settle();

    expect(high.state).toBe("closed");
    expect(lowPc.closed).toBe(true);
    expect(failures()).toEqual([]);
    expect(offersFrom(lowId)).toBe(offersBefore + 1);
    expect(statuses(lowEvents, highId)).toEqual(["connecting", "connected", null, "connecting", "connected"]);
    const camera = low.remoteMedia(highId).camera;
    expect(camera).not.toBeNull();
    expect(camera?.getVideoTracks()[0]).toBeDefined();
    expect(replacement.remoteMedia(lowId).microphone).not.toBeNull();
    expect(h.network.open()).toHaveLength(2);
  });

  it("leave() closes the connection and clears remote media and status before closed, without a failure report", async () => {
    const { low, highId, lowEvents, lowPc } = await pair({ devices: true });
    const from = lowEvents.length;
    await low.leave();
    const after = lowEvents.slice(from).filter((e) => e.type !== "state_changed" && e.type !== "local_media_changed");
    expect(lowPc.closed).toBe(true);
    expect(after.map((e) => e.type)).toEqual(["remote_media_changed", "remote_media_changed", "media_connection_changed", "closed"]);
    expect(eventsOfType(after, "remote_media_changed").every((e) => e.participantId === highId && e.stream === null)).toBe(true);
    expect(eventsOfType(after, "media_connection_changed")).toEqual([{ participantId: highId, status: null }]);
    expect(failures()).toEqual([]);
  });

  it("the other participant leaving clears remote media, then the status, then emits participant_left", async () => {
    const { high, highId, lowEvents, lowPc } = await pair({ devices: true });
    const from = lowEvents.length;
    await high.leave();
    await settle();
    const departure = ["remote_media_changed", "media_connection_changed", "participant_left"];
    const after = lowEvents.slice(from).filter((e) => departure.includes(e.type));
    expect(lowPc.closed).toBe(true);
    expect(after.map((e) => e.type)).toEqual(["remote_media_changed", "remote_media_changed", "media_connection_changed", "participant_left"]);
    expect(eventsOfType(after, "remote_media_changed").every((e) => e.participantId === highId && e.stream === null)).toBe(true);
    expect(eventsOfType(after, "media_connection_changed")).toEqual([{ participantId: highId, status: null }]);
    expect(failures()).toEqual([]);
  });

  it("dispose() while connected closes everything silently and leaves nothing running", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { low, high, lowEvents, lowPc } = await pair({ devices: true });
    const from = lowEvents.length;
    low.dispose();
    await settle();
    expect(lowPc.closed).toBe(true);
    expect(lowEvents.slice(from)).toEqual([]);
    high.dispose();
    await settle();
    expect(h.network.open()).toHaveLength(0);
    expect(h.media.liveTracks()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(failures()).toEqual([]);
  });

  it("dispose() while still connecting clears the connection timeout", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    h.network.autoConnect = false;
    const { low, high, lowEvents, lowPc } = await pair();
    const from = lowEvents.length;
    low.dispose();
    high.dispose();
    await settle();
    expect(lowPc.closed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(lowEvents.slice(from)).toEqual([]);
    expect(failures()).toEqual([]);
    expect(h.network.open()).toHaveLength(0);
  });
});
