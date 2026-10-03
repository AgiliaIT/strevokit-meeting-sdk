import type { SignalingMessage } from "@strevokit/signaling-protocol";
import type { MediaKind } from "../public/types.js";

/** What a media delivery strategy may use from the engine's signaling connection. */
export interface MediaDeliveryContext {
  readonly participantId: string;
}

/**
 * Carries audio and video between participants. The engine reports local capture changes and forwards
 * media-negotiation frames here; strategies never change the public API.
 */
export interface MediaDelivery {
  attach(context: MediaDeliveryContext): void;
  onPeerFrame(message: SignalingMessage): void;
  localMediaChanged(kind: MediaKind, stream: MediaStream | null): void;
  close(): void;
}

/** Announces local media state only; no remote media is delivered. */
export class SignalingOnlyMediaDelivery implements MediaDelivery {
  attach(): void {}

  onPeerFrame(): void {}

  localMediaChanged(): void {}

  close(): void {}
}
