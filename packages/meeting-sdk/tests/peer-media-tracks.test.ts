import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { MeetingEngine } from "../src/public/types.js";
import type { FakeTrack } from "./support/fakeMediaDevices.js";
import type { FakePeerConnection } from "./support/fakePeerConnection.js";
import { type EngineHarness, createP2PHarness, createPhase1Harness, eventsOfType, recordEvents } from "./support/harness.js";
import { joinedPair, sentPeerFrames, settle } from "./support/p2p.js";

function cameraTrack(engine: MeetingEngine): FakeTrack {
  return engine.localMedia.camera?.getVideoTracks()[0] as unknown as FakeTrack;
}

function microphoneTrack(engine: MeetingEngine): FakeTrack {
  return engine.localMedia.microphone?.getAudioTracks()[0] as unknown as FakeTrack;
}

/** The offerer creates its connection first, so in a fresh pair it is connection 0. */
function connections(h: EngineHarness): { lowPc: FakePeerConnection; highPc: FakePeerConnection } {
  const [lowPc, highPc] = h.network.connections;
  if (!lowPc || !highPc) throw new Error("pair not negotiated");
  return { lowPc, highPc };
}

const audioSender = (pc: FakePeerConnection) => pc.transceivers[0]!.sender;
const videoSender = (pc: FakePeerConnection) => pc.transceivers[1]!.sender;

describe("peer media › local tracks", () => {
  let h: EngineHarness;

  beforeEach(() => {
    h = createP2PHarness();
  });

  afterEach(() => {
    expect(h.realtime.handlerErrors).toEqual([]);
    h.cleanup();
  });

  it("swaps the camera track in and out without renegotiating", async () => {
    const { low, lowId } = await joinedPair(h, { devices: false });
    const { lowPc } = connections(h);
    await low.enableCamera();
    const track = cameraTrack(low);
    await low.disableCamera();
    await settle();
    expect(videoSender(lowPc).replaceCalls).toEqual([track, null]);
    expect(sentPeerFrames(h, lowId).filter((f) => f.type === "webrtc.offer")).toHaveLength(1);
  });

  it("attaches the microphone once; mute and unmute only toggle the track", async () => {
    const { low } = await joinedPair(h, { devices: false });
    const { lowPc } = connections(h);
    await low.unmute();
    const track = microphoneTrack(low);
    await low.mute();
    expect(track.enabled).toBe(false);
    await low.unmute();
    expect(track.enabled).toBe(true);
    await low.mute();
    await settle();
    expect(audioSender(lowPc).replaceCalls).toEqual([track]);
    expect(audioSender(lowPc).track).toBe(track);
  });

  it("hands a switched camera or microphone to the connection without renegotiating", async () => {
    const { low, high, lowId } = await joinedPair(h, { devices: false });
    const { lowPc } = connections(h);
    await low.enableCamera({ deviceId: "camera-1" });
    await low.unmute({ deviceId: "mic-1" });
    const firstCamera = cameraTrack(low);
    const firstMicrophone = microphoneTrack(low);
    await low.enableCamera({ deviceId: "camera-2" });
    await low.unmute({ deviceId: "mic-2" });
    await settle();
    const camera = cameraTrack(low);
    const microphone = microphoneTrack(low);
    expect(camera.deviceId).toBe("camera-2");
    expect(microphone.deviceId).toBe("mic-2");
    expect(videoSender(lowPc).replaceCalls).toEqual([firstCamera, camera]);
    expect(audioSender(lowPc).replaceCalls).toEqual([firstMicrophone, microphone]);
    expect(firstCamera.readyState).toBe("ended");
    expect(firstMicrophone.readyState).toBe("ended");
    expect(sentPeerFrames(h, lowId).filter((f) => f.type === "webrtc.offer")).toHaveLength(1);
    const received = high.remoteMedia(lowId).camera?.getVideoTracks()[0] as unknown as { source: FakeTrack | null };
    expect(received.source).toBe(camera);
    expect(high.participants.find((p) => p.id === lowId)?.media.camera).toBe(true);
  });

  it("ignores screen sharing", async () => {
    const { low } = await joinedPair(h, { devices: false, lowRole: "host" });
    const { lowPc } = connections(h);
    await low.startScreenShare();
    await low.stopScreenShare();
    await settle();
    for (const sender of [audioSender(lowPc), videoSender(lowPc)]) expect(sender.replaceCalls).toEqual([]);
  });

  it("never sends a second offer across any toggle sequence", async () => {
    const { low, high, lowId, highId } = await joinedPair(h);
    for (const engine of [low, high]) {
      await engine.mute();
      await engine.disableCamera();
      await engine.unmute();
      await engine.enableCamera();
      await engine.disableCamera();
    }
    await settle();
    expect(sentPeerFrames(h, lowId).filter((f) => f.type === "webrtc.offer")).toHaveLength(1);
    expect(sentPeerFrames(h, highId).filter((f) => f.type === "webrtc.offer")).toHaveLength(0);
    expect(low.mediaConnectionStatus(highId)).toBe("connected");
  });

  it("delivers a device turned on after connecting once the other side announces it", async () => {
    const { low, high, highId } = await joinedPair(h, { devices: false });
    expect(low.mediaConnectionStatus(highId)).toBe("connected");
    expect(low.remoteMedia(highId).camera).toBeNull();
    const events = recordEvents(low, { media: true });
    await high.enableCamera();
    await settle();
    const camera = low.remoteMedia(highId).camera;
    expect(camera).not.toBeNull();
    const received = camera?.getVideoTracks()[0] as unknown as { source: FakeTrack | null };
    expect(received.source).toBe(cameraTrack(high));
    expect(eventsOfType(events, "remote_media_changed")).toEqual([{ participantId: highId, kind: "camera", stream: camera }]);
    expect(eventsOfType(events, "media_connection_changed")).toEqual([]);
  });

  it("connects with no local device on either side", async () => {
    const { low, high, lowId, highId } = await joinedPair(h, { devices: false });
    expect(h.network.open()).toHaveLength(2);
    expect(low.mediaConnectionStatus(highId)).toBe("connected");
    expect(high.mediaConnectionStatus(lowId)).toBe("connected");
    expect(h.media.calls.getUserMedia).toBe(0);
  });

  it("a camera that ends unexpectedly stops being sent and is reported off", async () => {
    const { low, high, lowId } = await joinedPair(h);
    const { lowPc } = connections(h);
    const track = cameraTrack(low);
    track.endFromBrowser();
    await settle();
    expect(low.localMediaState.camera).toBe(false);
    expect(videoSender(lowPc).track).toBeNull();
    expect(high.remoteMedia(lowId).camera).toBeNull();
    expect(high.participants.find((p) => p.id === lowId)?.media.camera).toBe(false);
  });

  it("a microphone that ends unexpectedly turns off, is announced, and is captured again on unmute", async () => {
    const { low, high, lowId } = await joinedPair(h);
    const { lowPc } = connections(h);
    microphoneTrack(low).endFromBrowser();
    await settle();
    expect(low.localMediaState.microphone).toBe(false);
    expect(high.participants.find((p) => p.id === lowId)?.media.microphone).toBe(false);
    expect(high.remoteMedia(lowId).microphone).toBeNull();

    const capturesBefore = h.media.calls.getUserMedia;
    await low.unmute();
    await settle();
    expect(h.media.calls.getUserMedia).toBe(capturesBefore + 1);
    expect(audioSender(lowPc).track).toBe(microphoneTrack(low));
    expect(high.remoteMedia(lowId).microphone).not.toBeNull();
  });

  it("a microphone that ends while muted is captured again on the next unmute", async () => {
    const { low } = await joinedPair(h);
    const events = recordEvents(low);
    const track = microphoneTrack(low);
    await low.mute();
    track.endFromBrowser();
    await settle();
    expect(eventsOfType(events, "local_media_changed")).toEqual([{ kind: "microphone", enabled: false, stream: null }]);

    const capturesBefore = h.media.calls.getUserMedia;
    await low.unmute();
    expect(h.media.calls.getUserMedia).toBe(capturesBefore + 1);
    expect(microphoneTrack(low)).not.toBe(track);
  });
});

