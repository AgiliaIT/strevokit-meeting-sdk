/**
 * Shared conformance samples for every consumer's test suite (package, realtime, SDK).
 * Test-only entry point: `@strevokit/signaling-protocol/conformance`. The core never imports it.
 */

import { type ReceiveDirection, MESSAGE_CATALOG, isDirectionAllowed, isMessageType } from "../catalog.js";
import { MAX_DISPLAY_NAME_CODE_POINTS, MAX_MESSAGE_BYTES, MAX_SDP_BYTES } from "../limits.js";
import type { RejectionCode, RejectionDetail } from "../rejection.js";
import type { MessageType } from "../catalog.js";
import { SDP_FIXTURES } from "./sdp-fixtures.js";

export { SDP_FIXTURES } from "./sdp-fixtures.js";

export type ValidSample = {
  name: string;
  input: Record<string, unknown>;
  allowedDirections: readonly ReceiveDirection[];
};

export type InvalidSample = {
  name: string;
  /** A value for `parseSignalingMessage`, or a raw frame string for `decodeSignalingFrame`. */
  input: unknown;
  inputKind: "frame" | "value";
  /** When set, validate with this direction. */
  direction?: ReceiveDirection;
  expectedCode: RejectionCode;
  expectedDetail?: RejectionDetail;
  expectedField?: string;
};

const MEETING = "01JQBBBBBBBBBBBBBBBBBBBBBB";
const ALICE = "01JQCCCCCCCCCCCCCCCCCCCCCC";
const BOB = "01JQDDDDDDDDDDDDDDDDDDDDDD";
const SMALL_SDP =
  "v=0\r\no=- 4611731400430051336 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\na=group:BUNDLE 0\r\n" +
  "m=audio 9 UDP/TLS/RTP/SAVPF 111\r\nc=IN IP4 0.0.0.0\r\na=mid:0\r\na=rtpmap:111 opus/48000/2\r\n";

function msg(type: string, payload: unknown, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { version: 1, type, meetingId: MEETING, participantId: ALICE, payload, ...overrides };
}

function directionsFor(type: MessageType): readonly ReceiveDirection[] {
  const direction = MESSAGE_CATALOG[type].direction;
  return direction === "both" ? ["client_to_server", "server_to_client"] : [direction];
}

function valid(name: string, type: MessageType, payload: Record<string, unknown>, overrides?: Record<string, unknown>): ValidSample {
  return { name, input: msg(type, payload, overrides), allowedDirections: directionsFor(type) };
}

const candidate = {
  candidate: "candidate:842163049 1 udp 1677729535 203.0.113.7 46154 typ srflx raddr 0.0.0.0 rport 0 generation 0",
  sdpMid: "0",
  sdpMLineIndex: 0,
  usernameFragment: "EsEl",
};

