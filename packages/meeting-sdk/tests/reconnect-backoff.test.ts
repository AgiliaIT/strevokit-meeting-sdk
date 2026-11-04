import { describe, expect, it } from "vitest";
import {
  RECONNECT_BACKOFF_BASE_MS,
  RECONNECT_BACKOFF_CAP_MS,
  reconnectBackoffMs,
} from "../src/internal/reconnect/backoff.js";
import {
  DEFAULT_RECONNECT_WINDOW_MS,
  MAX_RECONNECT_WINDOW_MS,
  MIN_RECONNECT_WINDOW_MS,
  clampReconnectWindowMs,
} from "../src/internal/reconnect/recoveryWindow.js";

describe("reconnect backoff", () => {
  it("follows 500 × 2^(n-1) capped at 8000 with no jitter when random is 0.5", () => {
    const clock = { random: () => 0.5 };
    expect(reconnectBackoffMs(1, clock)).toBe(RECONNECT_BACKOFF_BASE_MS);
    expect(reconnectBackoffMs(2, clock)).toBe(1_000);
    expect(reconnectBackoffMs(3, clock)).toBe(2_000);
    expect(reconnectBackoffMs(4, clock)).toBe(4_000);
    expect(reconnectBackoffMs(5, clock)).toBe(RECONNECT_BACKOFF_CAP_MS);
    expect(reconnectBackoffMs(10, clock)).toBe(RECONNECT_BACKOFF_CAP_MS);
  });

  it("keeps successive delays within ±20% of the uncapped schedule", () => {
    const samples = [0, 0.25, 0.5, 0.75, 1];
    for (let attempt = 1; attempt <= 8; attempt++) {
      const uncapped = Math.min(RECONNECT_BACKOFF_CAP_MS, RECONNECT_BACKOFF_BASE_MS * 2 ** (attempt - 1));
      const low = Math.round(uncapped * 0.8);
      const high = Math.round(uncapped * 1.2);
      for (const r of samples) {
        const delay = reconnectBackoffMs(attempt, { random: () => r });
        expect(delay).toBeGreaterThanOrEqual(low);
        expect(delay).toBeLessThanOrEqual(high);
      }
    }
  });
});

describe("recovery window", () => {
  it("defaults to 120_000 ms", () => {
    expect(DEFAULT_RECONNECT_WINDOW_MS).toBe(120_000);
    expect(clampReconnectWindowMs(undefined)).toBe(120_000);
  });

  it("clamps unsafe values into the documented safe range", () => {
    expect(clampReconnectWindowMs(0)).toBe(MIN_RECONNECT_WINDOW_MS);
    expect(clampReconnectWindowMs(-1)).toBe(MIN_RECONNECT_WINDOW_MS);
    expect(clampReconnectWindowMs(999)).toBe(MIN_RECONNECT_WINDOW_MS);
    expect(clampReconnectWindowMs(MAX_RECONNECT_WINDOW_MS + 1)).toBe(MAX_RECONNECT_WINDOW_MS);
    expect(clampReconnectWindowMs(Number.NaN)).toBe(DEFAULT_RECONNECT_WINDOW_MS);
    expect(clampReconnectWindowMs(1.5)).toBe(DEFAULT_RECONNECT_WINDOW_MS);
    expect(clampReconnectWindowMs(5_000)).toBe(5_000);
  });
});
