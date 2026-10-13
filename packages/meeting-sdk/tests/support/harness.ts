import type { IceServerConfig, MediaMode } from "@strevokit/signaling-protocol";
import { type MediaStreamConstructor, type PeerConnectionConstructor, __setTestEnvironment } from "../../src/internal/env.js";
import type { MeetingEngine, MeetingEngineOptions, MeetingEventMap, MeetingEventType, ParticipantRole } from "../../src/public/types.js";
import { createMeetingEngine } from "../../src/createMeetingEngine.js";
import { FakeMediaDevices } from "./fakeMediaDevices.js";
import { FakeMediaStream, FakePeerNetwork } from "./fakePeerConnection.js";
import { FakeRealtime, testUlid } from "./fakeRealtime.js";

export const REALTIME_URL = "wss://realtime.example.com";

export type EngineOverrides = Partial<MeetingEngineOptions> & { role?: ParticipantRole; participantId?: string };

export interface EngineHarness {
  readonly realtime: FakeRealtime;
  readonly media: FakeMediaDevices;
  readonly network: FakePeerNetwork;
  tokenFor(role?: ParticipantRole, participantId?: string): string;
  createEngine(overrides?: EngineOverrides): MeetingEngine;
  /** Dispose every engine created by this harness and restore the default environment. */
  cleanup(): void;
}

export type HarnessOptions = {
  /** Sent on every welcome. Default: none (signaling only). */
  mediaMode?: MediaMode;
  iceServers?: IceServerConfig[];
  /** Sent on every welcome with `iceServers`: when their credentials expire. */
  iceServersExpireAt?: string;
  /** Install the fake `RTCPeerConnection` and `MediaStream`. Default true. */
  peerConnections?: boolean;
};

/** Installs the fake realtime service, media devices and peer connections through the private environment seam. */
export function createHarness(options: HarnessOptions = {}): EngineHarness {
  const realtime = new FakeRealtime();
  realtime.welcomeMediaMode = options.mediaMode;
  realtime.welcomeIceServers = options.iceServers;
  realtime.welcomeIceServersExpireAt = options.iceServersExpireAt;
  const media = new FakeMediaDevices();
  const network = new FakePeerNetwork();
  const engines: MeetingEngine[] = [];
  const withPeers = options.peerConnections ?? true;
  __setTestEnvironment({
    WebSocket: realtime.WebSocket,
    mediaDevices: media,
    RTCPeerConnection: withPeers ? (network.RTCPeerConnection as unknown as PeerConnectionConstructor) : undefined,
    MediaStream: withPeers ? (FakeMediaStream as unknown as MediaStreamConstructor) : undefined,
    setTimeout: (callback, ms) => setTimeout(callback, ms),
    clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    now: () => Date.now(),
  });
  return {
    realtime,
    media,
    network,
    tokenFor: (role = "participant", participantId = testUlid()) => realtime.tokenFor(participantId, role),
    createEngine(overrides = {}) {
      const { role, participantId, ...engineOptions } = overrides;
      const engine = createMeetingEngine({
        token: realtime.tokenFor(participantId ?? testUlid(), role ?? "participant"),
        realtimeUrl: REALTIME_URL,
        ...engineOptions,
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

/** Phase 1 behaviour: welcomes carry no media mode, so engines use signaling only. */
export function createPhase1Harness(): EngineHarness {
  return createHarness();
}

/** Welcomes select direct media between the two participants. */
export function createP2PHarness(options: Omit<HarnessOptions, "mediaMode"> = {}): EngineHarness {
  return createHarness({ iceServers: [], ...options, mediaMode: "p2p" });
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

const MEDIA_EVENTS: readonly MeetingEventType[] = ["remote_media_changed", "media_connection_changed"];

/** Records every 0.1.0 event an engine emits, in order. Pass `{ media: true }` to include remote media events. */
export function recordEvents(engine: MeetingEngine, options: { media?: boolean } = {}): RecordedEvent[] {
  const events: RecordedEvent[] = [];
  const types = options.media ? [...ALL_EVENTS, ...MEDIA_EVENTS] : ALL_EVENTS;
  for (const type of types) {
    engine.on(type, (event) => events.push({ type, event } as RecordedEvent));
  }
  return events;
}

export function eventsOfType<K extends MeetingEventType>(events: RecordedEvent[], type: K): MeetingEventMap[K][] {
  return events.filter((entry) => entry.type === type).map((entry) => entry.event as MeetingEventMap[K]);
}
