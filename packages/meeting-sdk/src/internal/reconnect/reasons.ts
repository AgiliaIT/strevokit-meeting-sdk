/** Stable reason classes for reconnect lifecycle logs. */
export type ReconnectReasonClass =
  | "token_refresh_failed"
  | "admission_refused"
  | "recovery_window_exhausted"
  | "meeting_ended"
  | "session_replaced"
  | "left"
  | "hard_failure";

/** Why a reconnect chain started. */
export type ReconnectTrigger = "meeting_service" | "media" | "network" | "visibility";

const REASON_CLASSES = new Set<ReconnectReasonClass>([
  "token_refresh_failed",
  "admission_refused",
  "recovery_window_exhausted",
  "meeting_ended",
  "session_replaced",
  "left",
  "hard_failure",
]);

const TRIGGERS = new Set<ReconnectTrigger>(["meeting_service", "media", "network", "visibility"]);

/** Keys that must never appear on reconnect logger fields. */
const FORBIDDEN_FIELD_KEYS = new Set([
  "token",
  "joinToken",
  "join_token",
  "authorization",
  "Authorization",
  "password",
  "credential",
  "sdp",
  "candidate",
  "ice",
]);

export type ReconnectLogFields = Readonly<{
  attempt: number;
  trigger?: ReconnectTrigger;
  elapsedMs?: number;
  reason?: ReconnectReasonClass;
  meetingId?: string;
  participantId?: string;
  requestId?: string;
  correlationId?: string;
}>;

export function isReconnectReasonClass(value: string): value is ReconnectReasonClass {
  return REASON_CLASSES.has(value as ReconnectReasonClass);
}

export function isReconnectTrigger(value: string): value is ReconnectTrigger {
  return TRIGGERS.has(value as ReconnectTrigger);
}

/**
 * Builds sanitize-ready logger fields for a reconnect lifecycle entry.
 * Drops forbidden token-shaped keys and undefined values.
 */
export function reconnectLogFields(input: {
  attempt: number;
  trigger?: ReconnectTrigger;
  elapsedMs?: number;
  reason?: ReconnectReasonClass;
  meetingId?: string;
  participantId?: string;
  requestId?: string;
  correlationId?: string;
  /** Extra keys are ignored when forbidden; only opaque id-like extras are accepted. */
  [key: string]: string | number | boolean | undefined;
}): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  const attempt = Math.max(1, Math.floor(input.attempt));
  out.attempt = attempt;
  if (input.trigger !== undefined && isReconnectTrigger(input.trigger)) out.trigger = input.trigger;
  if (typeof input.elapsedMs === "number" && Number.isFinite(input.elapsedMs) && input.elapsedMs >= 0) {
    out.elapsedMs = Math.floor(input.elapsedMs);
  }
  if (input.reason !== undefined && isReconnectReasonClass(input.reason)) out.reason = input.reason;
  for (const key of ["meetingId", "participantId", "requestId", "correlationId"] as const) {
    const value = input[key];
    if (typeof value === "string" && value.length > 0) out[key] = value;
  }
  for (const key of Object.keys(input)) {
    if (FORBIDDEN_FIELD_KEYS.has(key)) {
      // Intentionally omitted — never accept token-shaped keys.
    }
  }
  return out;
}

/** Asserts a proposed field map never carries forbidden keys (for tests and callers). */
export function assertNoForbiddenReconnectFields(fields: Readonly<Record<string, unknown>>): void {
  for (const key of Object.keys(fields)) {
    if (FORBIDDEN_FIELD_KEYS.has(key)) {
      throw new Error(`forbidden reconnect log field: ${key}`);
    }
  }
}