describe("peer media › receive-only participant", () => {
  let h: EngineHarness;

  beforeEach(() => {
    h = createP2PHarness();
  });

  afterEach(() => {
    expect(h.realtime.handlerErrors).toEqual([]);
    h.cleanup();
  });

  it("still connects and renders the other side's media", async () => {
    const { low, high, lowId, highId } = await joinedPair(h, { devices: false });
    await Promise.all([low.enableCamera(), low.unmute()]);
    await settle();
    expect(high.mediaConnectionStatus(lowId)).toBe("connected");
    expect(high.remoteMedia(lowId).camera).not.toBeNull();
    expect(high.remoteMedia(lowId).microphone).not.toBeNull();
    expect(low.remoteMedia(highId)).toEqual({ camera: null, microphone: null, screen: null });
  });
});

describe("local media › ended captures in a signaling-only meeting", () => {
  let h: EngineHarness;

  beforeEach(() => {
    h = createPhase1Harness();
  });

  afterEach(() => {
    expect(h.realtime.handlerErrors).toEqual([]);
    h.cleanup();
  });

  it("an ended camera track turns the camera off and announces it", async () => {
    const engine = h.createEngine();
    await engine.join();
    await engine.enableCamera();
    const events = recordEvents(engine);
    cameraTrack(engine).endFromBrowser();
    await settle();
    expect(engine.localMedia.camera).toBeNull();
    expect(engine.localMediaState.camera).toBe(false);
    expect(eventsOfType(events, "local_media_changed")).toEqual([{ kind: "camera", enabled: false, stream: null }]);
    expect(h.realtime.socketFor().sentTypes()).toContain("media.camera.stopped");
  });
});
