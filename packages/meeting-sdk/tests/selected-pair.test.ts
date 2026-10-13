import { describe, expect, it } from "vitest";
import type { PeerConnectionLike } from "../src/internal/env.js";
import { pathReport, selectedPair } from "../src/internal/selectedPair.js";
import { FakePeerNetwork } from "./support/fakePeerConnection.js";

function connection() {
  const network = new FakePeerNetwork();
  const pc = new network.RTCPeerConnection({ iceServers: [] });
  return { pc, like: pc as unknown as PeerConnectionLike };
}

describe("selected candidate pair", () => {
  it("reads the transport's selected pair", async () => {
    const { pc, like } = connection();
    pc.setSelectedPair({ localId: "l1", localType: "relay", remoteId: "r1", remoteType: "host" });
    expect(await selectedPair(like)).toEqual({ localId: "l1", localType: "relay", remoteType: "host" });
  });

  it("falls back to the succeeded and nominated pair without a transport report", async () => {
    const { pc, like } = connection();
    pc.statsWithoutTransport = true;
    pc.setSelectedPair({ localId: "l2", localType: "srflx", remoteId: "r2", remoteType: "relay" });
    expect(await selectedPair(like)).toEqual({ localId: "l2", localType: "srflx", remoteType: "relay" });
  });

  it("is null when no pair has been selected", async () => {
    const { pc, like } = connection();
    pc.addLocalCandidate("l3", "host");
    expect(await selectedPair(like)).toBeNull();
  });

  it("is null when stats throw", async () => {
    const { pc, like } = connection();
    pc.setSelectedPair({ localId: "l4", localType: "host", remoteId: "r4", remoteType: "host" });
    pc.statsUnavailable = true;
    expect(await selectedPair(like)).toBeNull();
  });

  it("is null when a candidate of the selected pair is missing from the stats", async () => {
    const like = {
      getStats: async () =>
        new Map([
          ["t", { id: "t", type: "transport", selectedCandidatePairId: "p" }],
          ["p", { id: "p", type: "candidate-pair", localCandidateId: "gone", remoteCandidateId: "also-gone" }],
        ]),
    } as unknown as PeerConnectionLike;
    expect(await selectedPair(like)).toBeNull();
  });

  it("reports each side separately and calls the pair relayed when either side is a relay candidate", () => {
    expect(pathReport({ localId: "a", localType: "relay", remoteType: "host" })).toEqual({
      path: "relayed",
      localPath: "relayed",
      remotePath: "direct",
    });
    expect(pathReport({ localId: "a", localType: "host", remoteType: "relay" })).toEqual({
      path: "relayed",
      localPath: "direct",
      remotePath: "relayed",
    });
    expect(pathReport({ localId: "a", localType: "relay", remoteType: "relay" })).toEqual({
      path: "relayed",
      localPath: "relayed",
      remotePath: "relayed",
    });
    expect(pathReport({ localId: "a", localType: "srflx", remoteType: "prflx" })).toEqual({
      path: "direct",
      localPath: "direct",
      remotePath: "direct",
    });
  });
});
