import { parseSignalingMessage } from "@strevokit/signaling-protocol";
import { INVALID_SAMPLES, VALID_SAMPLES } from "@strevokit/signaling-protocol/conformance";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { __setTestEnvironment, currentEnvironment } from "../src/internal/env.js";
import { Log } from "../src/internal/log.js";
import { OUTBOUND_TYPES, SignalingSession } from "../src/internal/signalingSession.js";
import { flush, testUlid } from "./support/fakeRealtime.js";
import { type EngineHarness, createPhase1Harness, eventsOfType, recordEvents } from "./support/harness.js";

function toFrame(input: unknown, kind: "frame" | "value"): string {
  return kind === "frame" ? (input as string) : JSON.stringify(input);
}

/** Invalid samples that a server-to-client receiver must reject (some only fail in the other direction). */
const INBOUND_INVALID = INVALID_SAMPLES.filter((sample) => sample.direction !== "client_to_server");

let h: EngineHarness;

beforeEach(() => {
  h = createPhase1Harness();
});

afterEach(() => {
  expect(h.realtime.handlerErrors).toEqual([]);
  h.cleanup();
});

async function openSession() {
  const participantId = testUlid();
  const received: string[] = [];
  let protocolErrors = 0;
  const session = new SignalingSession({
    env: currentEnvironment(),
    realtimeUrl: "wss://realtime.example.com",
    token: h.realtime.tokenFor(participantId),
    addressing: { meetingId: h.realtime.meetingId, participantId },
    log: new Log(undefined),
    callbacks: {
      onMessage: (message) => received.push(message.type),
      onProtocolError: () => {
        protocolErrors += 1;
      },
      onClose: () => undefined,
    },
  });
  session.open();
  await flush();
  return { session, received, protocolErrors: () => protocolErrors, participantId };
}

describe("inbound conformance samples (session frame handler)", () => {
  it("handles every valid server-to-client sample without a protocol error", async () => {
    const { session, received, protocolErrors } = await openSession();
    const inbound = VALID_SAMPLES.filter((s) => s.allowedDirections.includes("server_to_client"));
    expect(inbound.length).toBeGreaterThan(20);
    for (const sample of inbound) h.realtime.send(JSON.stringify(sample.input));
    await flush();
    expect(protocolErrors()).toBe(0);
    expect(received.length).toBe(inbound.length + 1);
    session.close();
  });

  it("reports exactly one protocol error per invalid sample and never throws", async () => {
    const { session, received, protocolErrors } = await openSession();
    const before = received.length;
    for (const sample of INBOUND_INVALID) {
      const errorsBefore = protocolErrors();
      h.realtime.send(toFrame(sample.input, sample.inputKind));
      await flush();
      expect(protocolErrors(), sample.name).toBe(errorsBefore + 1);
    }
    expect(received.length).toBe(before);
    session.close();
  });
});

describe("inbound conformance samples (engine)", () => {
  it("emits one protocol_error event per invalid sample and stays joined", async () => {
    const engine = h.createEngine();
    await engine.join();
    const events = recordEvents(engine);
    for (const sample of INBOUND_INVALID) h.realtime.send(toFrame(sample.input, sample.inputKind));
    await flush();
    const errors = eventsOfType(events, "error");
    expect(errors).toHaveLength(INBOUND_INVALID.length);
    expect(new Set(errors.map((e) => e.error.code))).toEqual(new Set(["protocol_error"]));
    expect(engine.state).toBe("joined");
  });

  it.each(VALID_SAMPLES.filter((s) => s.allowedDirections.includes("server_to_client")).map((s) => [s.name, s] as const))(
    "handles or ignores valid sample %s",
    async (_name, sample) => {
      const engine = h.createEngine();
      await engine.join();
      const events = recordEvents(engine);
      h.realtime.send(JSON.stringify(sample.input));
      await flush();
      const unexpected = eventsOfType(events, "error").filter(
        (e) => !(sample.input.type === "session.rejected" && e.error.code === "protocol_error"),
      );
      expect(unexpected).toEqual([]);
    },
  );
});

describe("outbound frames", () => {
  it("builds every client frame so it passes client-to-server validation", async () => {
    const { session, participantId } = await openSession();
    const socket = h.realtime.socketFor(participantId);
    const before = socket.sent.length;
    for (const type of OUTBOUND_TYPES) expect(session.send(type)).toBe(true);
    const frames = socket.sent.slice(before);
    expect(frames).toHaveLength(OUTBOUND_TYPES.length);
    for (const frame of frames) {
      const result = parseSignalingMessage(JSON.parse(frame), { direction: "client_to_server" });
      expect(result.ok, frame).toBe(true);
    }
    expect([...OUTBOUND_TYPES].sort()).toEqual(
      [
        "media.camera.started",
        "media.camera.stopped",
        "media.microphone.started",
        "media.microphone.stopped",
        "media.screen.started",
        "media.screen.stopped",
        "participant.join",
        "participant.leave",
      ].sort(),
    );
    session.close();
  });

  it("never sends invalid frames during a full engine run", async () => {
    const engine = h.createEngine({ role: "host" });
    await engine.join();
    await engine.enableCamera();
    await engine.unmute();
    await engine.startScreenShare();
    await engine.stopScreenShare();
    await engine.mute();
    await engine.disableCamera();
    await engine.leave();
    expect(h.realtime.invalidClientFrames).toEqual([]);
  });
});

describe("environment seam", () => {
  it("restores the default environment when cleared", () => {
    __setTestEnvironment(undefined);
    expect(currentEnvironment().now()).toBeGreaterThan(0);
  });
});
