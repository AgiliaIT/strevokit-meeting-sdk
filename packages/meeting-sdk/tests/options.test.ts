import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createMeetingEngine } from "../src/createMeetingEngine.js";
import { __setTestEnvironment } from "../src/internal/env.js";
import { MeetingError } from "../src/public/errors.js";
import type { MeetingEngineOptions } from "../src/public/types.js";
import { FakeRealtime, testUlid } from "./support/fakeRealtime.js";

let realtime: FakeRealtime;

/** Installs a test environment backed by the fake realtime server, optionally without `WebSocket`. */
function install(withWebSocket = true): void {
  __setTestEnvironment({
    WebSocket: withWebSocket ? realtime.WebSocket : undefined,
    mediaDevices: undefined,
    setTimeout: (callback, ms) => setTimeout(callback, ms),
    clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    now: () => Date.now(),
  });
}

/** Valid engine options (a fresh join token and a `wss://` URL) with `overrides` applied. */
function options(overrides: Partial<MeetingEngineOptions> = {}): MeetingEngineOptions {
  return { token: realtime.tokenFor(testUlid()), realtimeUrl: "wss://realtime.example.com", ...overrides };
}

/** Calls `fn` and returns the `MeetingError` code it throws, `"TypeError"`, or `"ok"`; other errors are rethrown. */
function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof MeetingError) return error.code;
    if (error instanceof TypeError) return "TypeError";
    throw error;
  }
  return "ok";
}

beforeEach(() => {
  realtime = new FakeRealtime();
  install();
});

afterEach(() => {
  __setTestEnvironment(undefined);
});

describe("createMeetingEngine options", () => {
  it.each([
    ["wss://realtime.example.com", "ok"],
    ["wss://realtime.example.com:8443", "ok"],
    ["wss://realtime.example.com/", "ok"],
    ["ws://localhost:8443", "ok"],
    ["ws://127.0.0.1:8443", "ok"],
    ["ws://example.com", "TypeError"],
    ["wss://realtime.example.com/v1", "TypeError"],
    ["wss://realtime.example.com?x=1", "TypeError"],
    ["wss://realtime.example.com#frag", "TypeError"],
    ["wss://user:pass@realtime.example.com", "TypeError"],
    ["https://realtime.example.com", "TypeError"],
    ["http://localhost:8443", "TypeError"],
    ["not a url", "TypeError"],
    ["", "TypeError"],
  ])("realtimeUrl %j → %s", (realtimeUrl, expected) => {
    expect(codeOf(() => createMeetingEngine(options({ realtimeUrl })))).toBe(expected);
  });

  it("strips a trailing slash from realtimeUrl", async () => {
    const engine = createMeetingEngine(options({ realtimeUrl: "wss://realtime.example.com/" }));
    await engine.join();
    expect(realtime.socketFor().url).toMatch(/^wss:\/\/realtime\.example\.com\/v1\/meetings\/[0-9A-Z]{26}\/signaling$/);
    engine.dispose();
  });

  it.each([
    [undefined, "ok"],
    [1000, "ok"],
    [60000, "ok"],
    [999, "TypeError"],
    [60001, "TypeError"],
    [1500.5, "TypeError"],
    [Number.NaN, "TypeError"],
  ])("joinTimeoutMs %s → %s", (joinTimeoutMs, expected) => {
    expect(codeOf(() => createMeetingEngine(options({ joinTimeoutMs: joinTimeoutMs as number })))).toBe(expected);
  });

  it("rejects an empty or non-string token with join_token_invalid", () => {
    expect(codeOf(() => createMeetingEngine(options({ token: "" })))).toBe("join_token_invalid");
    expect(codeOf(() => createMeetingEngine(options({ token: 42 as unknown as string })))).toBe("join_token_invalid");
  });

  it("throws unsupported_environment when there is no WebSocket", () => {
    install(false);
    expect(codeOf(() => createMeetingEngine(options()))).toBe("unsupported_environment");
  });

  it("throws TypeError when options are missing", () => {
    expect(codeOf(() => createMeetingEngine(undefined as unknown as MeetingEngineOptions))).toBe("TypeError");
  });
});