export const VALID_SAMPLES: readonly ValidSample[] = Object.freeze([
  valid("participant.join", "participant.join", {}),
  valid("participant.joined with displayName", "participant.joined", { role: "host", displayName: "Zoë Müller" }),
  valid("participant.joined without displayName", "participant.joined", { role: "participant" }),
  valid("participant.leave", "participant.leave", {}),
  valid("participant.left", "participant.left", { reason: "left" }),
  valid("participant.left unknown well-formed reason", "participant.left", { reason: "future_reason" }),
  valid("participant.reconnected", "participant.reconnected", {}),
  valid("webrtc.offer small", "webrtc.offer", { targetParticipantId: BOB, sdp: SMALL_SDP }),
  valid("webrtc.answer small", "webrtc.answer", { targetParticipantId: BOB, sdp: SMALL_SDP }),
  ...Object.entries(SDP_FIXTURES).flatMap(([fixture, sdp]) => [
    valid(`webrtc.offer ${fixture}`, "webrtc.offer", { targetParticipantId: BOB, sdp }),
    valid(`webrtc.answer ${fixture}`, "webrtc.answer", { targetParticipantId: BOB, sdp }),
  ]),
  valid("webrtc.ice_candidate full", "webrtc.ice_candidate", { targetParticipantId: BOB, candidate }),
  valid("webrtc.ice_candidate end-of-candidates", "webrtc.ice_candidate", {
    targetParticipantId: BOB,
    candidate: { candidate: "", sdpMid: null, sdpMLineIndex: null },
  }),
  valid("webrtc.connected", "webrtc.connected", { peerParticipantId: BOB }),
  valid("webrtc.disconnected", "webrtc.disconnected", { peerParticipantId: BOB }),
  valid("webrtc.failed", "webrtc.failed", { peerParticipantId: BOB, reason: "ice_failed" }),
  valid("media.camera.started", "media.camera.started", {}),
  valid("media.camera.stopped", "media.camera.stopped", {}),
  valid("media.microphone.started", "media.microphone.started", {}),
  valid("media.microphone.stopped", "media.microphone.stopped", {}),
  valid("media.screen.started", "media.screen.started", {}),
  valid("media.screen.stopped", "media.screen.stopped", {}),
  valid("meeting.started", "meeting.started", { startedAt: "2026-09-28T10:00:00Z" }),
  valid("meeting.ended", "meeting.ended", { endedAt: "2026-09-28T11:00:00.250Z", endedByParticipantId: BOB }),
  valid("meeting.terminated", "meeting.terminated", { terminatedAt: "2026-09-28T11:30:00Z", reason: "duration_limit" }),
  valid("session.authenticated", "session.authenticated", { role: "participant" }),
  valid("session.welcome", "session.welcome", { role: "host", joinedAt: "2026-09-28T10:00:12.000Z" }),
  valid("session.welcome with displayName", "session.welcome", {
    role: "participant",
    joinedAt: "2026-09-28T10:00:12.000Z",
    displayName: "Zoë Müller",
  }),
  valid("session.rejected", "session.rejected", { code: "target_not_present" }),
  valid("session.rejected with detail", "session.rejected", { code: "invalid_envelope", detail: "message_too_large" }),
  valid("extra envelope and payload fields are ignored", "webrtc.offer",
    { targetParticipantId: BOB, sdp: SMALL_SDP, futureField: { nested: true } },
    { tenantId: "01JQAAAAAAAAAAAAAAAAAAAAAA", extra: 1 }),
  valid("conflicting meetingId inside payload is ignored", "media.camera.started", { meetingId: "01JQEEEEEEEEEEEEEEEEEEEEEE" }),
  {
    name: "hostile __proto__ keys are ignored",
    input: JSON.parse(
      `{"__proto__":{"polluted":true},"version":1,"type":"participant.leave","meetingId":"${MEETING}","participantId":"${ALICE}","payload":{"__proto__":{"polluted":true}}}`,
    ) as Record<string, unknown>,
    allowedDirections: directionsFor("participant.leave"),
  },
]);

function invalidValue(
  name: string,
  input: unknown,
  expectedCode: RejectionCode,
  expectedDetail?: RejectionDetail,
  expectedField?: string,
  direction?: ReceiveDirection,
): InvalidSample {
  const sample: InvalidSample = { name, input, inputKind: "value", expectedCode };
  if (expectedDetail !== undefined) sample.expectedDetail = expectedDetail;
  if (expectedField !== undefined) sample.expectedField = expectedField;
  if (direction !== undefined) sample.direction = direction;
  return sample;
}

function invalidFrame(name: string, input: string, expectedDetail: RejectionDetail): InvalidSample {
  return { name, input, inputKind: "frame", expectedCode: "invalid_envelope", expectedDetail };
}

function withoutKey(obj: Record<string, unknown>, key: string): Record<string, unknown> {
  const copy = { ...obj };
  delete copy[key];
  return copy;
}

const join = msg("participant.join", {});

