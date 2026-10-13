import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { MeetingEngine } from "../src/public/types.js";
import type { FakeTrack } from "./support/fakeMediaDevices.js";
import { flush } from "./support/fakeRealtime.js";
import { type EngineHarness, createPhase1Harness, eventsOfType, recordEvents } from "./support/harness.js";

let h: EngineHarness;

beforeEach(() => {
  h = createPhase1Harness();
});

afterEach(() => {
  expect(h.realtime.handlerErrors).toEqual([]);
  h.cleanup();
});

async function joinedHost(): Promise<MeetingEngine> {
  const engine = h.createEngine({ role: "host" });
  await engine.join();
  return engine;
}

function sentMedia(engine: MeetingEngine): string[] {
  return h.realtime
    .socketFor(engine.self?.id)
    .sentTypes()
    .filter((type) => type.startsWith("media."));
}

describe("camera", () => {
  it("captures a video track and emits local_media_changed before resolving", async () => {
    const engine = await joinedHost();
    const events = recordEvents(engine);
    let resolved = false;
    engine.on("local_media_changed", () => {
      expect(resolved).toBe(false);
    });
    await engine.enableCamera().then(() => {
      resolved = true;
    });
    const [change] = eventsOfType(events, "local_media_changed");
    expect(change?.kind).toBe("camera");
    expect(change?.enabled).toBe(true);
    expect(change?.stream).toBe(engine.localMedia.camera);
    expect(h.media.liveTracks("camera")).toBe(1);
    expect(engine.localMediaState.camera).toBe(true);
  });

  it("stops every track when disabled", async () => {
    const engine = await joinedHost();
    await engine.enableCamera();
    await engine.disableCamera();
    expect(h.media.liveTracks("camera")).toBe(0);
    expect(engine.localMedia.camera).toBeNull();
    expect(sentMedia(engine)).toEqual(["media.camera.started", "media.camera.stopped"]);
  });
});

describe("microphone", () => {
  it("captures on first unmute, keeps the device while muted, and re-enables without a new capture", async () => {
    const engine = await joinedHost();
    await engine.unmute();
    expect(h.media.calls.getUserMedia).toBe(1);
    const track = h.media.latestTrack("microphone") as FakeTrack;
    expect(track.enabled).toBe(true);

    await engine.mute();
    expect(track.readyState).toBe("live");
    expect(track.enabled).toBe(false);
    expect(engine.localMedia.microphone).toBeNull();
    expect(engine.localMediaState.microphone).toBe(false);

    await engine.unmute();
    expect(h.media.calls.getUserMedia).toBe(1);
    expect(track.enabled).toBe(true);
    expect(sentMedia(engine)).toEqual([
      "media.microphone.started",
      "media.microphone.stopped",
      "media.microphone.started",
    ]);
  });

  it("captures again when the kept microphone track has ended", async () => {
    const engine = await joinedHost();
    await engine.unmute();
    await engine.mute();
    (h.media.latestTrack("microphone") as FakeTrack).stop();
    await engine.unmute();
    expect(h.media.calls.getUserMedia).toBe(2);
    expect(h.media.liveTracks("microphone")).toBe(1);
  });
});

describe("screen", () => {
  it("captures through the screen picker and stops the tracks on stop", async () => {
    const engine = await joinedHost();
    await engine.startScreenShare();
    expect(h.media.calls.getDisplayMedia).toBe(1);
    expect(h.media.liveTracks("screen")).toBe(1);
    await engine.stopScreenShare();
    expect(h.media.liveTracks("screen")).toBe(0);
  });

  it("runs the stop path when the browser ends the share", async () => {
    const engine = await joinedHost();
    const events = recordEvents(engine);
    await engine.startScreenShare();
    h.media.simulateBrowserStop("screen");
    await flush();
    expect(engine.localMediaState.screen).toBe(false);
    expect(sentMedia(engine)).toEqual(["media.screen.started", "media.screen.stopped"]);
    expect(eventsOfType(events, "local_media_changed").map((e) => [e.kind, e.enabled])).toEqual([
      ["screen", true],
      ["screen", false],
    ]);
  });
});

