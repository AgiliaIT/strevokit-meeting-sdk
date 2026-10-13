import type { MessageType } from "./catalog.js";
import {
  MAX_DISPLAY_NAME_CODE_POINTS,
  MAX_ICE_CANDIDATE_LENGTH,
  MAX_ICE_SERVER_CREDENTIAL_LENGTH,
  MAX_ICE_SERVER_URL_LENGTH,
  MAX_ICE_SERVER_URLS,
  MAX_ICE_SERVER_USERNAME_LENGTH,
  MAX_ICE_SERVERS,
  MAX_REASON_LENGTH,
  MAX_SDP_BYTES,
  MAX_SDP_MID_LENGTH,
  MAX_SDP_MLINE_INDEX,
  MAX_USERNAME_FRAGMENT_LENGTH,
} from "./limits.js";
import {
  codePointLength,
  hasOwn,
  isCanonicalUlid,
  isPlainObject,
  isReasonCode,
  isRfc3339UtcTimestamp,
  utf8ByteLength,
} from "./primitives.js";
import { type RejectionDetail, type SignalingRejection, reject } from "./rejection.js";

export type PayloadContext = { participantId: string };

export type PayloadResult =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; rejection: SignalingRejection };

class PayloadFailure {
  constructor(readonly rejection: SignalingRejection) {}
}

function fail(detail: RejectionDetail, path: string): never {
  throw new PayloadFailure(reject("invalid_payload", detail, path));
}

type Obj = Record<string, unknown>;

function required(obj: Obj, key: string, path: string): unknown {
  if (!hasOwn(obj, key)) fail("missing_field", path);
  return obj[key];
}

function requiredString(obj: Obj, key: string, path: string): string {
  const value = required(obj, key, path);
  if (typeof value !== "string") fail("wrong_type", path);
  return value;
}

function participantRef(
  obj: Obj,
  key: string,
  path: string,
  ctx: PayloadContext,
  allowSelf: boolean,
): string {
  const value = requiredString(obj, key, path);
  if (!isCanonicalUlid(value)) fail("invalid_ulid", path);
  if (!allowSelf && value === ctx.participantId) fail("invalid_format", path);
  return value;
}

function reasonCode(obj: Obj, key: string, path: string): string {
  const value = requiredString(obj, key, path);
  if (value.length > MAX_REASON_LENGTH) fail("too_long", path);
  if (!isReasonCode(value)) fail("invalid_format", path);
  return value;
}

function timestamp(obj: Obj, key: string, path: string): string {
  const value = requiredString(obj, key, path);
  if (!isRfc3339UtcTimestamp(value)) fail("invalid_format", path);
  return value;
}

function sdp(obj: Obj): string {
  const path = "payload.sdp";
  const value = requiredString(obj, "sdp", path);
  if (value.length === 0) fail("invalid_format", path);
  if (value.length > MAX_SDP_BYTES) fail("too_long", path);
  if (value.length * 3 > MAX_SDP_BYTES && utf8ByteLength(value) > MAX_SDP_BYTES) {
    fail("too_long", path);
  }
  return value;
}

function nullableString(obj: Obj, key: string, path: string, maxLength: number): string | null {
  const value = obj[key];
  if (value === null) return null;
  if (typeof value !== "string") fail("wrong_type", path);
  if (value.length > maxLength) fail("too_long", path);
  return value;
}

