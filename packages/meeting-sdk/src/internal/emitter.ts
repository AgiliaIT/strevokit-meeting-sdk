import type { Log } from "./log.js";

type Listener<T> = (event: T) => void;

/** Synchronous typed emitter. A throwing listener never affects other listeners or the caller. */
export class Emitter<Events extends object> {
  readonly #listeners = new Map<keyof Events, Set<Listener<never>>>();
  readonly #log: Log;

  constructor(log: Log) {
    this.#log = log;
  }

  on<K extends keyof Events>(type: K, listener: Listener<Events[K]>): () => void {
    let set = this.#listeners.get(type);
    if (!set) {
      set = new Set();
      this.#listeners.set(type, set);
    }
    const entry = listener as Listener<never>;
    set.add(entry);
    return () => {
      this.#listeners.get(type)?.delete(entry);
    };
  }

  emit<K extends keyof Events>(type: K, event: Events[K]): void {
    const set = this.#listeners.get(type);
    if (!set || set.size === 0) return;
    for (const listener of [...set]) {
      try {
        (listener as Listener<Events[K]>)(event);
      } catch {
        this.#log.warn("event listener threw", { messageType: String(type) });
      }
    }
  }

  clear(): void {
    this.#listeners.clear();
  }
}