function paddedFrame(targetBytes: number, char: string, bytesPerChar: number): string {
  const skeleton = JSON.stringify({ ...join, pad: "" });
  const count = Math.ceil((targetBytes - skeleton.length) / bytesPerChar);
  return JSON.stringify({ ...join, pad: char.repeat(count) });
}

export const INVALID_SAMPLES: readonly InvalidSample[] = Object.freeze([
  // Frame-level
  invalidFrame("frame is not JSON", "{oops", "invalid_json"),
  invalidFrame("frame is empty", "", "invalid_json"),
  invalidFrame("frame is truncated JSON", JSON.stringify(join).slice(0, 40), "invalid_json"),
  invalidFrame("frame over MAX_MESSAGE_BYTES (ASCII)", paddedFrame(MAX_MESSAGE_BYTES + 1, "p", 1), "message_too_large"),
  invalidFrame("frame over MAX_MESSAGE_BYTES in UTF-8 bytes only", paddedFrame(MAX_MESSAGE_BYTES + 3, "€", 3), "message_too_large"),

  // Top-level shape
  invalidValue("number instead of object", 42, "invalid_envelope", "not_an_object"),
  invalidValue("string instead of object", "participant.join", "invalid_envelope", "not_an_object"),
  invalidValue("array instead of object", [join], "invalid_envelope", "not_an_object"),
  invalidValue("null instead of object", null, "invalid_envelope", "not_an_object"),
  invalidValue("boolean instead of object", true, "invalid_envelope", "not_an_object"),

  // Version
  invalidValue("missing version", withoutKey(join, "version"), "unsupported_version", undefined, "version"),
  invalidValue("version as text", { ...join, version: "1" }, "unsupported_version", undefined, "version"),
  invalidValue("fractional version", { ...join, version: 1.5 }, "unsupported_version", undefined, "version"),
  invalidValue("version zero", { ...join, version: 0 }, "unsupported_version", undefined, "version"),
  invalidValue("negative version", { ...join, version: -1 }, "unsupported_version", undefined, "version"),
  invalidValue("future version", { ...join, version: 2 }, "unsupported_version", undefined, "version"),
  invalidValue("future version with reshaped envelope", { version: 2, kind: "participant.join", room: MEETING }, "unsupported_version"),

  // Type
  invalidValue("unknown type", msg("participant.teleport", {}), "unknown_type", undefined, "type"),
  invalidValue("reserved SFU family", msg("sfu.producer.created", {}), "unknown_type", undefined, "type"),
  invalidValue("reserved recording family", msg("recording.started", {}), "unknown_type", undefined, "type"),
  invalidValue("heartbeat is not a protocol type", msg("ping", {}), "unknown_type", undefined, "type"),
  invalidValue("empty type", msg("", {}), "unknown_type", undefined, "type"),
  invalidValue("type with different casing", msg("Participant.Join", {}), "unknown_type", undefined, "type"),
  invalidValue("type with trailing space", msg("participant.join ", {}), "unknown_type", undefined, "type"),
  invalidValue("type with doubled dot", msg("participant..join", {}), "unknown_type", undefined, "type"),
  invalidValue("prototype key as type", msg("constructor", {}), "unknown_type", undefined, "type"),
  invalidValue("missing type", withoutKey(join, "type"), "unknown_type", undefined, "type"),

  // Direction
  invalidValue("client sends meeting.ended", msg("meeting.ended", { endedAt: "2026-09-28T11:00:00Z" }),
    "direction_not_allowed", undefined, "type", "client_to_server"),
  invalidValue("client sends participant.joined", msg("participant.joined", { role: "host" }),
    "direction_not_allowed", undefined, "type", "client_to_server"),
  invalidValue("server sends participant.join", join, "direction_not_allowed", undefined, "type", "server_to_client"),
  invalidValue("client sends session.welcome", msg("session.welcome", { role: "host", joinedAt: "2026-09-28T10:00:00Z" }),
    "direction_not_allowed", undefined, "type", "client_to_server"),
  invalidValue("client sends session.rejected", msg("session.rejected", { code: "not_joined" }),
    "direction_not_allowed", undefined, "type", "client_to_server"),

  // Envelope fields
  invalidValue("lowercase meetingId", { ...join, meetingId: MEETING.toLowerCase() }, "invalid_envelope", "invalid_ulid", "meetingId"),
  invalidValue("numeric-string meetingId (internal id)", { ...join, meetingId: "12345" }, "invalid_envelope", "invalid_ulid", "meetingId"),
  invalidValue("numeric meetingId", { ...join, meetingId: 12345 }, "invalid_envelope", "invalid_ulid", "meetingId"),
  invalidValue("missing participantId", withoutKey(join, "participantId"), "invalid_envelope", "invalid_ulid", "participantId"),
  invalidValue("empty participantId", { ...join, participantId: "" }, "invalid_envelope", "invalid_ulid", "participantId"),
  invalidValue("missing payload", withoutKey(join, "payload"), "invalid_envelope", "payload_not_object", "payload"),
  invalidValue("array payload", { ...join, payload: [] }, "invalid_envelope", "payload_not_object", "payload"),
  invalidValue("null payload", { ...join, payload: null }, "invalid_envelope", "payload_not_object", "payload"),
  invalidValue("string payload on payload-less type", msg("participant.leave", "bye"), "invalid_envelope", "payload_not_object", "payload"),

  // Payload
  invalidValue("offer without target", msg("webrtc.offer", { sdp: SMALL_SDP }), "invalid_payload", "missing_field", "payload.targetParticipantId"),
  invalidValue("offer addressed to self", msg("webrtc.offer", { targetParticipantId: ALICE, sdp: SMALL_SDP }), "invalid_payload", "invalid_format", "payload.targetParticipantId"),
  invalidValue("offer with non-ULID target", msg("webrtc.offer", { targetParticipantId: "12345", sdp: SMALL_SDP }), "invalid_payload", "invalid_ulid", "payload.targetParticipantId"),
  invalidValue("offer with empty sdp", msg("webrtc.offer", { targetParticipantId: BOB, sdp: "" }), "invalid_payload", "invalid_format", "payload.sdp"),
  invalidValue("answer with sdp over MAX_SDP_BYTES", msg("webrtc.answer", { targetParticipantId: BOB, sdp: "v".repeat(MAX_SDP_BYTES + 1) }), "invalid_payload", "too_long", "payload.sdp"),
  invalidValue("answer with multi-byte sdp over MAX_SDP_BYTES", msg("webrtc.answer", { targetParticipantId: BOB, sdp: "€".repeat(Math.ceil((MAX_SDP_BYTES + 1) / 3)) }), "invalid_payload", "too_long", "payload.sdp"),
  invalidValue("ice candidate without mid or index", msg("webrtc.ice_candidate", {
    targetParticipantId: BOB, candidate: { candidate: candidate.candidate, sdpMid: null, sdpMLineIndex: null },
  }), "invalid_payload", "invalid_format", "payload.candidate"),
  invalidValue("ice candidate index out of range", msg("webrtc.ice_candidate", {
    targetParticipantId: BOB, candidate: { candidate: "", sdpMid: "0", sdpMLineIndex: 1024 },
  }), "invalid_payload", "out_of_range", "payload.candidate.sdpMLineIndex"),
  invalidValue("ice candidate as string", msg("webrtc.ice_candidate", { targetParticipantId: BOB, candidate: "candidate:1" }), "invalid_payload", "wrong_type", "payload.candidate"),
  invalidValue("connected with lowercase peer", msg("webrtc.connected", { peerParticipantId: BOB.toLowerCase() }), "invalid_payload", "invalid_ulid", "payload.peerParticipantId"),
  invalidValue("failed with malformed reason", msg("webrtc.failed", { peerParticipantId: BOB, reason: "ICE Failed" }), "invalid_payload", "invalid_format", "payload.reason"),
  invalidValue("joined with unknown role", msg("participant.joined", { role: "advisor" }), "invalid_payload", "invalid_format", "payload.role"),
  invalidValue("joined with displayName over limit", msg("participant.joined", { role: "host", displayName: "n".repeat(MAX_DISPLAY_NAME_CODE_POINTS + 1) }), "invalid_payload", "too_long", "payload.displayName"),
  invalidValue("meeting.started with offset timestamp", msg("meeting.started", { startedAt: "2026-09-28T10:00:00+03:00" }), "invalid_payload", "invalid_format", "payload.startedAt"),
  invalidValue("meeting.terminated without reason", msg("meeting.terminated", { terminatedAt: "2026-09-28T11:30:00Z" }), "invalid_payload", "missing_field", "payload.reason"),
  invalidValue("session.authenticated with unknown role", msg("session.authenticated", { role: "admin" }), "invalid_payload", "invalid_format", "payload.role"),
  invalidValue("session.welcome with offset timestamp", msg("session.welcome", { role: "host", joinedAt: "2026-09-28T10:00:00+03:00" }), "invalid_payload", "invalid_format", "payload.joinedAt"),
  invalidValue("session.welcome with empty displayName", msg("session.welcome", { role: "host", joinedAt: "2026-09-28T10:00:00Z", displayName: "" }), "invalid_payload", "invalid_format", "payload.displayName"),
  invalidValue("session.welcome with displayName over limit", msg("session.welcome", { role: "host", joinedAt: "2026-09-28T10:00:00Z", displayName: "n".repeat(MAX_DISPLAY_NAME_CODE_POINTS + 1) }), "invalid_payload", "too_long", "payload.displayName"),
  invalidValue("session.welcome with non-string displayName", msg("session.welcome", { role: "host", joinedAt: "2026-09-28T10:00:00Z", displayName: 42 }), "invalid_payload", "wrong_type", "payload.displayName"),
  invalidValue("session.rejected with malformed code", msg("session.rejected", { code: "Not Joined" }), "invalid_payload", "invalid_format", "payload.code"),
  invalidValue("session.rejected without code", msg("session.rejected", {}), "invalid_payload", "missing_field", "payload.code"),
]);

