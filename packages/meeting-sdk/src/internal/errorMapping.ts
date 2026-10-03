import { MeetingError, type MeetingErrorCode } from "../public/errors.js";
import type { CloseReason, MediaKind, ParticipantLeftReason } from "../public/types.js";

export type ClosePhase = "before_joined" | "after_joined";
export type MappedClose = { reason: CloseReason; error?: MeetingError };

const BEFORE_JOINED: Readonly<Record<number, MeetingErrorCode>> = {
  1001: "service_unavailable",
  4001: "join_token_invalid",
  4002: "join_token_expired",
  4003: "origin_not_allowed",
  4008: "join_timeout",
  4009: "session_replaced",
  4011: "protocol_error",
  4029: "rate_limited",
  4503: "service_unavailable",
};

const AFTER_JOINED: Readonly<Record<number, readonly [CloseReason, MeetingErrorCode | undefined]>> = {
  1000: ["left", undefined],
  1001: ["error", "service_unavailable"],
  4001: ["error", "join_token_invalid"],
  4002: ["error", "join_token_expired"],
  4003: ["error", "origin_not_allowed"],
  4009: ["session_replaced", "session_replaced"],
  4011: ["error", "protocol_error"],
  4029: ["error", "rate_limited"],
  4503: ["error", "service_unavailable"],
};

/** Maps a connection close to the public close reason and error. */
export function mapClose(code: number, phase: ClosePhase): MappedClose {
  if (phase === "before_joined") {
    return { reason: "join_failed", error: new MeetingError(BEFORE_JOINED[code] ?? "connection_failed") };
  }
  const [reason, errorCode] = AFTER_JOINED[code] ?? ["connection_lost", "connection_lost"];
  return errorCode ? { reason, error: new MeetingError(errorCode) } : { reason };
}

const REJECTIONS: Readonly<Record<string, MeetingErrorCode>> = {
  rate_limited: "rate_limited",
  service_unavailable: "service_unavailable",
  role_not_allowed: "not_permitted",
};

export function mapRejection(code: string): MeetingError {
  return new MeetingError(Object.hasOwn(REJECTIONS, code) ? (REJECTIONS[code] as MeetingErrorCode) : "protocol_error");
}

const LEFT_REASONS = new Set<ParticipantLeftReason>(["left", "disconnected", "removed", "meeting_ended"]);

export function mapLeftReason(reason: string): ParticipantLeftReason {
  return LEFT_REASONS.has(reason as ParticipantLeftReason) ? (reason as ParticipantLeftReason) : "other";
}

const DEVICE_ERRORS: Readonly<Record<string, MeetingErrorCode>> = {
  NotAllowedError: "permission_denied",
  SecurityError: "permission_denied",
  NotFoundError: "device_not_found",
  OverconstrainedError: "device_not_found",
  NotReadableError: "device_unavailable",
  AbortError: "device_unavailable",
  TypeError: "unsupported_environment",
};

const SCREEN_ERRORS: Readonly<Record<string, MeetingErrorCode>> = {
  NotAllowedError: "screen_share_cancelled",
  AbortError: "screen_share_cancelled",
  SecurityError: "permission_denied",
  TypeError: "unsupported_environment",
};

function errorName(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const name = (error as { name?: unknown }).name;
  return typeof name === "string" ? name : undefined;
}

/** Maps a browser capture failure to a MeetingError. The original error is dropped, never attached. */
export function mapMediaError(kind: MediaKind, error: unknown): MeetingError {
  if (error instanceof MeetingError) return error;
  const name = errorName(error);
  const table = kind === "screen" ? SCREEN_ERRORS : DEVICE_ERRORS;
  const code = name !== undefined && Object.hasOwn(table, name) ? table[name] : undefined;
  return new MeetingError(code ?? "device_unavailable");
}
