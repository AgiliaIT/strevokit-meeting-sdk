import { afterEach, describe, expect, it } from "vitest";
import { MeetingError } from "../src/public/errors.js";
import { type EngineHarness, type RecordedEvent, createP2PHarness, createPhase1Harness, recordEvents } from "./support/harness.js";
import { orderedIds, settle } from "./support/p2p.js";

/** Events with participant IDs replaced by labels, streams by presence and timestamps dropped, for comparison. */
function normalized(events: RecordedEvent[], labels: Map<string, string>): unknown {
  return JSON.parse(
    JSON.stringify(events, (_key, value: unknown) => {
      if (value instanceof MeetingError) return { code: value.code };
      if (value !== null && typeof value === "object" && "getTracks" in value) return "stream";
      if (typeof value === "string" && labels.has(value)) return labels.get(value);
      if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/.test(value)) return "time";
      return value;
    }),
  );
}

/** The 0.1.0 quick start: join, turn devices on, then leave, listening only to the 0.1.0 events. */
async function quickStart(h: EngineHarness) {
  const { low, high } = orderedIds();
  const labels = new Map([
    [low, "A"],
    [high, "B"],
  ]);
  const a = h.createEngine({ participantId: low, role: "host" });
  const b = h.createEngine({ participantId: high });
  const aEvents = recordEvents(a);
  const bEvents = recordEvents(b);
  await a.join();
  await b.join();
  await a.enableCamera();
  await a.unmute();
  await b.enableCamera();
  await settle();
  await b.leave();
  await settle(2);
  await a.leave();
  return { a: normalized(aEvents, labels), b: normalized(bEvents, labels) };
}

describe("upgrading from 0.1.0", () => {
  let h: EngineHarness | undefined;

  afterEach(() => {
    h?.cleanup();
    h = undefined;
  });

  it("the quick start emits the same 0.1.0 events whether or not media flows directly", async () => {
    h = createPhase1Harness();
    const signalingOnly = await quickStart(h);
    h.cleanup();

    h = createP2PHarness();
    const direct = await quickStart(h);

    expect(direct).toEqual(signalingOnly);
    for (const events of [direct.a, direct.b] as { type: string }[][]) {
      expect(events.filter((e) => e.type === "error")).toEqual([]);
      expect(events.at(-1)).toMatchObject({ type: "closed", event: { reason: "left" } });
    }
  });
});

describe("upgrading from 0.3.0", () => {
  let h: EngineHarness | undefined;

  afterEach(() => {
    h?.cleanup();
    h = undefined;
  });

  it("a consumer written against 0.3.0 (no device options) compiles and captures the default devices", async () => {
    // The 0.3.0 method shapes; assigning to them proves the optional parameters stay compatible.
    type V030Media = { enableCamera(): Promise<void>; unmute(): Promise<void> };
    h = createPhase1Harness();
    const engine = h.createEngine({ role: "host" });
    await engine.join();
    const media: V030Media = engine;
    await media.enableCamera();
    await media.unmute();
    expect(h.media.constraints).toEqual([
      { video: true, audio: false },
      { audio: true, video: false },
    ]);
    expect(engine.localMediaState).toEqual({ camera: true, microphone: true, screen: false });
  });
});
