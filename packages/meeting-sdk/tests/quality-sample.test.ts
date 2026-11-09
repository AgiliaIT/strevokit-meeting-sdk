import { describe, expect, it } from "vitest";
import type { PeerConnectionLike } from "../src/internal/env.js";
import { buildQualitySample } from "../src/internal/qualitySample.js";
import { FakePeerNetwork } from "./support/fakePeerConnection.js";

function connection() {
  const network = new FakePeerNetwork();
  const pc = new network.RTCPeerConnection({ iceServers: [] });
  return { pc, like: pc as unknown as PeerConnectionLike };
}

describe("quality sample parse", () => {
  it("maps core quality fields when present and derives bitrates from byte deltas", async () => {
    const { pc, like } = connection();
    pc.setSelectedPair({ localId: "L1", localType: "host", remoteId: "R1", remoteType: "srflx" });
    pc.qualityStats = {
      currentRoundTripTime: 0.04,
      jitter: 0.002,
      packetsLost: 1,
      packetsReceived: 99,
      bytesSent: 1_000,
      bytesReceived: 2_000,
      framesDropped: 2,
      frameWidth: 640,
      frameHeight: 360,
      mimeType: "video/VP8",
    };

    const first = await buildQualitySample(like, { connectionState: "connected", nowMs: 1_000 });
    expect(first.sample.incomplete).toBe(true);
    expect(first.sample.rttMs).toBeCloseTo(40);
    expect(first.sample.jitterMs).toBeCloseTo(2);
    expect(first.sample.packetLossRatio).toBeCloseTo(0.01);
    expect(first.sample.iceLocalCandidateType).toBe("host");
    expect(first.sample.path).toBe("direct");
    expect(first.sample.codec).toBe("video/VP8");
    expect(first.sample.sendBitrateBps).toBeUndefined();

    pc.qualityStats = { ...pc.qualityStats!, bytesSent: 3_500, bytesReceived: 4_500 };
    const second = await buildQualitySample(like, {
      connectionState: "connected",
      nowMs: 2_000,
      previous: first.bytes,
    });
    expect(second.sample.incomplete).toBeUndefined();
    expect(second.sample.sendBitrateBps).toBeCloseTo(20_000);
    expect(second.sample.receiveBitrateBps).toBeCloseTo(20_000);
    expect(second.sample.sampledAt).toBe(new Date(2_000).toISOString());
  });

  it("omits codec values that would fail wire token validation", async () => {
    const { pc, like } = connection();
    pc.setSelectedPair({ localId: "L1", localType: "host", remoteId: "R1", remoteType: "srflx" });
    pc.qualityStats = {
      currentRoundTripTime: 0.04,
      jitter: 0.001,
      packetsLost: 0,
      packetsReceived: 10,
      bytesSent: 100,
      bytesReceived: 200,
      mimeType: "video/x!test",
    };

    const result = await buildQualitySample(like, { connectionState: "connected", nowMs: 1_000 });
    expect(result.sample.codec).toBeUndefined();
    expect(result.sample.rttMs).toBeCloseTo(40);
  });

  it("marks incomplete when measures are missing and never throws on getStats failure", async () => {
    const { pc, like } = connection();
    pc.setSelectedPair({ localId: "L1", localType: "relay", remoteId: "R1", remoteType: "relay" });
    const sparse = await buildQualitySample(like, { connectionState: "connecting", nowMs: 5_000 });
    expect(sparse.sample.connectionState).toBe("connecting");
    expect(sparse.sample.incomplete).toBe(true);
    expect(sparse.sample.path).toBe("relayed");

    pc.statsUnavailable = true;
    const failed = await buildQualitySample(like, { connectionState: "failed", nowMs: 6_000 });
    expect(failed.sample).toEqual({
      connectionState: "failed",
      sampledAt: new Date(6_000).toISOString(),
      incomplete: true,
    });
  });
});
