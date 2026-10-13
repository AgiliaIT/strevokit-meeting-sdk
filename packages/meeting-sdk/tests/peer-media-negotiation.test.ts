import type { IceCandidate } from "@strevokit/signaling-protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MeetingEngine } from "../src/public/types.js";
import type { FakeTrack } from "./support/fakeMediaDevices.js";
import { type EngineHarness, createP2PHarness, eventsOfType, recordEvents } from "./support/harness.js";
import { joinedPair, orderedIds, sentPeerFrames, settle } from "./support/p2p.js";

const ICE_SERVERS = [
  { urls: ["stun:stun.example.com:3478"] },
  { urls: ["turn:turn.example.com:3478?transport=udp"], username: "user", credential: "secret" },
];

describe("peer media › negotiation", () => {
  let h: EngineHarness;

  beforeEach(() => {
    h = createP2PHarness({ iceServers: ICE_SERVERS });
  });

  afterEach(() => {
    expect(h.realtime.handlerErrors).toEqual([]);
    h.cleanup();
  });

  it("only the lower-ID participant offers, and the other answers", async () => {
    const { lowId, highId } = await joinedPair(h);
    const lowFrames = sentPeerFrames(h, lowId).map((f) => f.type);
    const highFrames = sentPeerFrames(h, highId).map((f) => f.type);
    expect(lowFrames.filter((t) => t === "webrtc.offer")).toHaveLength(1);
    expect(lowFrames).not.toContain("webrtc.answer");
    expect(highFrames.filter((t) => t === "webrtc.answer")).toHaveLength(1);
    expect(highFrames).not.toContain("webrtc.offer");
    const offer = sentPeerFrames(h, lowId).find((f) => f.type === "webrtc.offer");
    expect(offer?.payload.targetParticipantId).toBe(highId);
  });

  it("creates one connection per side with two send-and-receive transceivers, audio then video", async () => {
    await joinedPair(h);
    const open = h.network.open();
    expect(open).toHaveLength(2);
    for (const pc of open) {
      expect(pc.transceivers.map((t) => [t.kind, t.direction])).toEqual([
        ["audio", "sendrecv"],
        ["video", "sendrecv"],
      ]);
    }
  });

  it("passes the welcome's server list to the connection unchanged", async () => {
    await joinedPair(h);
    for (const pc of h.network.connections) expect(pc.configuration).toEqual({ iceServers: ICE_SERVERS });
  });

  it("delivers each side's camera and microphone to the other once connected", async () => {
    const { low: lowId, high: highId } = orderedIds();
    const low = h.createEngine({ participantId: lowId });
    const high = h.createEngine({ participantId: highId });
    const lowEvents = recordEvents(low, { media: true });
    const highEvents = recordEvents(high, { media: true });
    await low.join();
    await high.join();
    await Promise.all([low.enableCamera(), low.unmute(), high.enableCamera(), high.unmute()]);
    await settle();

    for (const [engine, otherId] of [
      [low, highId],
      [high, lowId],
    ] as const) {
      const remote = engine.remoteMedia(otherId);
      expect(remote.camera).not.toBeNull();
      expect(remote.microphone).not.toBeNull();
      expect(remote.screen).toBeNull();
    }

    for (const [events, otherId] of [
      [lowEvents, highId],
      [highEvents, lowId],
    ] as const) {
      const changes = eventsOfType(events, "remote_media_changed").filter((e) => e.participantId === otherId);
      expect(changes.filter((e) => e.kind === "camera")).toHaveLength(1);
      expect(changes.filter((e) => e.kind === "microphone")).toHaveLength(1);
      expect(changes.every((e) => e.stream !== null)).toBe(true);
    }
  });

  it("carries the sender's tracks to the other side's received streams", async () => {
    const { low, high, lowId, highId } = await joinedPair(h);
    const lowCamera = low.localMedia.camera?.getVideoTracks()[0] as unknown as FakeTrack;
    const highMic = high.localMedia.microphone?.getAudioTracks()[0] as unknown as FakeTrack;
    const atHigh = high.remoteMedia(lowId).camera?.getVideoTracks()[0] as unknown as { source: FakeTrack | null };
    const atLow = low.remoteMedia(highId).microphone?.getAudioTracks()[0] as unknown as { source: FakeTrack | null };
    expect(atHigh.source).toBe(lowCamera);
    expect(atLow.source).toBe(highMic);
  });

  it("keeps the same stream object for a participant and kind while the connection lasts", async () => {
    const { low, high, highId } = await joinedPair(h);
    const first = low.remoteMedia(highId).camera;
    await high.disableCamera();
    await settle();
    expect(low.remoteMedia(highId).camera).toBeNull();
    await high.enableCamera();
    await settle();
    expect(low.remoteMedia(highId).camera).toBe(first);
  });
});

const SCRIPTED_OFFER = "v=0\r\no=fake-session scripted\r\nm=audio\r\na=sendrecv\r\nm=video\r\na=sendrecv\r\n";

