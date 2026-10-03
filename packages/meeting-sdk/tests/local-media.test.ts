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