describe("ordering and idempotency", () => {
  it("resolves calls for the current state with no capture or announcement", async () => {
    const engine = await joinedHost();
    await engine.disableCamera();
    await engine.mute();
    await engine.stopScreenShare();
    await engine.enableCamera();
    await engine.enableCamera();
    expect(h.media.calls.getUserMedia).toBe(1);
    expect(sentMedia(engine)).toEqual(["media.camera.started"]);
  });

  it("shares the pending promise for a call heading to the same state", async () => {
    const engine = await joinedHost();
    const release = h.media.holdNext("camera");
    const first = engine.enableCamera();
    const second = engine.enableCamera();
    expect(second).toBe(first);
    release();
    await Promise.all([first, second]);
    expect(h.media.calls.getUserMedia).toBe(1);
  });

  it("runs calls for one kind in call order", async () => {
    const engine = await joinedHost();
    const release = h.media.holdNext("camera");
    const on = engine.enableCamera();
    const off = engine.disableCamera();
    const onAgain = engine.enableCamera();
    release();
    await Promise.all([on, off, onAgain]);
    expect(sentMedia(engine)).toEqual(["media.camera.started", "media.camera.stopped", "media.camera.started"]);
    expect(engine.localMediaState.camera).toBe(true);
    expect(h.media.liveTracks("camera")).toBe(1);
  });

  it("does not block one kind on another", async () => {
    const engine = await joinedHost();
    const release = h.media.holdNext("camera");
    const camera = engine.enableCamera();
    await engine.unmute();
    expect(engine.localMediaState.microphone).toBe(true);
    release();
    await camera;
  });
});

describe("failures", () => {
  it("leaves state, captures, and announcements unchanged when capture fails", async () => {
    const engine = await joinedHost();
    const events = recordEvents(engine);
    h.media.failNext("camera", "NotReadableError");
    await expect(engine.enableCamera()).rejects.toMatchObject({ code: "device_unavailable" });
    h.media.failNext("screen", "NotAllowedError");
    await expect(engine.startScreenShare()).rejects.toMatchObject({ code: "screen_share_cancelled" });
    expect(engine.localMediaState).toEqual({ camera: false, microphone: false, screen: false });
    expect(engine.localMedia).toEqual({ camera: null, microphone: null, screen: null });
    expect(eventsOfType(events, "local_media_changed")).toEqual([]);
    expect(sentMedia(engine)).toEqual([]);
  });

  it("reports unsupported_environment when there are no media devices", async () => {
    const engine = await joinedHost();
    const devices = h.media as unknown as { getUserMedia?: unknown; getDisplayMedia?: unknown };
    devices.getUserMedia = undefined;
    devices.getDisplayMedia = undefined;
    await expect(engine.enableCamera()).rejects.toMatchObject({ code: "unsupported_environment" });
    await expect(engine.startScreenShare()).rejects.toMatchObject({ code: "unsupported_environment" });
  });

  it("releases a capture that completes after leave and rejects with not_joined", async () => {
    const engine = await joinedHost();
    const release = h.media.holdNext("camera");
    const camera = engine.enableCamera();
    await engine.leave();
    release();
    await expect(camera).rejects.toMatchObject({ code: "not_joined" });
    expect(h.media.liveTracks()).toBe(0);
  });
});