function iceCandidate(obj: Obj): Obj {
  const base = "payload.candidate";
  const raw = required(obj, "candidate", base);
  if (!isPlainObject(raw)) fail("wrong_type", base);

  const candidate = requiredString(raw, "candidate", `${base}.candidate`);
  if (candidate.length > MAX_ICE_CANDIDATE_LENGTH) fail("too_long", `${base}.candidate`);

  required(raw, "sdpMid", `${base}.sdpMid`);
  const sdpMid = nullableString(raw, "sdpMid", `${base}.sdpMid`, MAX_SDP_MID_LENGTH);

  const indexPath = `${base}.sdpMLineIndex`;
  const index = required(raw, "sdpMLineIndex", indexPath);
  let sdpMLineIndex: number | null = null;
  if (index !== null) {
    if (typeof index !== "number") fail("wrong_type", indexPath);
    if (!Number.isInteger(index) || index < 0 || index > MAX_SDP_MLINE_INDEX) {
      fail("out_of_range", indexPath);
    }
    sdpMLineIndex = index;
  }

  if (candidate.length > 0 && sdpMid === null && sdpMLineIndex === null) {
    fail("invalid_format", base);
  }

  const value: Obj = { candidate, sdpMid, sdpMLineIndex };
  if (hasOwn(raw, "usernameFragment")) {
    value.usernameFragment = nullableString(
      raw,
      "usernameFragment",
      `${base}.usernameFragment`,
      MAX_USERNAME_FRAGMENT_LENGTH,
    );
  }
  return value;
}

type Validator = (payload: Obj, ctx: PayloadContext) => Obj;

const empty: Validator = () => ({});

const sessionDescription: Validator = (p, ctx) => ({
  targetParticipantId: participantRef(p, "targetParticipantId", "payload.targetParticipantId", ctx, false),
  sdp: sdp(p),
});

const peer: Validator = (p, ctx) => ({
  peerParticipantId: participantRef(p, "peerParticipantId", "payload.peerParticipantId", ctx, false),
});

function role(obj: Obj): string {
  const value = requiredString(obj, "role", "payload.role");
  if (value !== "host" && value !== "participant") fail("invalid_format", "payload.role");
  return value;
}

function optionalDisplayName(p: Obj, value: Obj): Obj {
  if (hasOwn(p, "displayName")) {
    const path = "payload.displayName";
    const displayName = p.displayName;
    if (typeof displayName !== "string") fail("wrong_type", path);
    if (displayName.length === 0) fail("invalid_format", path);
    if (codePointLength(displayName) > MAX_DISPLAY_NAME_CODE_POINTS) fail("too_long", path);
    value.displayName = displayName;
  }
  return value;
}

const ICE_SERVER_URL_SCHEMES = ["stun:", "stuns:", "turn:", "turns:"] as const;

function optionalBoundedString(obj: Obj, key: string, path: string, maxLength: number, value: Obj): void {
  if (!hasOwn(obj, key)) return;
  const raw = obj[key];
  if (typeof raw !== "string") fail("wrong_type", path);
  if (raw.length > maxLength) fail("too_long", path);
  value[key] = raw;
}

function iceServer(raw: unknown, path: string): Obj {
  if (!isPlainObject(raw)) fail("wrong_type", path);
  const urlsPath = `${path}.urls`;
  const urls = required(raw, "urls", urlsPath);
  if (!Array.isArray(urls)) fail("wrong_type", urlsPath);
  if (urls.length === 0 || urls.length > MAX_ICE_SERVER_URLS) fail("out_of_range", urlsPath);
  const checked = urls.map((url: unknown, index) => {
    const urlPath = `${urlsPath}.${index}`;
    if (typeof url !== "string") fail("wrong_type", urlPath);
    if (url.length > MAX_ICE_SERVER_URL_LENGTH) fail("too_long", urlPath);
    if (!ICE_SERVER_URL_SCHEMES.some((scheme) => url.startsWith(scheme) && url.length > scheme.length)) {
      fail("invalid_format", urlPath);
    }
    return url;
  });
  const value: Obj = { urls: checked };
  optionalBoundedString(raw, "username", `${path}.username`, MAX_ICE_SERVER_USERNAME_LENGTH, value);
  optionalBoundedString(raw, "credential", `${path}.credential`, MAX_ICE_SERVER_CREDENTIAL_LENGTH, value);
  return value;
}

function iceServers(obj: Obj): Obj[] {
  const path = "payload.iceServers";
  const servers = required(obj, "iceServers", path);
  if (!Array.isArray(servers)) fail("wrong_type", path);
  if (servers.length > MAX_ICE_SERVERS) fail("too_long", path);
  return servers.map((server: unknown, index) => iceServer(server, `${path}.${index}`));
}