function scriptedCandidate(n: number): IceCandidate {
  return { candidate: `candidate:${n} 1 udp 2122260223 198.51.100.${n % 250} 5${n % 10}000 typ host`, sdpMid: "0", sdpMLineIndex: 0 };
}

describe("peer media › ordering and stale frames", () => {
  let h: EngineHarness;

  beforeEach(() => {
    h = createP2PHarness();
  });

  afterEach(() => {
    vi.useRealTimers();
    expect(h.realtime.handlerErrors).toEqual([]);
    h.cleanup();
  });

  /** A scripted participant with the lower ID is present; the engine under test answers. */
  async function answererWithScriptedPeer(options: { present?: boolean } = {}) {
    const { low: scriptedId, high: selfId } = orderedIds();
    if (options.present ?? true) h.realtime.addPresent({ participantId: scriptedId });
    const engine = h.createEngine({ participantId: selfId });
    const events = recordEvents(engine, { media: true });
    await engine.join();
    await settle();
    const fromScripted = {
      offer: () => h.realtime.sendMessage("webrtc.offer", { targetParticipantId: selfId, sdp: SCRIPTED_OFFER }, scriptedId, selfId),
      answer: () => h.realtime.sendMessage("webrtc.answer", { targetParticipantId: selfId, sdp: SCRIPTED_OFFER }, scriptedId, selfId),
      candidate: (n: number) =>
        h.realtime.sendMessage("webrtc.ice_candidate", { targetParticipantId: selfId, candidate: scriptedCandidate(n) }, scriptedId, selfId),
    };
    return { engine, events, scriptedId, selfId, fromScripted };
  }

  function errorCodes(engine: MeetingEngine, events: ReturnType<typeof recordEvents>): string[] {
    expect(engine.state).toBe("joined");
    return eventsOfType(events, "error").map((e) => e.error.code);
  }

  it("applies candidates that arrive before the offer once the offer is applied, in order", async () => {
    const { fromScripted, selfId } = await answererWithScriptedPeer();
    for (let n = 1; n <= 3; n++) fromScripted.candidate(n);
    fromScripted.offer();
    await settle();
    const [pc] = h.network.connections;
    expect(pc?.addedCandidates.map((c) => c.candidate)).toEqual([1, 2, 3].map((n) => scriptedCandidate(n).candidate));
    expect(sentPeerFrames(h, selfId).map((f) => f.type)).toContain("webrtc.answer");
  });

  it("keeps at most 64 early candidates and drops the rest", async () => {
    const { fromScripted } = await answererWithScriptedPeer();
    for (let n = 1; n <= 70; n++) fromScripted.candidate(n);
    fromScripted.offer();
    await settle();
    expect(h.network.connections[0]?.addedCandidates).toHaveLength(64);
  });

  it("holds candidates and an offer from a participant not yet seen, and uses them when they appear", async () => {
    const { fromScripted, scriptedId, selfId, engine, events } = await answererWithScriptedPeer({ present: false });
    fromScripted.candidate(1);
    fromScripted.offer();
    await settle();
    expect(h.network.connections).toHaveLength(0);
    h.realtime.virtualJoin({ participantId: scriptedId });
    await settle();
    const [pc] = h.network.connections;
    expect(pc?.addedCandidates.map((c) => c.candidate)).toEqual([scriptedCandidate(1).candidate]);
    const answer = sentPeerFrames(h, selfId).find((f) => f.type === "webrtc.answer");
    expect(answer?.payload.targetParticipantId).toBe(scriptedId);
    expect(errorCodes(engine, events)).toEqual([]);
  });

  it("drops a held offer and candidates after 5 s", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { fromScripted, scriptedId, selfId } = await answererWithScriptedPeer({ present: false });
    fromScripted.candidate(1);
    fromScripted.offer();
    await settle();
    vi.advanceTimersByTime(5000);
    h.realtime.virtualJoin({ participantId: scriptedId });
    await settle();
    expect(h.network.connections).toHaveLength(0);
    expect(sentPeerFrames(h, selfId)).toEqual([]);
  });

  it("ignores an answer while no offer is outstanding without an error", async () => {
    const { fromScripted, engine, events, selfId } = await answererWithScriptedPeer();
    fromScripted.answer();
    await settle();
    expect(h.network.connections).toHaveLength(0);
    fromScripted.offer();
    await settle();
    fromScripted.answer();
    await settle();
    expect(h.network.connections).toHaveLength(1);
    expect(sentPeerFrames(h, selfId).filter((f) => f.type === "webrtc.answer")).toHaveLength(1);
    expect(errorCodes(engine, events)).toEqual([]);
    expect(engine.mediaConnectionStatus(h.realtime.presentIds()[0] ?? "")).toBe("connecting");
  });

  it("answers a later offer once negotiation is stable, keeping the transceivers and received streams", async () => {
    const { fromScripted, engine, events, selfId, scriptedId } = await answererWithScriptedPeer();
    fromScripted.offer();
    await settle();
    const [pc] = h.network.connections;
    const transceivers = pc?.getTransceivers();
    const tracks = transceivers?.map((t) => t.receiver.track);
    expect(pc?.signalingState).toBe("stable");
    fromScripted.offer();
    await settle();
    expect(h.network.connections).toHaveLength(1);
    expect(sentPeerFrames(h, selfId).filter((f) => f.type === "webrtc.answer")).toHaveLength(2);
    expect(pc?.getTransceivers()).toEqual(transceivers);
    expect(pc?.getTransceivers().map((t) => t.receiver.track)).toEqual(tracks);
    expect(pc?.closed).toBe(false);
    expect(errorCodes(engine, events)).toEqual([]);
    expect(engine.mediaConnectionStatus(scriptedId)).toBe("connecting");
  });

  for (const state of ["have-remote-offer", "have-local-offer"]) {
    it(`ignores a later offer while the connection is in ${state}`, async () => {
      const calls: { message: string; fields?: unknown }[] = [];
      const { low: scriptedId, high: selfId } = orderedIds();
      h.realtime.addPresent({ participantId: scriptedId });
      const engine = h.createEngine({
        participantId: selfId,
        logger: { debug: (message, fields) => calls.push({ message, fields }) },
      });
      const events = recordEvents(engine, { media: true });
      await engine.join();
      await settle();
      const offer = () => h.realtime.sendMessage("webrtc.offer", { targetParticipantId: selfId, sdp: SCRIPTED_OFFER }, scriptedId, selfId);
      offer();
      await settle();
      const [pc] = h.network.connections;
      if (!pc) throw new Error("no connection");
      pc.signalingState = state;
      offer();
      await settle();
      expect(sentPeerFrames(h, selfId).filter((f) => f.type === "webrtc.answer")).toHaveLength(1);
      expect(calls).toContainEqual({ message: "frame ignored", fields: { messageType: "webrtc.offer", reason: "busy" } });
      expect(pc.closed).toBe(false);
      expect(errorCodes(engine, events)).toEqual([]);
    });
  }

  it("ignores an offer received by the offerer", async () => {
    const { low: selfId, high: scriptedId } = orderedIds();
    h.realtime.addPresent({ participantId: scriptedId });
    const engine = h.createEngine({ participantId: selfId });
    const events = recordEvents(engine);
    await engine.join();
    await settle();
    expect(sentPeerFrames(h, selfId).filter((f) => f.type === "webrtc.offer")).toHaveLength(1);
    h.realtime.sendMessage("webrtc.offer", { targetParticipantId: selfId, sdp: SCRIPTED_OFFER }, scriptedId, selfId);
    await settle();
    expect(h.network.connections).toHaveLength(1);
    expect(h.network.connections[0]?.signalingState).toBe("have-local-offer");
    expect(sentPeerFrames(h, selfId).map((f) => f.type)).not.toContain("webrtc.answer");
    expect(errorCodes(engine, events)).toEqual([]);
  });

  it("ignores a candidate the connection rejects", async () => {
    const { fromScripted, engine, events } = await answererWithScriptedPeer();
    fromScripted.offer();
    await settle();
    h.network.failNext("addIceCandidate");
    fromScripted.candidate(1);
    fromScripted.candidate(2);
    await settle();
    expect(h.network.connections[0]?.addedCandidates.map((c) => c.candidate)).toEqual([scriptedCandidate(2).candidate]);
    expect(errorCodes(engine, events)).toEqual([]);
    expect(h.network.connections[0]?.closed).toBe(false);
  });

  it("ignores frames from a participant it is not paired with", async () => {
    const { low, lowId, highId } = await joinedPair(h);
    const thirdId = `01JQZ${"Z".repeat(21)}`;
    h.realtime.virtualJoin({ participantId: thirdId });
    await settle();
    const before = h.network.connections.length;
    h.realtime.sendMessage("webrtc.offer", { targetParticipantId: lowId, sdp: SCRIPTED_OFFER }, thirdId, lowId);
    h.realtime.sendMessage(
      "webrtc.ice_candidate",
      { targetParticipantId: lowId, candidate: scriptedCandidate(9) },
      thirdId,
      lowId,
    );
    await settle();
    expect(h.network.connections).toHaveLength(before);
    expect(low.mediaConnectionStatus(highId)).toBe("connected");
    expect(low.mediaConnectionStatus(thirdId)).toBeNull();
  });

  it("produces exactly one connection when both participants appear at the same time", async () => {
    const { low: lowId, high: highId } = orderedIds();
    const low = h.createEngine({ participantId: lowId });
    const high = h.createEngine({ participantId: highId });
    await Promise.all([low.join(), high.join()]);
    await settle();
    expect(h.network.connections).toHaveLength(2);
    expect(h.network.open()).toHaveLength(2);
    expect(low.mediaConnectionStatus(highId)).toBe("connected");
    expect(high.mediaConnectionStatus(lowId)).toBe("connected");
    expect(sentPeerFrames(h, lowId).filter((f) => f.type === "webrtc.offer")).toHaveLength(1);
    expect(sentPeerFrames(h, highId).filter((f) => f.type === "webrtc.offer")).toHaveLength(0);
  });
});