describe("device choice", () => {
  const videoConstraint = (index: number) => h.media.constraints[index]?.video;
  const audioConstraint = (index: number) => h.media.constraints[index]?.audio;

  it("1: enableCamera() captures the default camera with unchanged constraints", async () => {
    const engine = await joinedHost();
    await engine.enableCamera();
    expect(h.media.constraints).toEqual([{ video: true, audio: false }]);
    expect((h.media.latestTrack("camera") as FakeTrack).deviceId).toBe("camera-1");
  });

  it("2: enableCamera({ deviceId }) captures that camera exactly and announces it", async () => {
    const engine = await joinedHost();
    const events = recordEvents(engine);
    await engine.enableCamera({ deviceId: "camera-2" });
    expect(videoConstraint(0)).toEqual({ deviceId: { exact: "camera-2" } });
    expect((h.media.latestTrack("camera") as FakeTrack).deviceId).toBe("camera-2");
    expect(sentMedia(engine)).toEqual(["media.camera.started"]);
    expect(eventsOfType(events, "local_media_changed")).toEqual([
      { kind: "camera", enabled: true, stream: engine.localMedia.camera },
    ]);
  });

  it("3: asking for the camera already in use, or for no device, is a no-op", async () => {
    const engine = await joinedHost();
    await engine.enableCamera({ deviceId: "camera-2" });
    const events = recordEvents(engine);
    await engine.enableCamera({ deviceId: "camera-2" });
    await engine.enableCamera();
    expect(h.media.calls.getUserMedia).toBe(1);
    expect(eventsOfType(events, "local_media_changed")).toEqual([]);
    expect(sentMedia(engine)).toEqual(["media.camera.started"]);
  });

  it("4: switching cameras while on swaps in place without an announcement and stops the old track", async () => {
    const engine = await joinedHost();
    await engine.enableCamera({ deviceId: "camera-1" });
    const before = h.media.latestTrack("camera") as FakeTrack;
    const events = recordEvents(engine);
    await engine.enableCamera({ deviceId: "camera-2" });
    const after = h.media.latestTrack("camera") as FakeTrack;
    expect(after.deviceId).toBe("camera-2");
    expect(before.readyState).toBe("ended");
    expect(h.media.liveTracks("camera")).toBe(1);
    expect(engine.localMediaState.camera).toBe(true);
    expect(sentMedia(engine)).toEqual(["media.camera.started"]);
    expect(eventsOfType(events, "local_media_changed")).toEqual([
      { kind: "camera", enabled: true, stream: engine.localMedia.camera },
    ]);
    expect(engine.localMedia.camera?.getVideoTracks()[0]).toBe(after);
  });

  it("5: unmuting a kept microphone with the same or no device re-enables it without capturing", async () => {
    const engine = await joinedHost();
    await engine.unmute({ deviceId: "mic-1" });
    const track = h.media.latestTrack("microphone") as FakeTrack;
    await engine.mute();
    await engine.unmute({ deviceId: "mic-1" });
    await engine.mute();
    await engine.unmute();
    expect(h.media.calls.getUserMedia).toBe(1);
    expect(track.enabled).toBe(true);
    expect(sentMedia(engine).filter((type) => type === "media.microphone.started")).toHaveLength(3);
  });

  it("6: unmuting with another device replaces the kept microphone and announces it", async () => {
    const engine = await joinedHost();
    await engine.unmute({ deviceId: "mic-1" });
    const kept = h.media.latestTrack("microphone") as FakeTrack;
    await engine.mute();
    const events = recordEvents(engine);
    await engine.unmute({ deviceId: "mic-2" });
    expect(audioConstraint(1)).toEqual({ deviceId: { exact: "mic-2" } });
    expect(kept.readyState).toBe("ended");
    expect((h.media.latestTrack("microphone") as FakeTrack).deviceId).toBe("mic-2");
    expect(sentMedia(engine)).toEqual(["media.microphone.started", "media.microphone.stopped", "media.microphone.started"]);
    expect(eventsOfType(events, "local_media_changed")).toEqual([
      { kind: "microphone", enabled: true, stream: engine.localMedia.microphone },
    ]);
  });

  it("7: switching microphones while unmuted swaps in place without an announcement", async () => {
    const engine = await joinedHost();
    await engine.unmute();
    const before = h.media.latestTrack("microphone") as FakeTrack;
    await engine.unmute({ deviceId: "mic-2" });
    const after = h.media.latestTrack("microphone") as FakeTrack;
    expect(after.deviceId).toBe("mic-2");
    expect(after.enabled).toBe(true);
    expect(before.readyState).toBe("ended");
    expect(sentMedia(engine)).toEqual(["media.microphone.started"]);
  });

  it("8: a missing device rejects with device_not_found and leaves the current capture running", async () => {
    const engine = await joinedHost();
    await engine.enableCamera();
    await engine.unmute();
    await engine.mute();
    const camera = h.media.latestTrack("camera") as FakeTrack;
    const microphone = h.media.latestTrack("microphone") as FakeTrack;
    const events = recordEvents(engine);
    await expect(engine.enableCamera({ deviceId: "camera-gone" })).rejects.toMatchObject({ code: "device_not_found" });
    await expect(engine.unmute({ deviceId: "mic-gone" })).rejects.toMatchObject({ code: "device_not_found" });
    expect(camera.readyState).toBe("live");
    expect(microphone.readyState).toBe("live");
    expect(engine.localMediaState).toEqual({ camera: true, microphone: false, screen: false });
    expect(engine.localMedia.camera?.getVideoTracks()[0]).toBe(camera);
    expect(eventsOfType(events, "local_media_changed")).toEqual([]);
    expect(sentMedia(engine)).toEqual(["media.camera.started", "media.microphone.started", "media.microphone.stopped"]);
  });

  it("9: a busy device rejects with device_unavailable and leaves the current capture running", async () => {
    const engine = await joinedHost();
    await engine.enableCamera();
    const camera = h.media.latestTrack("camera") as FakeTrack;
    h.media.failNext("camera", "NotReadableError");
    await expect(engine.enableCamera({ deviceId: "camera-2" })).rejects.toMatchObject({ code: "device_unavailable" });
    expect(camera.readyState).toBe("live");
    expect(engine.localMediaState.camera).toBe(true);
    expect(h.media.liveTracks("camera")).toBe(1);
  });

  it("10: device choices before joining reject with not_joined without capturing", async () => {
    const engine = h.createEngine({ role: "host" });
    await expect(engine.enableCamera({ deviceId: "camera-1" })).rejects.toMatchObject({ code: "not_joined" });
    await expect(engine.unmute({ deviceId: "mic-1" })).rejects.toMatchObject({ code: "not_joined" });
    expect(h.media.calls.getUserMedia).toBe(0);
  });

  it("shares a queued call only when the target and the device match", async () => {
    const engine = await joinedHost();
    const release = h.media.holdNext("camera");
    const first = engine.enableCamera({ deviceId: "camera-1" });
    const same = engine.enableCamera({ deviceId: "camera-1" });
    const other = engine.enableCamera({ deviceId: "camera-2" });
    expect(same).toBe(first);
    expect(other).not.toBe(first);
    release();
    await Promise.all([first, other]);
    expect((h.media.latestTrack("camera") as FakeTrack).deviceId).toBe("camera-2");
    expect(h.media.liveTracks("camera")).toBe(1);
  });

  it("stops the new capture when the meeting is left during a switch", async () => {
    const engine = await joinedHost();
    await engine.enableCamera();
    const release = h.media.holdNext("camera");
    const switching = engine.enableCamera({ deviceId: "camera-2" });
    await engine.leave();
    release();
    await expect(switching).rejects.toMatchObject({ code: "not_joined" });
    expect(h.media.liveTracks()).toBe(0);
  });

  it("never logs a device ID", async () => {
    const lines: string[] = [];
    const record = (message: string, fields?: unknown) => lines.push(`${message} ${JSON.stringify(fields ?? {})}`);
    const engine = h.createEngine({ role: "host", logger: { debug: record, info: record, warn: record, error: record } });
    await engine.join();
    await engine.enableCamera({ deviceId: "camera-2" });
    await engine.enableCamera({ deviceId: "camera-1" });
    await expect(engine.unmute({ deviceId: "mic-gone" })).rejects.toBeDefined();
    expect(lines.join("\n")).not.toMatch(/camera-[12]|mic-gone/);
  });
});

describe("release", () => {
  it("stops every track on leave", async () => {
    const engine = await joinedHost();
    await engine.enableCamera();
    await engine.unmute();
    await engine.mute();
    await engine.startScreenShare();
    await engine.leave();
    expect(h.media.liveTracks()).toBe(0);
  });

  it("stops every track on dispose", async () => {
    const engine = await joinedHost();
    await engine.enableCamera();
    await engine.unmute();
    await engine.startScreenShare();
    engine.dispose();
    expect(h.media.liveTracks()).toBe(0);
  });

  it("stops every track when the connection is lost", async () => {
    const engine = await joinedHost();
    await engine.enableCamera();
    h.realtime.dropWithoutClose();
    await flush();
    expect(engine.state).toBe("closed");
    expect(h.media.liveTracks()).toBe(0);
  });
});
