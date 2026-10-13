import type { MediaKind } from "../../src/public/types.js";

type TrackListener = () => void;

export class FakeTrack {
  readonly id: string;
  readonly kind: "audio" | "video";
  readonly source: MediaKind;
  /** The device this track was captured from; `undefined` for screen captures. */
  readonly deviceId: string | undefined;
  enabled = true;
  readyState: "live" | "ended" = "live";
  readonly #listeners = new Set<TrackListener>();

  constructor(id: string, source: MediaKind, deviceId?: string) {
    this.id = id;
    this.source = source;
    this.kind = source === "microphone" ? "audio" : "video";
    this.deviceId = deviceId;
  }

  getSettings(): { deviceId?: string } {
    return this.deviceId === undefined ? {} : { deviceId: this.deviceId };
  }

  stop(): void {
    this.readyState = "ended";
  }

  addEventListener(type: string, listener: TrackListener): void {
    if (type === "ended") this.#listeners.add(listener);
  }

  removeEventListener(type: string, listener: TrackListener): void {
    if (type === "ended") this.#listeners.delete(listener);
  }

  /** The browser ended the track itself (for example its own "Stop sharing" button). */
  endFromBrowser(): void {
    if (this.readyState === "ended") return;
    this.readyState = "ended";
    for (const listener of [...this.#listeners]) listener();
  }
}

export class FakeStream {
  readonly id: string;
  readonly #tracks: FakeTrack[];

  constructor(id: string, tracks: FakeTrack[]) {
    this.id = id;
    this.#tracks = tracks;
  }

  getTracks(): FakeTrack[] {
    return [...this.#tracks];
  }

  getVideoTracks(): FakeTrack[] {
    return this.#tracks.filter((track) => track.kind === "video");
  }

  getAudioTracks(): FakeTrack[] {
    return this.#tracks.filter((track) => track.kind === "audio");
  }
}

export type FailureName =
  | "NotAllowedError"
  | "NotFoundError"
  | "NotReadableError"
  | "OverconstrainedError"
  | "AbortError"
  | "SecurityError"
  | "TypeError";

export function makeFailure(name: FailureName, message = "raw browser failure text"): Error {
  return name === "TypeError" ? new TypeError(message) : new DOMException(message, name);
}

type Gate = { release: () => void; promise: Promise<void> };

/** The device a constraint asks for exactly, or `undefined` for "any device". */
function exactDevice(constraint: boolean | MediaTrackConstraints | undefined): string | undefined {
  if (typeof constraint !== "object") return undefined;
  const wanted = constraint.deviceId;
  if (typeof wanted === "object" && wanted !== null && !Array.isArray(wanted) && "exact" in wanted) {
    return typeof wanted.exact === "string" ? wanted.exact : undefined;
  }
  return undefined;
}

export class FakeMediaDevices {
  readonly calls = { getUserMedia: 0, getDisplayMedia: 0 };
  readonly tracks: FakeTrack[] = [];
  /** Every `getUserMedia` constraint, in call order. */
  readonly constraints: MediaStreamConstraints[] = [];
  /** Devices present per kind; the first is the browser default. */
  devices: { camera: string[]; microphone: string[] } = { camera: ["camera-1", "camera-2"], microphone: ["mic-1", "mic-2"] };
  readonly #failures = new Map<MediaKind, FailureName[]>();
  readonly #gates = new Map<MediaKind, Gate[]>();
  #counter = 0;

  /** The next capture of `kind` fails with a browser error named `name`. */
  failNext(kind: MediaKind, name: FailureName): void {
    const list = this.#failures.get(kind) ?? [];
    list.push(name);
    this.#failures.set(kind, list);
  }

  /** The next capture of `kind` waits until the returned function is called. */
  holdNext(kind: MediaKind): () => void {
    let release!: () => void;
    const promise = new Promise<void>((resolve) => {
      release = resolve;
    });
    const list = this.#gates.get(kind) ?? [];
    list.push({ release, promise });
    this.#gates.set(kind, list);
    return release;
  }

  liveTracks(kind?: MediaKind): number {
    return this.tracks.filter((track) => track.readyState === "live" && (kind === undefined || track.source === kind))
      .length;
  }

  latestTrack(kind: MediaKind): FakeTrack | undefined {
    return [...this.tracks].reverse().find((track) => track.source === kind);
  }

  simulateBrowserStop(kind: MediaKind): void {
    for (const track of this.tracks) {
      if (track.source === kind && track.readyState === "live") track.endFromBrowser();
    }
  }

  getUserMedia = async (constraints: MediaStreamConstraints): Promise<MediaStream> => {
    this.calls.getUserMedia += 1;
    this.constraints.push(constraints);
    const kind: "camera" | "microphone" = constraints.audio ? "microphone" : "camera";
    const wanted = exactDevice(kind === "camera" ? constraints.video : constraints.audio);
    return this.#capture(kind, wanted);
  };

  getDisplayMedia = async (): Promise<MediaStream> => {
    this.calls.getDisplayMedia += 1;
    return this.#capture("screen");
  };

  async #capture(kind: MediaKind, wanted?: string): Promise<MediaStream> {
    const gate = this.#gates.get(kind)?.shift();
    if (gate) await gate.promise;
    const failure = this.#failures.get(kind)?.shift();
    if (failure) throw makeFailure(failure);
    let deviceId: string | undefined;
    if (kind !== "screen") {
      const present = this.devices[kind];
      if (wanted !== undefined && !present.includes(wanted)) throw makeFailure("OverconstrainedError");
      deviceId = wanted ?? present[0];
      if (deviceId === undefined) throw makeFailure("NotFoundError");
    }
    this.#counter += 1;
    const track = new FakeTrack(`${kind}-track-${this.#counter}`, kind, deviceId);
    this.tracks.push(track);
    return new FakeStream(`${kind}-stream-${this.#counter}`, [track]) as unknown as MediaStream;
  }
}
