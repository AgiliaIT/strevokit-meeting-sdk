import { __setTestEnvironment } from "../../src/internal/env.js";
import type { MeetingEngine, MeetingEngineOptions, MeetingEventMap, MeetingEventType, ParticipantRole } from "../../src/public/types.js";
import { createMeetingEngine } from "../../src/createMeetingEngine.js";
import { FakeMediaDevices } from "./fakeMediaDevices.js";
import { FakeRealtime, testUlid } from "./fakeRealtime.js";

export const REALTIME_URL = "wss://realtime.example.com";

export type EngineOverrides = Partial<MeetingEngineOptions> & { role?: ParticipantRole; participantId?: string };

export interface EngineHarness {
  readonly realtime: FakeRealtime;
  readonly media: FakeMediaDevices;
  tokenFor(role?: ParticipantRole, participantId?: string): string;
  createEngine(overrides?: EngineOverrides): MeetingEngine;
  /** Dispose every engine created by this harness and restore the default environment. */
  cleanup(): void;
}

/** Installs the fake realtime service and media devices through the private environment seam. */
export function createPhase1Harness(): EngineHarness {
  const realtime = new FakeRealtime();
  const media = new FakeMediaDevices();
  const engines: MeetingEngine[] = [];
  __setTestEnvironment({
    WebSocket: realtime.WebSocket,
    mediaDevices: media,
    setTimeout: (callback, ms) => setTimeout(callback, ms),
    clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    now: () => Date.now(),
  });
  return {
    realtime,
    media,
    tokenFor: (role = "participant", participantId = testUlid()) => realtime.tokenFor(participantId, role),
    createEngine(overrides = {}) {
      const { role, participantId, ...options } = overrides;
      const engine = createMeetingEngine({
        token: realtime.tokenFor(participantId ?? testUlid(), role ?? "participant"),
        realtimeUrl: REALTIME_URL,
        ...options,
      });
      engines.push(engine);
      return engine;
    },
    cleanup() {
      for (const engine of engines) engine.dispose();
      __setTestEnvironment(undefined);
    },
  };
}

export type RecordedEvent = { [K in MeetingEventType]: { type: K; event: MeetingEventMap[K] } }[MeetingEventType];

const ALL_EVENTS: readonly MeetingEventType[] = [
  "state_changed",
  "joined",
  "participant_joined",
  "participant_left",
  "participant_reconnected",
  "participant_media_changed",
  "local_media_changed",
  "error",
  "closed",
];

/** Records every event an engine emits, in order. */
export function recordEvents(engine: MeetingEngine): RecordedEvent[] {
  const events: RecordedEvent[] = [];
  for (const type of ALL_EVENTS) {
    engine.on(type, (event) => events.push({ type, event } as RecordedEvent));
  }
  return events;
}

export function eventsOfType<K extends MeetingEventType>(events: RecordedEvent[], type: K): MeetingEventMap[K][] {
  return events.filter((entry) => entry.type === type).map((entry) => entry.event as MeetingEventMap[K]);
}
