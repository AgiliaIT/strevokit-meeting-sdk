import type { MediaKind, MediaState, MeetingEventMap, RemoteMedia } from "../public/types.js";
import { NO_REMOTE_MEDIA } from "./mediaDelivery.js";

const KINDS: readonly MediaKind[] = ["camera", "microphone", "screen"];

export type RemoteMediaInputs = {
  /** The participant is the one this side carries media with. */
  readonly active: boolean;
  /** The link connected at least once and is neither failed nor closed. */
  readonly usable: boolean;
  /** What the participant announced through signaling. */
  readonly announced: MediaState;
  readonly streams: { readonly camera: MediaStream | null; readonly microphone: MediaStream | null };
};

/** A kind is available when the link to an active participant is usable and the participant announced it on. */
export function computeRemoteMedia(inputs: RemoteMediaInputs): RemoteMedia {
  if (!inputs.active || !inputs.usable) return NO_REMOTE_MEDIA;
  const camera = inputs.announced.camera ? inputs.streams.camera : null;
  const microphone = inputs.announced.microphone ? inputs.streams.microphone : null;
  if (camera === null && microphone === null) return NO_REMOTE_MEDIA;
  return Object.freeze({ camera, microphone, screen: null });
}

type Emit = (event: MeetingEventMap["remote_media_changed"]) => void;

/** The last reported remote media per participant; reports each change of a kind exactly once. */
export class RemoteMediaTracker {
  readonly #current = new Map<string, RemoteMedia>();

  get(participantId: string): RemoteMedia {
    return this.#current.get(participantId) ?? NO_REMOTE_MEDIA;
  }

  update(participantId: string, next: RemoteMedia, emit: Emit): void {
    const previous = this.get(participantId);
    if (next === NO_REMOTE_MEDIA) this.#current.delete(participantId);
    else this.#current.set(participantId, next);
    for (const kind of KINDS) {
      if (previous[kind] !== next[kind]) emit({ participantId, kind, stream: next[kind] });
    }
  }

  /** Forgets everything without reporting. */
  clear(): void {
    this.#current.clear();
  }
}
