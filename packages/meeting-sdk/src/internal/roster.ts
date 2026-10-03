import type { MediaKind, MediaState, Participant, ParticipantRole } from "../public/types.js";

type Entry = {
  id: string;
  role: ParticipantRole;
  displayName?: string;
  media: { camera: boolean; microphone: boolean; screen: boolean };
};

export type UpsertResult = "buffered" | "added" | "updated";

function snapshot(entry: Entry): Participant {
  const media: MediaState = Object.freeze({ ...entry.media });
  const participant: { id: string; role: ParticipantRole; displayName?: string; media: MediaState } = {
    id: entry.id,
    role: entry.role,
    media,
  };
  if (entry.displayName !== undefined) participant.displayName = entry.displayName;
  return Object.freeze(participant);
}

/**
 * Other participants and their media state. Frames received while joining are buffered until `commit()`, which
 * marks the initial snapshot as complete.
 */
export class Roster {
  readonly #entries = new Map<string, Entry>();
  #committed = false;
  #cache: readonly Participant[] | undefined;

  get committed(): boolean {
    return this.#committed;
  }

  upsertJoined(id: string, role: ParticipantRole, displayName?: string): UpsertResult {
    const existing = this.#entries.get(id);
    this.#cache = undefined;
    if (existing) {
      existing.role = role;
      if (displayName !== undefined) existing.displayName = displayName;
      else delete existing.displayName;
      return this.#committed ? "updated" : "buffered";
    }
    const entry: Entry = { id, role, media: { camera: false, microphone: false, screen: false } };
    if (displayName !== undefined) entry.displayName = displayName;
    this.#entries.set(id, entry);
    return this.#committed ? "added" : "buffered";
  }

  /** Returns true when the participant's state changed. Unknown participants are ignored after commit. */
  setMedia(id: string, kind: MediaKind, enabled: boolean): boolean {
    let entry = this.#entries.get(id);
    if (!entry) {
      if (this.#committed) return false;
      this.upsertJoined(id, "participant");
      entry = this.#entries.get(id);
      if (!entry) return false;
    }
    if (entry.media[kind] === enabled) return false;
    entry.media[kind] = enabled;
    this.#cache = undefined;
    return true;
  }

  remove(id: string): boolean {
    const removed = this.#entries.delete(id);
    if (removed) this.#cache = undefined;
    return removed;
  }

  commit(): void {
    this.#committed = true;
    this.#cache = undefined;
  }

  get(id: string): Participant | undefined {
    const entry = this.#entries.get(id);
    return entry ? snapshot(entry) : undefined;
  }

  /** Committed participants in arrival order; empty before commit. */
  list(): readonly Participant[] {
    if (!this.#committed) return Object.freeze([]);
    this.#cache ??= Object.freeze([...this.#entries.values()].map(snapshot));
    return this.#cache;
  }

  clear(): void {
    this.#entries.clear();
    this.#cache = undefined;
  }
}
