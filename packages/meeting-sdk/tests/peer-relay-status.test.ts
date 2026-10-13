import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FakePeerConnection } from "./support/fakePeerConnection.js";
import { type EngineHarness, type RecordedEvent, createP2PHarness, eventsOfType, recordEvents } from "./support/harness.js";
import { orderedIds, settle } from "./support/p2p.js";
import { connectionsOf, iso, pushRefresh, relayServers } from "./support/relay.js";

const NOW = Date.UTC(2026, 9, 6, 12);
const LATER = NOW + 600_000;

describe("peer media › status during a planned switch", () => {
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

  type Switching = { lowId: string; highId: string; lowPc: FakePeerConnection; events: RecordedEvent[]; mark: number };

  /** A relayed pair where the offerer has started a switch; `mark` is the event count when it started. */
  async function switching(options: { completes: boolean }): Promise<Switching> {
    const { low: lowId, high: highId } = orderedIds();
    const low = h.createEngine({ participantId: lowId });
    const high = h.createEngine({ participantId: highId });
    const events = recordEvents(low, { media: true });
    await low.join();
    await high.join();
    await Promise.all([low.enableCamera(), high.enableCamera()]);
    await settle();
    const { lowPc } = connectionsOf(h);
    if (!options.completes) lowPc.restartBehaviour = "never";
    const mark = events.length;
    pushRefresh(h, [lowId], LATER);
    await settle();
    expect(lowPc.restartOffers).toBe(1);
    return { lowId, highId, lowPc, events, mark };
  }

  const mediaEventsSince = (events: RecordedEvent[], mark: number) =>
    events.slice(mark).filter((e) => e.type === "media_connection_changed" || e.type === "remote_media_changed");

  const reportsFrom = (participantId: string) =>
    h.realtime.peerReports.filter((r) => r.from === participantId).map((r) => r.type);

  it("a drop that recovers within 5 s emits nothing", async () => {
    const { lowId, lowPc, events, mark } = await switching({ completes: false });
    lowPc.setConnectionState("disconnected");
    await advance(4_000);
    lowPc.setConnectionState("connected");
    await advance(5_000);
    expect(mediaEventsSince(events, mark)).toEqual([]);
    expect(reportsFrom(lowId)).toEqual(["webrtc.connected"]);
  });

  it("a drop lasting more than 5 s is reported as an interruption", async () => {
    const { lowId, highId, lowPc, events, mark } = await switching({ completes: false });
    lowPc.setConnectionState("disconnected");
    await advance(4_999);
    expect(mediaEventsSince(events, mark)).toEqual([]);
    await advance(1);
    expect(eventsOfType(events.slice(mark), "media_connection_changed")).toEqual([{ participantId: highId, status: "interrupted" }]);
    expect(reportsFrom(lowId)).toEqual(["webrtc.connected", "webrtc.disconnected"]);
  });

  it("a failure during a switch is reported at once", async () => {
    const { lowId, highId, lowPc, events, mark } = await switching({ completes: false });
    lowPc.setConnectionState("failed");
    await settle();
    expect(eventsOfType(events.slice(mark), "media_connection_changed")).toEqual([{ participantId: highId, status: "failed" }]);
    expect(reportsFrom(lowId)).toEqual(["webrtc.connected", "webrtc.failed"]);
  });

  it("the public status stays connected across a completed switch", async () => {
    const { lowId, highId, events, mark } = await switching({ completes: true });
    await advance(1_000);
    expect(h.realtime.restartResults).toEqual([{ from: lowId, peerParticipantId: highId, outcome: "completed" }]);
    expect(mediaEventsSince(events, mark)).toEqual([]);
    expect(eventsOfType(events, "media_connection_changed").map((e) => e.status)).toEqual(["connecting", "connected"]);
  });
});
