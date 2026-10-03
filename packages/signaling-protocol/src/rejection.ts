/** Stable rejection reason codes (part of the public contract). */
export const REJECTION_CODES = Object.freeze([
  "invalid_envelope",
  "unsupported_version",
  "unknown_type",
  "direction_not_allowed",
  "invalid_payload",
] as const);

export type RejectionCode = (typeof REJECTION_CODES)[number];

/** Stable sub-reasons carried in `SignalingRejection.detail`. */
export const REJECTION_DETAILS = Object.freeze([
  "message_too_large",
  "not_text",
  "invalid_json",
  "not_an_object",
  "invalid_ulid",
  "payload_not_object",
  "missing_field",
  "wrong_type",
  "too_long",
  "out_of_range",
  "invalid_format",
] as const);

export type RejectionDetail = (typeof REJECTION_DETAILS)[number];

export type SignalingRejection = {
  code: RejectionCode;
  /** Fixed template; never contains input values. */
  message: string;
  /** Dotted path of the failing field, e.g. `payload.sdp`. */
  field?: string;
  detail?: RejectionDetail;
};

const CODE_MESSAGES: Record<RejectionCode, string> = {
  invalid_envelope: "Message envelope is invalid.",
  unsupported_version: "Protocol version is missing or not supported.",
  unknown_type: "Message type is not part of the protocol.",
  direction_not_allowed: "Message type is not allowed in this direction.",
  invalid_payload: "Message payload is invalid.",
};

const DETAIL_MESSAGES: Record<RejectionDetail, string> = {
  message_too_large: "Message exceeds the maximum size.",
  not_text: "Message frame must be UTF-8 text.",
  invalid_json: "Message frame is not valid JSON.",
  not_an_object: "Message must be a JSON object.",
  invalid_ulid: "Identifier must be a canonical ULID.",
  payload_not_object: "Payload must be a JSON object.",
  missing_field: "A required field is missing.",
  wrong_type: "A field has the wrong type.",
  too_long: "A field is too long.",
  out_of_range: "A field is out of range.",
  invalid_format: "A field has an invalid format.",
};

/** Build a rejection. Messages come only from fixed templates. */
export function reject(
  code: RejectionCode,
  detail?: RejectionDetail,
  field?: string,
): SignalingRejection {
  const rejection: SignalingRejection = {
    code,
    message: detail ? DETAIL_MESSAGES[detail] : CODE_MESSAGES[code],
  };
  if (field !== undefined) rejection.field = field;
  if (detail !== undefined) rejection.detail = detail;
  return rejection;
}

/** Thrown only by outbound helpers (createSignalingMessage / encodeSignalingMessage). */
export class SignalingProtocolError extends Error {
  readonly rejection: SignalingRejection;

  constructor(rejection: SignalingRejection) {
    super(`${rejection.code}: ${rejection.message}`);
    this.name = "SignalingProtocolError";
    this.rejection = rejection;
  }
}
