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

type Operation = { readonly target: boolean; readonly promise: Promise<void> };
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

/**
 * Local camera, microphone, and screen captures. Changes to one kind run one at a time in call order; a call
 * for the state a queued change will reach shares that change's promise.
 */
export class LocalMediaController {
  readonly #env: EngineEnvironment;
  readonly #hooks: LocalMediaHooks;
  readonly #log: Log;
  readonly #state: PerKind<boolean> = { camera: false, microphone: false, screen: false };
  readonly #streams: PerKind<MediaStream | null> = { camera: null, microphone: null, screen: null };
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

  set(kind: MediaKind, enabled: boolean): Promise<void> {
    const queue = this.#queued[kind];
    const last = queue[queue.length - 1];
    if (last) {
      if (last.target === enabled) return last.promise;
    } else if (this.#state[kind] === enabled && !this.#released) {
      return Promise.resolve();
    }
    const promise = this.#tails[kind].then(() => this.#run(kind, enabled));
    const operation: Operation = { target: enabled, promise };
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
      this.#state[kind] = false;
    }
  }

  async #run(kind: MediaKind, enabled: boolean): Promise<void> {
    if (this.#released) throw new MeetingError("not_joined");
    if (this.#state[kind] === enabled) return;
    if (enabled) await this.#turnOn(kind);
    else this.#turnOff(kind, true);
  }

  async #turnOn(kind: MediaKind): Promise<void> {
    if (kind === "microphone") {
      const kept = this.#streams.microphone;
      if (kept && hasLiveTrack(kept)) {
        setTracksEnabled(kept, true);
        if (!this.#hooks.announce(kind, true)) {
          setTracksEnabled(kept, false);
          throw new MeetingError("not_joined");
        }
        this.#state.microphone = true;
        this.#hooks.changed(kind, true, kept);
        return;
      }
      if (kept) stopTracks(kept);
      this.#streams.microphone = null;
    }

    const generation = this.#generation;
    const stream = await this.#capture(kind);
    if (generation !== this.#generation || this.#released || !this.#hooks.announce(kind, true)) {
      stopTracks(stream);
      throw new MeetingError("not_joined");
    }
    this.#streams[kind] = stream;
    this.#state[kind] = true;
    if (kind === "screen") this.#watchBrowserStop(stream);
    this.#hooks.changed(kind, true, stream);
  }

  #turnOff(kind: MediaKind, announce: boolean): void {
    const stream = this.#streams[kind];
    if (kind === "microphone") {
      if (stream) setTracksEnabled(stream, false);
    } else {
      if (stream) stopTracks(stream);
      this.#streams[kind] = null;
    }
    this.#state[kind] = false;
    const sent = !announce || this.#hooks.announce(kind, false);
    this.#hooks.changed(kind, false, null);
    if (!sent) throw new MeetingError("not_joined");
  }

  async #capture(kind: MediaKind): Promise<MediaStream> {
    const devices = this.#env.mediaDevices;
    try {
      if (kind === "screen") {
        if (typeof devices?.getDisplayMedia !== "function") throw new MeetingError("unsupported_environment");
        return await devices.getDisplayMedia({ video: true, audio: false });
      }
      if (typeof devices?.getUserMedia !== "function") throw new MeetingError("unsupported_environment");
      return await devices.getUserMedia(kind === "camera" ? { video: true, audio: false } : { audio: true, video: false });
    } catch (error) {
      const mapped = mapMediaError(kind, error);
      this.#log.warn("capture failed", { kind, code: mapped.code });
      throw mapped;
    }
  }

  #watchBrowserStop(stream: MediaStream): void {
    const onEnded = (): void => {
      if (this.#streams.screen !== stream || !this.#state.screen) return;
      this.#log.info("screen share ended by the browser", { kind: "screen" });
      this.set("screen", false).catch(() => undefined);
    };
    for (const track of stream.getTracks()) track.addEventListener("ended", onEnded, { once: true });
  }
}
