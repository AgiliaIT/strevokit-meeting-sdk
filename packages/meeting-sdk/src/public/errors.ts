/**
 * Every code a {@link MeetingError} can carry. Codes are stable strings; new codes may be added in minor
 * versions, so handle unknown codes generically.
 */
export type MeetingErrorCode =
  | "join_token_invalid"
  | "join_token_expired"
  | "origin_not_allowed"
  | "connection_failed"
  | "join_timeout"
  | "join_cancelled"
  | "connection_lost"
  | "session_replaced"
  | "service_unavailable"
  | "rate_limited"
  | "meeting_ended"
  | "protocol_error"
  | "already_joined"
  | "engine_closed"
  | "not_joined"
  | "not_permitted"
  | "permission_denied"
  | "device_not_found"
  | "device_unavailable"
  | "screen_share_cancelled"
  | "unsupported_environment";

type ErrorInfo = { readonly message: string; readonly retryable: boolean };

export const ERROR_INFO: Readonly<Record<MeetingErrorCode, ErrorInfo>> = Object.freeze({
  join_token_invalid: { message: "This meeting link is not valid. Ask for a new one.", retryable: false },
  join_token_expired: { message: "This meeting link has expired. Ask for a new one.", retryable: true },
  origin_not_allowed: { message: "This site is not allowed to join this meeting.", retryable: false },
  connection_failed: {
    message: "Could not connect to the meeting. Check your connection and try again.",
    retryable: true,
  },
  join_timeout: { message: "Joining the meeting took too long. Please try again.", retryable: true },
  join_cancelled: { message: "Joining was cancelled.", retryable: false },
  connection_lost: { message: "The connection to the meeting was lost.", retryable: true },
  session_replaced: { message: "You joined this meeting from another tab or device.", retryable: false },
  service_unavailable: {
    message: "The meeting service is temporarily unavailable. Please try again shortly.",
    retryable: true,
  },
  rate_limited: { message: "Too many attempts. Please wait a moment and try again.", retryable: true },
  meeting_ended: { message: "This meeting has ended.", retryable: false },
  protocol_error: { message: "Something went wrong in the meeting connection.", retryable: false },
  already_joined: { message: "This meeting is already joined or joining.", retryable: false },
  engine_closed: {
    message: "This meeting session has ended. Create a new one to join again.",
    retryable: false,
  },
  not_joined: { message: "Join the meeting first.", retryable: false },
  not_permitted: { message: "You don't have permission to do that in this meeting.", retryable: false },
  permission_denied: {
    message: "Camera or microphone access was blocked. Allow access in your browser settings.",
    retryable: false,
  },
  device_not_found: { message: "No camera or microphone was found.", retryable: false },
  device_unavailable: {
    message: "Your camera or microphone is being used by another application.",
    retryable: true,
  },
  screen_share_cancelled: { message: "Screen sharing was cancelled.", retryable: false },
  unsupported_environment: {
    message:
      "This browser does not support meetings. Try a current version of Chrome, Edge, Firefox, or Safari.",
    retryable: false,
  },
});

/**
 * The single error type raised by the SDK. `message` is a short English sentence that is safe to show to users;
 * branch on `code` rather than on `message`.
 */
export class MeetingError extends Error {
  override readonly name = "MeetingError" as const;
  /** Stable machine-readable code. */
  readonly code: MeetingErrorCode;
  /** True when retrying the same action later (with a fresh token for join errors) may succeed. */
  readonly retryable: boolean;

  constructor(code: MeetingErrorCode) {
    const info = ERROR_INFO[code];
    super(info.message);
    this.code = code;
    this.retryable = info.retryable;
  }
}
