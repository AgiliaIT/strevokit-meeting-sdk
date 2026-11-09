import { MeetingError } from "../public/errors.js";
import type { LocalMedia, MediaKind, MediaState } from "../public/types.js";
import type { EngineEnvironment } from "./env.js";
import { mapMediaError } from "./errorMapping.js";
import type { Log } from "./log.js";

export interface LocalMediaHooks {
  /** Tells the meeting about a local change. Returns false when the connection is gone. */
  announce(kind: MediaKind, enabled: boolean): boolean;
  /** A local change took effect. */
  changed(kind: MediaKind, enabled: boolean, stream: MediaStream | null): void;
}

type Operation = { readonly target: boolean; readonly deviceId: string | undefined; readonly promise: Promise<void> };
type PerKind<T> = Record<MediaKind, T>;

const KINDS: readonly MediaKind[] = ["camera", "microphone", "screen"];

function stopTracks(stream: MediaStream): void {
  for (const track of stream.getTracks()) {
    try {
      track.stop();
    } catch {
      // Stopping an already-ended track is harmless.
    }
  }
}

function setTracksEnabled(stream: MediaStream, enabled: boolean): void {
  for (const track of stream.getTracks()) track.enabled = enabled;
}

function hasLiveTrack(stream: MediaStream): boolean {
  return stream.getTracks().some((track) => track.readyState === "live");
}

/** The device a capture came from: what the browser reports, else the device that was asked for. */
function deviceOf(stream: MediaStream, requested: string | undefined): string | null {
  const track = stream.getTracks()[0];
  const reported = typeof track?.getSettings === "function" ? track.getSettings().deviceId : undefined;
  return reported || requested || null;
}

/**
 * Local camera, microphone, and screen captures. Changes to one kind run one at a time in call order; a call
 * for the state and device a queued change will reach shares that change's promise.
 */
