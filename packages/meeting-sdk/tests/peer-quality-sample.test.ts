import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QUALITY_SAMPLE_INTERVAL_MS } from "../src/internal/peerLink.js";
import type { MeetingEngine } from "../src/public/types.js";
import type { FakePeerConnection } from "./support/fakePeerConnection.js";
import { type EngineHarness, createP2PHarness } from "./support/harness.js";
import { orderedIds, settle } from "./support/p2p.js";

describe("peer media › quality sampling", () => {
  let h: EngineHarness;

  beforeEach(() => {
    h = createP2PHarness();
  });

  afterEach(() => {
    vi.useRealTimers();
    expect(h.realtime.handlerErrors).toEqual([]);
    h.cleanup();
  });

  async function pair(): Promise<{
    low: MeetingEngine;
    high: MeetingEngine;
    lowId: string;
    highId: string;
    lowPc: FakePeerConnection;
  }> {
    const { low: lowId, high: highId } = orderedIds();
    const low = h.createEngine({ participantId: lowId });
    const high = h.createEngine({ participantId: highId });
    await low.join();
    await high.join();
    await settle();
    const lowPc = h.network.connections[0];
    if (!lowPc) throw new Error("no connection");
    return { low, high, lowId, highId, lowPc };
  }

  it("emits quality samples on a seconds-scale timer while the link is alive and stops on leave", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const { low, high, lowId, highId, lowPc } = await pair();
    lowPc.setSelectedPair({ localId: "L1", localType: "host", remoteId: "R1", remoteType: "host" });
    lowPc.qualityStats = {
      currentRoundTripTime: 0.05,
      jitter: 0.001,
      packetsLost: 0,
      packetsReceived: 100,
      bytesSent: 500,
      bytesReceived: 600,
    };

    expect(h.realtime.qualitySamples).toEqual([]);
    await vi.advanceTimersByTimeAsync(QUALITY_SAMPLE_INTERVAL_MS);
    await settle();
    expect(h.realtime.qualitySamples.length).toBeGreaterThanOrEqual(1);
    const first = h.realtime.qualitySamples.find((s) => s.from === lowId);
    expect(first).toMatchObject({
      peerParticipantId: highId,
      connectionState: "connected",
    });

    const beforeLeave = h.realtime.qualitySamples.filter((s) => s.from === lowId).length;
    await high.leave();
    await settle();
    await vi.advanceTimersByTimeAsync(QUALITY_SAMPLE_INTERVAL_MS * 2);
    await settle();
    const afterLeave = h.realtime.qualitySamples.filter((s) => s.from === lowId).length;
    expect(afterLeave).toBe(beforeLeave);
    void low;
  });

  it("stays fail-open when getStats throws", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const { low, highId, lowPc } = await pair();
    lowPc.statsUnavailable = true;
    await vi.advanceTimersByTimeAsync(QUALITY_SAMPLE_INTERVAL_MS);
    await settle();
    expect(low.mediaConnectionStatus(highId)).toBe("connected");
    const sample = h.realtime.qualitySamples.at(-1);
    expect(sample?.incomplete).toBe(true);
    expect(sample?.connectionState).toBe("connected");
  });
});
