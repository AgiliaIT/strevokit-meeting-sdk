import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type EngineHarness, createP2PHarness } from "./support/harness.js";
import { joinedPair, sentPeerFrames, settle } from "./support/p2p.js";
import { connectionsOf, pushRefresh, relayServers } from "./support/relay.js";

const NOW = Date.UTC(2026, 9, 6, 12);

describe("peer media › platforms that do not announce credential expiry", () => {
  let h: EngineHarness;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"], now: NOW });
    h = createP2PHarness({ iceServers: relayServers(NOW + 60_000, "a") });
    h.network.defaultCandidateTypes = { local: "relay", remote: "relay" };
  });

  afterEach(() => {
    vi.useRealTimers();
    expect(h.realtime.handlerErrors).toEqual([]);
    h.cleanup();
  });

  const restartFrames = (participantId: string) =>
    sentPeerFrames(h, participantId).filter((f) => f.type === "webrtc.ice_restart" || f.type === "webrtc.ice_restart_result");

  it("the answerer never asks for a restart and no results are sent", async () => {
    const { lowId, highId } = await joinedPair(h);
    const { lowPc } = connectionsOf(h);
    pushRefresh(h, [highId], NOW + 600_000);
    await settle();
    await vi.advanceTimersByTimeAsync(60_000);
    await settle();
    expect(restartFrames(highId)).toEqual([]);
    expect(restartFrames(lowId)).toEqual([]);
    expect(lowPc.restartOffers).toBe(0);
    expect(h.realtime.restartResults).toEqual([]);
  });

  it("the offerer still restarts on its own refresh, without reporting results", async () => {
    const { lowId, highId } = await joinedPair(h);
    const { lowPc, highPc } = connectionsOf(h);
    const before = lowPc.selectedPair?.localId;
    pushRefresh(h, [lowId], NOW + 600_000);
    await settle();
    await vi.advanceTimersByTimeAsync(1_000);
    await settle();
    expect(lowPc.restartOffers).toBe(1);
    expect(highPc.restarts).toBe(1);
    expect(lowPc.selectedPair?.localId).not.toBe(before);
    expect(restartFrames(lowId)).toEqual([]);
    expect(restartFrames(highId)).toEqual([]);
    expect(h.realtime.restartResults).toEqual([]);
  });
});
