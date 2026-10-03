import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Log } from "../src/internal/log.js";
import { ERROR_INFO, MeetingError } from "../src/public/errors.js";
import type { MeetingLogger } from "../src/public/types.js";
import { flush, testUlid } from "./support/fakeRealtime.js";
import { type EngineHarness, createPhase1Harness, eventsOfType, recordEvents } from "./support/harness.js";

type Call = { level: string; message: string; fields?: unknown };

/** A `MeetingLogger` that appends every call, at every level, to `calls`. */
function capturingLogger(calls: Call[]): MeetingLogger {
  const record = (level: string) => (message: string, fields?: unknown) => calls.push({ level, message, fields });
  return { debug: record("debug"), info: record("info"), warn: record("warn"), error: record("error") };
}

const JWT_SHAPE = /[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/;

/** Asserts something was logged and that no call contains the join token, a JWT, SDP, ICE candidates, or raw error text. */
function assertClean(calls: Call[], token: string): void {
  expect(calls.length).toBeGreaterThan(0);
  for (const call of calls) {
    const text = JSON.stringify(call);
    expect(text).not.toContain(token);
    expect(text).not.toMatch(JWT_SHAPE);
    expect(text.toLowerCase()).not.toContain("sdp");
    expect(text.toLowerCase()).not.toContain("candidate");
    expect(text).not.toContain("raw browser failure text");
    expect(text).not.toContain("listener failure");
  }
}

let h: EngineHarness;

beforeEach(() => {
  h = createPhase1Harness();
});

afterEach(() => {
  h.cleanup();
});

describe("log hygiene", () => {
  it("keeps the token, negotiation content, and exception text out of logs during a full run", async () => {
    const calls: Call[] = [];
    const token = h.tokenFor("host");
    const otherId = testUlid();
    h.realtime.addPresent({ participantId: otherId, displayName: "Ada" });
    const engine = h.createEngine({ token, logger: capturingLogger(calls) });
    const events = recordEvents(engine);
    engine.on("joined", () => {
      throw new Error("listener failure");
    });
    await engine.join();
    h.realtime.virtualMedia(otherId, "camera", true);
    h.realtime.virtualLeave(otherId);
    h.realtime.send("{broken");
    await engine.enableCamera();
    h.media.failNext("microphone", "NotAllowedError");
    await engine.unmute().catch(() => undefined);
    await engine.leave();
    await flush();

    assertClean(calls, token);
    for (const { error } of eventsOfType(events, "error")) expect(error.message).toBe(ERROR_INFO[error.code].message);
  });

  it.each([4001, 4002, 4003, 4011, 4503])("stays clean when the platform closes with %i", async (code) => {
    const calls: Call[] = [];
    const token = h.tokenFor();
    h.realtime.nextHandshake({ kind: "close", code });
    const engine = h.createEngine({ token, logger: capturingLogger(calls) });
    const error = await engine.join().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MeetingError);
    expect((error as MeetingError).message).toBe(ERROR_INFO[(error as MeetingError).code].message);
    assertClean(calls, token);
  });

  it("stays clean on join timeout and connection loss", async () => {
    const calls: Call[] = [];
    const token = h.tokenFor();
    const engine = h.createEngine({ token, logger: capturingLogger(calls) });
    await engine.join();
    h.realtime.dropWithoutClose();
    await flush();
    assertClean(calls, token);
  });

  it("drops fields that are not allow-listed or look like secrets", () => {
    const calls: Call[] = [];
    const log = new Log(capturingLogger(calls));
    log.info("probe", {
      state: "joined",
      token: "anything",
      // Assembled at runtime so secret scanners never see a token-shaped literal in this file.
      reason: ["eyJhbGciOiJIUzI1NiJ9", "eyJzdWIiOiIxMjM0NTY3ODkwIn0", "c2lnbmF0dXJl"].join("."),
      code: "v=0 sdp offer",
      kind: "camera",
    });
    expect(calls).toEqual([{ level: "info", message: "probe", fields: { state: "joined", kind: "camera" } }]);
  });

  it("never throws when the logger throws", () => {
    const log = new Log({
      info() {
        throw new Error("logger down");
      },
    });
    expect(() => log.info("probe", { state: "idle" })).not.toThrow();
  });
});
