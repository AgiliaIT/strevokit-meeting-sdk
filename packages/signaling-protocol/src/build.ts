import type { MessageType } from "./catalog.js";
import { MAX_MESSAGE_BYTES } from "./limits.js";
import { parseSignalingMessage } from "./parse.js";
import { utf8ByteLength } from "./primitives.js";
import { SignalingProtocolError, reject } from "./rejection.js";
import type { PayloadMap, SignalingMessage } from "./types.js";
import { PROTOCOL_VERSION } from "./version.js";

export type CreateMessageFields<T extends MessageType> = {
  meetingId: string;
  participantId: string;
  payload: PayloadMap[T];
};

/**
 * Build an outbound message stamped with PROTOCOL_VERSION.
 * Throws SignalingProtocolError if it would not pass validation (outbound data is our own code).
 */
export function createSignalingMessage<T extends MessageType>(
  type: T,
  fields: CreateMessageFields<T>,
): SignalingMessage<T> {
  const result = parseSignalingMessage({
    version: PROTOCOL_VERSION,
    type,
    meetingId: fields.meetingId,
    participantId: fields.participantId,
    payload: fields.payload,
  });
  if (!result.ok) throw new SignalingProtocolError(result.error);
  return result.message as SignalingMessage<T>;
}

/**
 * Serialize a message to a text frame. The message is re-validated (so only documented
 * fields are sent) and the frame must fit in MAX_MESSAGE_BYTES; otherwise this throws.
 */
export function encodeSignalingMessage(message: SignalingMessage): string {
  const result = parseSignalingMessage(message);
  if (!result.ok) throw new SignalingProtocolError(result.error);
  const frame = JSON.stringify(result.message);
  if (utf8ByteLength(frame) > MAX_MESSAGE_BYTES) {
    throw new SignalingProtocolError(reject("invalid_envelope", "message_too_large"));
  }
  return frame;
}
