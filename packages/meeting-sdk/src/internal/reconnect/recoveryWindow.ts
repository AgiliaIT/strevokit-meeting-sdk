/** Default continuous unsuccessful recovery budget (ms). */
export const DEFAULT_RECONNECT_WINDOW_MS = 120_000;

/** Lowest allowed `reconnectWindowMs` (tests and production). */
export const MIN_RECONNECT_WINDOW_MS = 1_000;

/** Highest allowed `reconnectWindowMs`. */
export const MAX_RECONNECT_WINDOW_MS = 600_000;

/**
 * Clamps a consumer-supplied recovery window to the documented safe range.
 * Non-integers and non-finite values fall back to the default.
 */
export function clampReconnectWindowMs(value: number | undefined): number {
  if (value === undefined) return DEFAULT_RECONNECT_WINDOW_MS;
  if (typeof value !== "number" || !Number.isInteger(value) || !Number.isFinite(value)) {
    return DEFAULT_RECONNECT_WINDOW_MS;
  }
  if (value < MIN_RECONNECT_WINDOW_MS) return MIN_RECONNECT_WINDOW_MS;
  if (value > MAX_RECONNECT_WINDOW_MS) return MAX_RECONNECT_WINDOW_MS;
  return value;
}

export type RecoveryWindowState = {
  readonly windowMs: number;
  windowStartedAtMs: number | undefined;
};

/** Marks the start of the current unsuccessful recovery chain if not already running. */
export function markRecoveryWindowStart(state: RecoveryWindowState, nowMs: number): void {
  if (state.windowStartedAtMs === undefined) state.windowStartedAtMs = nowMs;
}

/** Clears the window so a later failure starts a fresh budget. */
export function resetRecoveryWindow(state: RecoveryWindowState): void {
  state.windowStartedAtMs = undefined;
}

/** True when continuous unsuccessful recovery has exceeded the configured budget. */
export function isRecoveryWindowExhausted(state: RecoveryWindowState, nowMs: number): boolean {
  if (state.windowStartedAtMs === undefined) return false;
  return nowMs - state.windowStartedAtMs >= state.windowMs;
}