function sessionWelcome(p: Obj): Obj {
  const value = optionalDisplayName(p, {
    role: role(p),
    joinedAt: timestamp(p, "joinedAt", "payload.joinedAt"),
  });
  if (hasOwn(p, "mediaMode")) {
    const path = "payload.mediaMode";
    const mediaMode = p.mediaMode;
    if (typeof mediaMode !== "string") fail("wrong_type", path);
    if (mediaMode !== "p2p" && mediaMode !== "sfu") fail("invalid_format", path);
    value.mediaMode = mediaMode;
  }
  if (hasOwn(p, "iceServers")) value.iceServers = iceServers(p);
  if (hasOwn(p, "iceServersExpireAt")) {
    value.iceServersExpireAt = timestamp(p, "iceServersExpireAt", "payload.iceServersExpireAt");
  }
  return value;
}

const VALIDATORS: Record<MessageType, Validator> = {
  "participant.join": empty,
  "participant.joined": (p) => optionalDisplayName(p, { role: role(p) }),
  "participant.leave": empty,
  "participant.left": (p) => ({ reason: reasonCode(p, "reason", "payload.reason") }),
  "participant.reconnected": empty,
  "webrtc.offer": sessionDescription,
  "webrtc.answer": sessionDescription,
  "webrtc.ice_candidate": (p, ctx) => ({
    targetParticipantId: participantRef(p, "targetParticipantId", "payload.targetParticipantId", ctx, false),
    candidate: iceCandidate(p),
  }),
  "webrtc.connected": (p, ctx) => {
    const value = peer(p, ctx);
    for (const key of ["path", "localPath", "remotePath"] as const) {
      if (hasOwn(p, key)) value[key] = reasonCode(p, key, `payload.${key}`);
    }
    return value;
  },
  "webrtc.disconnected": peer,
  "webrtc.failed": (p, ctx) => ({
    ...peer(p, ctx),
    reason: reasonCode(p, "reason", "payload.reason"),
  }),
  "webrtc.ice_restart": (p, ctx) => ({
    targetParticipantId: participantRef(p, "targetParticipantId", "payload.targetParticipantId", ctx, false),
  }),
  "webrtc.ice_restart_result": (p, ctx) => ({
    ...peer(p, ctx),
    outcome: reasonCode(p, "outcome", "payload.outcome"),
  }),
  "media.camera.started": empty,
  "media.camera.stopped": empty,
  "media.microphone.started": empty,
  "media.microphone.stopped": empty,
  "media.screen.started": empty,
  "media.screen.stopped": empty,
  "meeting.started": (p) => ({ startedAt: timestamp(p, "startedAt", "payload.startedAt") }),
  "meeting.ended": (p, ctx) => {
    const value: Obj = { endedAt: timestamp(p, "endedAt", "payload.endedAt") };
    if (hasOwn(p, "endedByParticipantId")) {
      value.endedByParticipantId = participantRef(
        p,
        "endedByParticipantId",
        "payload.endedByParticipantId",
        ctx,
        true,
      );
    }
    return value;
  },
  "meeting.terminated": (p) => ({
    terminatedAt: timestamp(p, "terminatedAt", "payload.terminatedAt"),
    reason: reasonCode(p, "reason", "payload.reason"),
  }),
  "session.authenticated": (p) => ({ role: role(p) }),
  "session.welcome": sessionWelcome,
  "session.rejected": (p) => {
    const value: Obj = { code: reasonCode(p, "code", "payload.code") };
    if (hasOwn(p, "detail")) value.detail = reasonCode(p, "detail", "payload.detail");
    return value;
  },
  "session.ice_servers": (p) => ({
    iceServers: iceServers(p),
    expiresAt: timestamp(p, "expiresAt", "payload.expiresAt"),
  }),
};

/**
 * Validate a payload for `type`. Builds a fresh object with documented fields only,
 * so unknown fields and hostile keys are never copied.
 */
export function validatePayload(
  type: MessageType,
  payload: Obj,
  ctx: PayloadContext,
): PayloadResult {
  try {
    return { ok: true, value: VALIDATORS[type](payload, ctx) };
  } catch (error) {
    if (error instanceof PayloadFailure) return { ok: false, rejection: error.rejection };
    throw error;
  }
}
