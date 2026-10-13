import type { IceServerConfig, PayloadMap, SignalingMessage } from "@strevokit/signaling-protocol";
import type {
  MediaConnectionStatus,
  MediaKind,
  MediaState,
  MeetingEventMap,
  RemoteMedia,
} from "../public/types.js";
import type { PeerOutboundType } from "./signalingSession.js";

export type DeliveryEventType = "remote_media_changed" | "media_connection_changed" | "error";

export interface PresentPeer {
  readonly id: string;
  readonly media: MediaState;
}

/** What a media delivery strategy may use from the engine. */
export interface MediaDeliveryContext {
  /** Self. */
  readonly participantId: string;
  /** From `session.welcome`; may be empty. */
  readonly iceServers: readonly IceServerConfig[];
  /** Epoch ms when the credentials in `iceServers` expire; null when none were given. */
  readonly iceServersExpireAt: number | null;
  /** Sends a media frame through the signaling session. False when it could not be sent. */
  send<T extends PeerOutboundType>(type: T, payload: PayloadMap[T]): boolean;
  /** Emits a public engine event (suppressed after dispose). */
  emit<K extends DeliveryEventType>(type: K, event: MeetingEventMap[K]): void;
}

/**
 * Carries audio and video between participants. The engine reports roster facts, local capture changes and
 * media-negotiation frames here; strategies never change the public API.
 */
export interface MediaDelivery {
  attach(context: MediaDeliveryContext): void;
  /** Every other participant in the committed joined snapshot, reported together. */
  peersPresent(entries: readonly PresentPeer[]): void;
  /** A participant who joined after the joined snapshot was committed. */
  peerPresent(participantId: string, media: MediaState): void;
  peerMediaChanged(participantId: string, kind: MediaKind, enabled: boolean): void;
  peerLeft(participantId: string): void;
  peerReconnected(participantId: string): void;
  onPeerFrame(message: SignalingMessage): void;
  /** Fresh connectivity servers from the platform; `expiresAt` is epoch ms. */
  iceServersUpdated(iceServers: readonly IceServerConfig[], expiresAt: number): void;
  localMediaChanged(kind: MediaKind, stream: MediaStream | null): void;
  remoteMedia(participantId: string): RemoteMedia;
  connectionStatus(participantId: string): MediaConnectionStatus | null;
  /** Closes everything and emits nothing. Idempotent. */
  close(): void;
}

export const NO_REMOTE_MEDIA: RemoteMedia = Object.freeze({ camera: null, microphone: null, screen: null });

/** Announces local media state only; no remote media is delivered. */
export class SignalingOnlyMediaDelivery implements MediaDelivery {
  attach(): void {}

  peersPresent(): void {}

  peerPresent(): void {}

  peerMediaChanged(): void {}

  peerLeft(): void {}

  peerReconnected(): void {}

  onPeerFrame(): void {}

  iceServersUpdated(): void {}

  localMediaChanged(): void {}

  remoteMedia(): RemoteMedia {
    return NO_REMOTE_MEDIA;
  }

  connectionStatus(): MediaConnectionStatus | null {
    return null;
  }

  close(): void {}
}