const STEP_BEFORE_DIRECTION = new Set<RejectionCode>(["unsupported_version", "unknown_type"]);
const DETAILS_BEFORE_DIRECTION = new Set<RejectionDetail>(["not_text", "message_too_large", "invalid_json", "not_an_object"]);

function sampleType(sample: InvalidSample): MessageType | undefined {
  const input = sample.input;
  if (typeof input !== "object" || input === null || Array.isArray(input)) return undefined;
  const type = Object.hasOwn(input, "type") ? (input as Record<string, unknown>).type : undefined;
  return isMessageType(type) ? type : undefined;
}

/**
 * The outcome a consumer that receives in `direction` must produce for `sample`.
 * Invalid samples that declare their own direction must be validated with that direction.
 */
export function expectedOutcome(
  sample: ValidSample | InvalidSample,
  direction?: ReceiveDirection,
): { ok: true } | { ok: false; code: RejectionCode } {
  if ("allowedDirections" in sample) {
    if (direction === undefined || sample.allowedDirections.includes(direction)) return { ok: true };
    return { ok: false, code: "direction_not_allowed" };
  }
  const effective = sample.direction ?? direction;
  const failsBeforeDirection =
    STEP_BEFORE_DIRECTION.has(sample.expectedCode) ||
    (sample.expectedDetail !== undefined && DETAILS_BEFORE_DIRECTION.has(sample.expectedDetail));
  const type = sampleType(sample);
  if (!failsBeforeDirection && effective !== undefined && type !== undefined && !isDirectionAllowed(type, effective)) {
    return { ok: false, code: "direction_not_allowed" };
  }
  return { ok: false, code: sample.expectedCode };
}
