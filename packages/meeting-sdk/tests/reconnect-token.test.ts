import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MeetingLogger } from "../src/public/types.js";
import { flush, testUlid } from "./support/fakeRealtime.js";
import { type EngineHarness, createPhase1Harness, eventsOfType, recordEvents } from "./support/harness.js";

type Call = { level: string; message: string; fields?: unknown };

function capturingLogger(calls: Call[]): MeetingLogger {
  const record = (level: string) => (message: string, fields?: unknown) => calls.push({ level, message, fields });
  return { debug: record("debug"), info: record("info"), warn: record("warn"), error: record("error") };
}

const JWT_SHAPE = /[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/;

let h: EngineHarness;

beforeEach(() => {
  h = createPhase1Harness();
});

afterEach(() => {
  h.cleanup();
});

describe("reconnect token refresh", () => {
  it("prefers the in-memory token when still usable", async () => {
    let refreshCalls = 0;
    const participantId = testUlid();
    const engine = h.createEngine({
      participantId,
      getJoinToken: async () => {
        refreshCalls += 1;
        return h.tokenFor("participant", participantId);
      },
    });
    await engine.join();
    h.realtime.dropWithoutClose(participantId);
    await flush();
    await flush();
    expect(engine.state).toBe("joined");
    expect(refreshCalls).toBe(0);
  });

  it("calls getJoinToken after an expired-token close clears the in-memory token", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    let refreshCalls = 0;
    const participantId = testUlid();
    const engine = h.createEngine({
      participantId,
      getJoinToken: async () => {
        refreshCalls += 1;
        return h.tokenFor("participant", participantId);
      },
    });
    await engine.join();
    h.realtime.nextHandshake({ kind: "close", code: 4002 });
    h.realtime.dropWithoutClose(participantId);
    await flush();
    // First open used the cached token and got 4002; backoff then refreshes.
    for (let i = 0; i < 10; i += 1) {
      await vi.advanceTimersByTimeAsync(500);
      await flush();
      if (engine.state === "joined") break;
    }
    expect(engine.state).toBe("joined");
    expect(refreshCalls).toBeGreaterThanOrEqual(1);
    vi.useRealTimers();
  });

  it("fails recovery with connection_lost when getJoinToken is missing after the token is cleared", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const participantId = testUlid();
    const engine = h.createEngine({ participantId, reconnectWindowMs: 2_000 });
    const events = recordEvents(engine);
    await engine.join();
    h.realtime.nextHandshake({ kind: "close", code: 4002 });
    h.realtime.dropWithoutClose(participantId);
    await flush();
    // Token cleared; subsequent attempts fail immediately without getJoinToken.
    for (let i = 0; i < 10; i += 1) {
      await vi.advanceTimersByTimeAsync(500);
      await flush();
      if (engine.state === "closed") break;
    }
    expect(engine.state).toBe("closed");
    const closed = eventsOfType(events, "closed");
    expect(closed).toHaveLength(1);
    expect(closed[0]?.reason).toBe("connection_lost");
    vi.useRealTimers();
  });

  it("never puts the token into logger fields or events during refresh", async () => {
    const calls: Call[] = [];
    const participantId = testUlid();
    const token = h.tokenFor("participant", participantId);
    const engine = h.createEngine({
      participantId,
      token,
      logger: capturingLogger(calls),
      getJoinToken: async () => h.tokenFor("participant", participantId),
    });
    const events = recordEvents(engine);
    await engine.join();
    h.realtime.nextHandshake({ kind: "close", code: 4002 });
    h.realtime.dropWithoutClose(participantId);
    await flush();
    await flush();
    await flush();
    const blob = JSON.stringify({ calls, events });
    expect(blob).not.toContain(token);
    expect(blob).not.toMatch(JWT_SHAPE);
    for (const call of calls) {
      const fields = call.fields as Record<string, unknown> | undefined;
      if (!fields) continue;
      expect(Object.keys(fields)).not.toContain("token");
      expect(Object.keys(fields)).not.toContain("joinToken");
    }
  });
});
