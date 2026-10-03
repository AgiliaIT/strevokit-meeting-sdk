import { type ReceiveDirection, isDirectionAllowed, isMessageType } from "./catalog.js";
import { MAX_MESSAGE_BYTES } from "./limits.js";
import { validatePayload } from "./payloads.js";
import { isCanonicalUlid, isPlainObject, readOwn, utf8ByteLength } from "./primitives.js";
import { type SignalingRejection, reject } from "./rejection.js";
import type { ParseOptions, ParseResult, SignalingMessage } from "./types.js";
import { PROTOCOL_VERSION, isSupportedVersion } from "./version.js";

function failure(error: SignalingRejection): ParseResult {
  return { ok: false, error };
}

function resolveDirection(options: ParseOptions | undefined): ReceiveDirection | undefined {
  const direction = options?.direction;
  return direction === "client_to_server" || direction === "server_to_client"
    ? direction
    : undefined;
}

/** Ordered checks (contract steps 3-8): object, version, type, direction, envelope fields, payload. */
function parseValue(input: unknown, direction: ReceiveDirection | undefined): ParseResult {
  if (!isPlainObject(input)) return failure(reject("invalid_envelope", "not_an_object"));

  if (!isSupportedVersion(readOwn(input, "version"))) {
    return failure(reject("unsupported_version", undefined, "version"));
  }

  const type = readOwn(input, "type");
  if (!isMessageType(type)) return failure(reject("unknown_type", undefined, "type"));

  if (direction !== undefined && !isDirectionAllowed(type, direction)) {
    return failure(reject("direction_not_allowed", undefined, "type"));
  }

  const meetingId = readOwn(input, "meetingId");
  if (!isCanonicalUlid(meetingId)) {
    return failure(reject("invalid_envelope", "invalid_ulid", "meetingId"));
  }
  const participantId = readOwn(input, "participantId");
  if (!isCanonicalUlid(participantId)) {
    return failure(reject("invalid_envelope", "invalid_ulid", "participantId"));
  }
  const payload = readOwn(input, "payload");
  if (!isPlainObject(payload)) {
    return failure(reject("invalid_envelope", "payload_not_object", "payload"));
  }

  const result = validatePayload(type, payload, { participantId });
  if (!result.ok) return failure(result.rejection);

  const message = {
    version: PROTOCOL_VERSION,
    type,
    meetingId,
    participantId,
    payload: result.value,
  } as SignalingMessage;
  return { ok: true, message };
}

/** Validate an already-parsed value. Never throws. */
export function parseSignalingMessage(input: unknown, options?: ParseOptions): ParseResult {
  try {
    return parseValue(input, resolveDirection(options));
  } catch {
    return failure(reject("invalid_envelope"));
  }
}

function exceedsMaxMessageBytes(frame: string): boolean {
  if (frame.length > MAX_MESSAGE_BYTES) return true;
  if (frame.length * 3 <= MAX_MESSAGE_BYTES) return false;
  return utf8ByteLength(frame) > MAX_MESSAGE_BYTES;
}

/** Validate a raw text frame: size, then JSON, then full validation. Never throws. */
export function decodeSignalingFrame(frame: unknown, options?: ParseOptions): ParseResult {
  try {
    if (typeof frame !== "string") return failure(reject("invalid_envelope", "not_text"));
    if (exceedsMaxMessageBytes(frame)) {
      return failure(reject("invalid_envelope", "message_too_large"));
    }
    let value: unknown;
    try {
      value = JSON.parse(frame);
    } catch {
      return failure(reject("invalid_envelope", "invalid_json"));
    }
    return parseValue(value, resolveDirection(options));
  } catch {
    return failure(reject("invalid_envelope"));
  }
}
