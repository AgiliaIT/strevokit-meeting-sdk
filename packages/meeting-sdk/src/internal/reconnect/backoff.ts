/** Base delay for the first reconnect open attempt (ms). */
export const RECONNECT_BACKOFF_BASE_MS = 500;

/** Exponential growth factor applied per successive attempt. */
export const RECONNECT_BACKOFF_FACTOR = 2;

/** Maximum delay between reconnect open attempts (ms). */
export const RECONNECT_BACKOFF_CAP_MS = 8000;

/** Fractional jitter applied to each delay (±20%). */
export const RECONNECT_BACKOFF_JITTER = 0.2;

export type BackoffClock = {
  /** Returns a value in [0, 1). Injected for deterministic tests. */
  random(): number;
};

/**
 * Delay before the given 1-based attempt: `base × factor^(n-1)`, capped, with ±jitter.
 * Attempt 1 → ~500 ms, attempt 2 → ~1000 ms, … capped at 8000 ms.
 */
export function reconnectBackoffMs(attempt: number, clock: BackoffClock = Math): number {
  const n = Math.max(1, Math.floor(attempt));
  const raw = Math.min(RECONNECT_BACKOFF_CAP_MS, RECONNECT_BACKOFF_BASE_MS * RECONNECT_BACKOFF_FACTOR ** (n - 1));
  const jitter = 1 + (clock.random() * 2 - 1) * RECONNECT_BACKOFF_JITTER;
  return Math.max(0, Math.round(raw * jitter));
}
