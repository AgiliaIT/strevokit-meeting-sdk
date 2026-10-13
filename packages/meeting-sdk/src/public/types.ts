import type { MeetingError } from "./errors.js";

/** Options for {@link createMeetingEngine}. */
export interface MeetingEngineOptions {
  /** Join token issued by your backend for this participant. Kept in memory only and never logged. */
  token: string;
  /**
   * Realtime service base URL, for example `wss://realtime.example.com`. `ws://` is accepted only for
   * `localhost` and `127.0.0.1`. No path, query, or fragment.
   */
  realtimeUrl: string;
  /** Milliseconds to wait for admission before `join()` rejects with `join_timeout`. Default 15000, range 1000–60000. */
  joinTimeoutMs?: number;
  /** Optional diagnostics sink. The SDK never passes the join token or raw exception text to it. */
  logger?: MeetingLogger;
}

/** Optional diagnostics sink. Every method is optional. */
export interface MeetingLogger {
  debug?(message: string, fields?: Readonly<Record<string, string | number | boolean>>): void;
  info?(message: string, fields?: Readonly<Record<string, string | number | boolean>>): void;
  warn?(message: string, fields?: Readonly<Record<string, string | number | boolean>>): void;
  error?(message: string, fields?: Readonly<Record<string, string | number | boolean>>): void;
}

/** Engine lifecycle state. `closed` is terminal: create a new engine to join again. */
export type ConnectionState = "idle" | "connecting" | "joining" | "joined" | "leaving" | "closed";

/** Role assigned by the platform when the join token was issued. */
export type ParticipantRole = "host" | "participant";

/** A kind of local or remote media. */
export type MediaKind = "camera" | "microphone" | "screen";

/** `true` means on: camera on, microphone unmuted, screen being shared. */
export interface MediaState {
  readonly camera: boolean;
  readonly microphone: boolean;
  readonly screen: boolean;
}

/** Another participant in the meeting. */
export interface Participant {
  /** Opaque participant ID. */
  readonly id: string;
  readonly role: ParticipantRole;
  readonly displayName?: string;
  readonly media: MediaState;
}

/** The participant using this engine. */
export interface SelfParticipant {
  /** Opaque participant ID. */
  readonly id: string;
  readonly role: ParticipantRole;
  readonly displayName?: string;
  /** ISO-8601 UTC timestamp from the platform. */
  readonly joinedAt: string;
}

/** Local captures available for rendering, such as a self-preview. `null` when that capture is off. */
export interface LocalMedia {
  readonly camera: MediaStream | null;
  readonly microphone: MediaStream | null;
  readonly screen: MediaStream | null;
}

/**
 * Which device to use for {@link MeetingEngine.enableCamera} or {@link MeetingEngine.unmute}. Omit `deviceId` to use
 * the browser's default device.
 */
export interface MediaDeviceOptions {
  /** A `deviceId` from `navigator.mediaDevices.enumerateDevices()`. */
  readonly deviceId?: string;
}

/** Status of the audio and video connection to another participant. */
export type MediaConnectionStatus = "connecting" | "connected" | "interrupted" | "failed";

/** Media received from another participant, for rendering. `null` when that media is not available. */
export interface RemoteMedia {
  readonly camera: MediaStream | null;
  readonly microphone: MediaStream | null;
  /** Always `null` in this version. */
  readonly screen: MediaStream | null;
}

/** Why another participant left. Unknown platform reasons are reported as `"other"`. */
export type ParticipantLeftReason = "left" | "disconnected" | "removed" | "meeting_ended" | "other";

/** Why the engine closed. */
export type CloseReason = "left" | "meeting_ended" | "session_replaced" | "connection_lost" | "join_failed" | "error";

/**
 * Payload of every event, keyed by event type. New event types may be added in minor versions, so do not
 * treat this map as closed.
 */
export interface MeetingEventMap {
  state_changed: { readonly state: ConnectionState; readonly previous: ConnectionState };
  joined: { readonly self: SelfParticipant; readonly participants: readonly Participant[] };
  participant_joined: { readonly participant: Participant };
  participant_left: { readonly participantId: string; readonly reason: ParticipantLeftReason };
  participant_reconnected: { readonly participantId: string };
  participant_media_changed: { readonly participantId: string; readonly kind: MediaKind; readonly enabled: boolean };
  local_media_changed: { readonly kind: MediaKind; readonly enabled: boolean; readonly stream: MediaStream | null };
  /** Media from another participant became available (`stream`) or stopped being available (`null`). */
  remote_media_changed: { readonly participantId: string; readonly kind: MediaKind; readonly stream: MediaStream | null };
  /** The audio and video connection to another participant changed. `null`: there is no connection any more. */
  media_connection_changed: { readonly participantId: string; readonly status: MediaConnectionStatus | null };
  error: { readonly error: MeetingError };
  closed: { readonly reason: CloseReason; readonly error?: MeetingError };
}

/** Name of an engine event. */
export type MeetingEventType = keyof MeetingEventMap;

/** Listener for one event type. */
export type MeetingEventListener<K extends MeetingEventType> = (event: MeetingEventMap[K]) => void;

/** A meeting session for one participant. One engine joins at most once. */
export interface MeetingEngine {
  /** Current lifecycle state. */
  readonly state: ConnectionState;
  /** Set once `joined` fires; `null` before. */
  readonly self: SelfParticipant | null;
  /** Other participants currently present (never includes self). */
  readonly participants: readonly Participant[];
  /** Current local media state. */
  readonly localMediaState: MediaState;
  /** Current local captures, for rendering. */
  readonly localMedia: LocalMedia;

  /** Media currently received from a participant. All fields are `null` when nothing is available. */
  remoteMedia(participantId: string): RemoteMedia;
  /** Status of the audio and video connection to a participant, or `null` when there is none. */
  mediaConnectionStatus(participantId: string): MediaConnectionStatus | null;

  /** Connect and join the meeting. Resolves once admitted and the participant list is known. */
  join(): Promise<void>;
  /** Leave the meeting and release every device. Never rejects. */
  leave(): Promise<void>;

  /**
   * Start the camera. With `options.deviceId`, use that camera; when the camera is already on with another device,
   * switch to it without turning the camera off. Rejects with `device_not_found` when the device is missing, leaving
   * the current camera running.
   */
  enableCamera(options?: MediaDeviceOptions): Promise<void>;
  /** Stop the camera and release it. */
  disableCamera(): Promise<void>;
  /** Mute the microphone. */
  mute(): Promise<void>;
  /**
   * Unmute the microphone, capturing it on first use. With `options.deviceId`, use that microphone; when it is already
   * unmuted with another device, switch to it without muting. Rejects with `device_not_found` when the device is
   * missing, leaving the current microphone running.
   */
  unmute(options?: MediaDeviceOptions): Promise<void>;
  /** Start sharing the screen. Only hosts may share. */
  startScreenShare(): Promise<void>;
  /** Stop sharing the screen. */
  stopScreenShare(): Promise<void>;

  /** Subscribe to one event type. Returns an unsubscribe function. */
  on<K extends MeetingEventType>(type: K, listener: MeetingEventListener<K>): () => void;
  /** Release everything immediately: devices, connection, listeners. Emits nothing. Idempotent. */
  dispose(): void;
}