export class LocalMediaController {
  readonly #env: EngineEnvironment;
  readonly #hooks: LocalMediaHooks;
  readonly #log: Log;
  readonly #state: PerKind<boolean> = { camera: false, microphone: false, screen: false };
  readonly #streams: PerKind<MediaStream | null> = { camera: null, microphone: null, screen: null };
  readonly #devices: PerKind<string | null> = { camera: null, microphone: null, screen: null };
  readonly #tails: PerKind<Promise<void>> = {
    camera: Promise.resolve(),
    microphone: Promise.resolve(),
    screen: Promise.resolve(),
  };
  readonly #queued: PerKind<Operation[]> = { camera: [], microphone: [], screen: [] };
  #released = false;
  #generation = 0;

  constructor(env: EngineEnvironment, hooks: LocalMediaHooks, log: Log) {
    this.#env = env;
    this.#hooks = hooks;
    this.#log = log;
  }

  get state(): MediaState {
    return Object.freeze({ ...this.#state });
  }

  get streams(): LocalMedia {
    return Object.freeze({
      camera: this.#state.camera ? this.#streams.camera : null,
      microphone: this.#state.microphone ? this.#streams.microphone : null,
      screen: this.#state.screen ? this.#streams.screen : null,
    });
  }

  /**
   * Turns `kind` on or off. `deviceId` applies to turning the camera or microphone on: it captures that device, or
   * switches to it in place when `kind` is already on with another device.
   */
  set(kind: MediaKind, enabled: boolean, deviceId?: string): Promise<void> {
    const wanted = enabled && kind !== "screen" ? deviceId : undefined;
    const queue = this.#queued[kind];
    const last = queue[queue.length - 1];
    if (last) {
      if (last.target === enabled && last.deviceId === wanted) return last.promise;
    } else if (this.#state[kind] === enabled && !this.#released && !this.#needsSwitch(kind, wanted)) {
      return Promise.resolve();
    }
    const promise = this.#tails[kind].then(() => this.#run(kind, enabled, wanted));
    const operation: Operation = { target: enabled, deviceId: wanted, promise };
    queue.push(operation);
    const settle = (): void => {
      const index = queue.indexOf(operation);
      if (index >= 0) queue.splice(index, 1);
    };
    this.#tails[kind] = promise.then(settle, settle);
    return promise;
  }

  /** Turns `kind` off locally without announcing it, because the meeting refused the change. */
  rollback(kind: MediaKind): void {
    if (!this.#state[kind]) return;
    this.#turnOff(kind, false);
  }

  /** Stops every capture. Pending and later changes reject with `not_joined`. Emits nothing. */
  releaseAll(): void {
    this.#released = true;
    this.#generation += 1;
    for (const kind of KINDS) {
      const stream = this.#streams[kind];
      if (stream) stopTracks(stream);
      this.#streams[kind] = null;
      this.#devices[kind] = null;
      this.#state[kind] = false;
    }
  }

  /** True when `kind` is on and a specific device other than the one in use was asked for. */
  #needsSwitch(kind: MediaKind, deviceId: string | undefined): boolean {
    return this.#state[kind] && deviceId !== undefined && deviceId !== this.#devices[kind];
  }

  async #run(kind: MediaKind, enabled: boolean, deviceId: string | undefined): Promise<void> {
    if (this.#released) throw new MeetingError("not_joined");
    if (enabled && this.#needsSwitch(kind, deviceId)) return this.#switchDevice(kind, deviceId as string);
    if (this.#state[kind] === enabled) return;
    if (enabled) await this.#turnOn(kind, deviceId);
    else this.#turnOff(kind, true);
  }

  /**
   * Replaces a running capture with one from another device. The new capture is handed on before the old one stops,
   * so the meeting keeps receiving media; nothing is announced because the on/off state does not change. When the
   * new device cannot be captured, the old capture keeps running.
   */
  async #switchDevice(kind: MediaKind, deviceId: string): Promise<void> {
    const generation = this.#generation;
    const stream = await this.#capture(kind, deviceId);
    if (generation !== this.#generation || this.#released || !this.#state[kind]) {
      stopTracks(stream);
      throw new MeetingError("not_joined");
    }
    const previous = this.#streams[kind];
    this.#streams[kind] = stream;
    this.#devices[kind] = deviceOf(stream, deviceId);
    this.#watchEnded(kind, stream);
    this.#hooks.changed(kind, true, stream);
    if (previous) stopTracks(previous);
  }

  async #turnOn(kind: MediaKind, deviceId: string | undefined): Promise<void> {
    if (kind === "microphone") {
      const kept = this.#streams.microphone;
      const sameDevice = deviceId === undefined || deviceId === this.#devices.microphone;
      if (kept && hasLiveTrack(kept) && sameDevice) {
        setTracksEnabled(kept, true);
        if (!this.#hooks.announce(kind, true)) {
          setTracksEnabled(kept, false);
          throw new MeetingError("not_joined");
        }
        this.#state.microphone = true;
        this.#hooks.changed(kind, true, kept);
        return;
      }
      if (kept && !hasLiveTrack(kept)) {
        stopTracks(kept);
        this.#streams.microphone = null;
        this.#devices.microphone = null;
      }
    }

    const generation = this.#generation;
    const stream = await this.#capture(kind, deviceId);
    if (generation !== this.#generation || this.#released || !this.#hooks.announce(kind, true)) {
      stopTracks(stream);
      throw new MeetingError("not_joined");
    }
    // A kept microphone from another device is replaced only once the chosen one is captured.
    const replaced = this.#streams[kind];
    this.#streams[kind] = stream;
    this.#devices[kind] = kind === "screen" ? null : deviceOf(stream, deviceId);
    this.#state[kind] = true;
    this.#watchEnded(kind, stream);
    this.#hooks.changed(kind, true, stream);
    if (replaced) stopTracks(replaced);
  }

  #turnOff(kind: MediaKind, announce: boolean): void {
    const stream = this.#streams[kind];
    if (kind === "microphone") {
      if (stream) setTracksEnabled(stream, false);
    } else {
      if (stream) stopTracks(stream);
      this.#streams[kind] = null;
      this.#devices[kind] = null;
    }
    this.#state[kind] = false;
    const sent = !announce || this.#hooks.announce(kind, false);
    this.#hooks.changed(kind, false, null);
    if (!sent) throw new MeetingError("not_joined");
  }

  async #capture(kind: MediaKind, deviceId?: string): Promise<MediaStream> {
    const devices = this.#env.mediaDevices;
    try {
      if (kind === "screen") {
        if (typeof devices?.getDisplayMedia !== "function") throw new MeetingError("unsupported_environment");
        return await devices.getDisplayMedia({ video: true, audio: false });
      }
      if (typeof devices?.getUserMedia !== "function") throw new MeetingError("unsupported_environment");
      const track: boolean | MediaTrackConstraints = deviceId === undefined ? true : { deviceId: { exact: deviceId } };
      return await devices.getUserMedia(kind === "camera" ? { video: track, audio: false } : { audio: track, video: false });
    } catch (error) {
      const mapped = mapMediaError(kind, error);
      this.#log.warn("capture failed", { kind, code: mapped.code });
      throw mapped;
    }
  }

  /**
   * A capture the browser or device ended. A live camera or unmuted microphone continues on another listed
   * device of that kind when one can be opened. Otherwise the kind turns off and is announced. Screen share
   * always turns off. A muted microphone is dropped and is not replaced.
   */
  #watchEnded(kind: MediaKind, stream: MediaStream): void {
    const onEnded = (): void => {
      if (this.#released || this.#streams[kind] !== stream) return;
      if (!this.#state[kind]) {
        // A muted microphone that ended is dropped, so the next unmute captures again.
        if (kind === "microphone") {
          this.#streams.microphone = null;
          this.#devices.microphone = null;
        }
        return;
      }
      if (kind === "screen") {
        this.#log.info("screen share ended by the browser", { kind });
        this.set(kind, false).catch(() => undefined);
        return;
      }
      const generation = this.#generation;
      const scheduled = this.#tails[kind].then(() => this.#continueOnAnotherDevice(kind, stream, generation));
      this.#tails[kind] = scheduled.then(
        () => undefined,
        () => undefined,
      );
    };
    for (const track of stream.getTracks()) track.addEventListener("ended", onEnded, { once: true });
  }

  /** The capture that just ended is still the one in use, and the meeting has not been released. */
  #stillCurrent(kind: MediaKind, stream: MediaStream, generation: number): boolean {
    return !this.#released && this.#generation === generation && this.#state[kind] && this.#streams[kind] === stream;
  }

  /**
   * Opens the first remaining device of `kind` and installs it the same way as a live switch. When none can be
   * opened, turns `kind` off. A release or a newer capture during the attempt stops the new stream and emits nothing.
   */
  async #continueOnAnotherDevice(kind: "camera" | "microphone", endedStream: MediaStream, generation: number): Promise<void> {
    if (!this.#stillCurrent(kind, endedStream, generation)) return;
    const endedId = this.#devices[kind] ?? deviceOf(endedStream, undefined);
    const candidates = await this.#otherDevices(kind, endedId);
    if (!this.#stillCurrent(kind, endedStream, generation)) return;
    for (const deviceId of candidates) {
      if (!this.#stillCurrent(kind, endedStream, generation)) return;
      let stream: MediaStream;
      try {
        stream = await this.#capture(kind, deviceId);
      } catch {
        continue;
      }
      if (!this.#stillCurrent(kind, endedStream, generation)) {
        stopTracks(stream);
        return;
      }
      this.#streams[kind] = stream;
      this.#devices[kind] = deviceOf(stream, deviceId);
      this.#watchEnded(kind, stream);
      this.#hooks.changed(kind, true, stream);
      stopTracks(endedStream);
      this.#log.info("capture continued on another device", { kind, reason: "capture_fallback" });
      return;
    }
    if (!this.#stillCurrent(kind, endedStream, generation)) return;
    this.#log.info("capture ended", { kind });
    try {
      this.#turnOff(kind, true);
    } catch {
      // The meeting is already gone; the new capture was never installed.
    }
  }

  /** Listed devices of `kind`, excluding the one that just ended and any empty id. */
  async #otherDevices(kind: "camera" | "microphone", endedId: string | null): Promise<string[]> {
    const devices = this.#env.mediaDevices;
    if (typeof devices?.enumerateDevices !== "function") return [];
    let listed: readonly { readonly deviceId: string; readonly kind: string }[];
    try {
      listed = await devices.enumerateDevices();
    } catch {
      return [];
    }
    const wanted = kind === "camera" ? "videoinput" : "audioinput";
    const ids: string[] = [];
    for (const device of listed) {
      if (device.kind !== wanted || !device.deviceId || device.deviceId === endedId || ids.includes(device.deviceId)) continue;
      ids.push(device.deviceId);
    }
    return ids;
  }
}
