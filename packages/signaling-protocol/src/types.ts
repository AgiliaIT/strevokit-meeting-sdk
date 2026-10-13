import type { MessageType, ReceiveDirection } from "./catalog.js";
import type { SignalingRejection } from "./rejection.js";
import type { PROTOCOL_VERSION } from "./version.js";

export type Role = "host" | "participant";

/** Open reason code: documented known values plus any `^[a-z][a-z0-9_]{0,63}$` string. */
export type ReasonCode<Known extends string> = Known | (string & {});

export type EmptyPayload = Record<string, never>;

/** Mirrors the browser `RTCIceCandidateInit`. */
export type IceCandidate = {
  candidate: string;
  sdpMid: string | null;
  sdpMLineIndex: number | null;
  usernameFragment?: string | null;
};

/** How the platform delivers media for a meeting, chosen from the stored meeting. */
export type MediaMode = "p2p" | "sfu";

/** Mirrors the browser `RTCIceServer` with `urls` always an array. */
export type IceServerConfig = { urls: string[]; username?: string; credential?: string };

/** How an established media connection is carried; receivers must handle unknown codes generically. */
export type MediaPath = ReasonCode<"direct" | "relayed">;

/** Outcome of one attempt to move a connection onto a fresh network path. */
export type IceRestartOutcome = ReasonCode<"completed" | "failed">;

export type SessionDescriptionPayload = { targetParticipantId: string; sdp: string };
export type PeerPayload = { peerParticipantId: string };

export type PayloadMap = {
  "participant.join": EmptyPayload;
  "participant.joined": { role: Role; displayName?: string };
  "participant.leave": EmptyPayload;
  "participant.left": {
    reason: ReasonCode<"left" | "disconnected" | "removed" | "meeting_ended">;
  };
  "participant.reconnected": EmptyPayload;
  "webrtc.offer": SessionDescriptionPayload;
  "webrtc.answer": SessionDescriptionPayload;
  "webrtc.ice_candidate": { targetParticipantId: string; candidate: IceCandidate };
  "webrtc.connected": PeerPayload & {
    /** `relayed` when either side of the connection uses a relay. */
    path?: MediaPath;
    /** How the sender's own side of the connection is carried. */
    localPath?: MediaPath;
    /** How the other participant's side is carried, as seen by the sender. */
    remotePath?: MediaPath;
  };
  "webrtc.disconnected": PeerPayload;
  "webrtc.failed": PeerPayload & {
    reason: ReasonCode<"ice_failed" | "negotiation_failed" | "timeout">;
  };
  "webrtc.ice_restart": { targetParticipantId: string };
  "webrtc.ice_restart_result": PeerPayload & { outcome: IceRestartOutcome };
  "media.camera.started": EmptyPayload;
  "media.camera.stopped": EmptyPayload;
  "media.microphone.started": EmptyPayload;
  "media.microphone.stopped": EmptyPayload;
  "media.screen.started": EmptyPayload;
  "media.screen.stopped": EmptyPayload;
  "meeting.started": { startedAt: string };
  "meeting.ended": { endedAt: string; endedByParticipantId?: string };
  "meeting.terminated": {
    terminatedAt: string;
    reason: ReasonCode<"duration_limit" | "admin_action" | "policy" | "system">;
  };
  "session.authenticated": { role: Role };
  "session.welcome": {
    role: Role;
    joinedAt: string;
    displayName?: string;
    mediaMode?: MediaMode;
    iceServers?: IceServerConfig[];
    /** When the credentials in `iceServers` stop being accepted (RFC 3339 UTC). */
    iceServersExpireAt?: string;
  };
  "session.rejected": { code: ReasonCode<SessionRejectionCode>; detail?: string };
  "session.ice_servers": { iceServers: IceServerConfig[]; expiresAt: string };
};

/** Known `session.rejected.code` values; receivers must handle unknown codes generically. */
export type SessionRejectionCode =
  | "invalid_envelope"
  | "unsupported_version"
  | "unknown_type"
  | "direction_not_allowed"
  | "invalid_payload"
  | "not_joined"
  | "already_joined"
  | "identity_mismatch"
  | "role_not_allowed"
  | "target_not_present"
  | "rate_limited"
  | "service_unavailable";

type AssertExact<A, B> = [Exclude<A, B>, Exclude<B, A>] extends [never, never] ? true : never;
const payloadMapCoversCatalog: AssertExact<keyof PayloadMap, MessageType> = true;
void payloadMapCoversCatalog;

/** A validated signaling message; a discriminated union over `type`. */
export type SignalingMessage<T extends MessageType = MessageType> = {
  [K in T]: {
    version: typeof PROTOCOL_VERSION;
    type: K;
    meetingId: string;
    participantId: string;
    payload: PayloadMap[K];
  };
}[T];

export type ParseResult =
  | { ok: true; message: SignalingMessage }
  | { ok: false; error: SignalingRejection };

export type ParseOptions = {
  /** Direction the caller is receiving in; enables `direction_not_allowed` checks. */
  direction?: ReceiveDirection;
};
