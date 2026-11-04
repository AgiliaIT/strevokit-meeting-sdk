import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flush, testUlid } from "./support/fakeRealtime.js";
import { type EngineHarness, createPhase1Harness, eventsOfType, recordEvents } from "./support/harness.js";

let h: EngineHarness;

beforeEach(() => {
  h = createPhase1Harness();
});

afterEach(() => {
  h.cleanup();
  vi.unstubAllGlobals();
});

describe("reconnect visibility", () => {
  it("continues recovery when the document becomes visible during reconnecting", async () => {
    const listeners = new Map<string, Set<() => void>>();
    const doc = {
      visibilityState: "hidden" as string,
      addEventListener(type: string, listener: () => void) {
        const set = listeners.get(type) ?? new Set();
        set.add(listener);
        listeners.set(type, set);
      },
      removeEventListener(type: string, listener: () => void) {
        listeners.get(type)?.delete(listener);
      },
    };
    vi.stubGlobal("document", doc);

    const participantId = testUlid();
    const engine = h.createEngine({ participantId });
    await engine.join();
    h.realtime.holdWelcome = true;
    h.realtime.dropWithoutClose(participantId);
    await flush();
    expect(engine.state).toBe("reconnecting");

    doc.visibilityState = "visible";
    for (const listener of listeners.get("visibilitychange") ?? []) listener();
    h.realtime.releaseWelcome();
    await flush();
    expect(engine.state).toBe("joined");
  });

  it("cancels visibility-driven recovery on leave and maps exhaustion to connection_lost", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const listeners = new Map<string, Set<() => void>>();
    const doc = {
      visibilityState: "visible" as string,
      addEventListener(type: string, listener: () => void) {
        const set = listeners.get(type) ?? new Set();
        set.add(listener);
        listeners.set(type, set);
      },
      removeEventListener(type: string, listener: () => void) {
        listeners.get(type)?.delete(listener);
      },
    };
    vi.stubGlobal("document", doc);

    const engine = h.createEngine({ reconnectWindowMs: 1_000 });
    const events = recordEvents(engine);
    await engine.join();
    for (let i = 0; i < 30; i += 1) h.realtime.nextHandshake({ kind: "close", code: 1006 });
    h.realtime.dropWithoutClose();
    await flush();
    expect(engine.state).toBe("reconnecting");
    doc.visibilityState = "visible";
    for (const listener of listeners.get("visibilitychange") ?? []) listener();
    await engine.leave();
    expect(engine.state).toBe("closed");
    expect(eventsOfType(events, "closed")).toEqual([{ reason: "left" }]);
    vi.useRealTimers();
  });
});
