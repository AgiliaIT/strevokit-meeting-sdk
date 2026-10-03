import type { MeetingLogger } from "../public/types.js";

type Level = "debug" | "info" | "warn" | "error";
export type LogFields = Readonly<Record<string, string | number | boolean | undefined>>;

const ALLOWED_KEYS = new Set([
  "state",
  "code",
  "reason",
  "kind",
  "participantId",
  "meetingId",
  "closeCode",
  "messageType",
  "durationMs",
]);

const JWT_SHAPE = /[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/;
const NEGOTIATION_CONTENT = /sdp|candidate/i;

function isSafeString(value: string): boolean {
  return !JWT_SHAPE.test(value) && !NEGOTIATION_CONTENT.test(value);
}

function sanitize(fields: LogFields | undefined): Record<string, string | number | boolean> | undefined {
  if (!fields) return undefined;
  const out: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (!ALLOWED_KEYS.has(key) || value === undefined) continue;
    if (typeof value === "string" && !isSafeString(value)) continue;
    out[key] = value;
  }
  return out;
}

/** Wraps the consumer's logger: allow-listed fields only, and a throwing logger never affects the engine. */
export class Log {
  readonly #logger: MeetingLogger | undefined;

  constructor(logger: MeetingLogger | undefined) {
    this.#logger = logger;
  }

  debug(message: string, fields?: LogFields): void {
    this.#write("debug", message, fields);
  }

  info(message: string, fields?: LogFields): void {
    this.#write("info", message, fields);
  }

  warn(message: string, fields?: LogFields): void {
    this.#write("warn", message, fields);
  }

  error(message: string, fields?: LogFields): void {
    this.#write("error", message, fields);
  }

  #write(level: Level, message: string, fields: LogFields | undefined): void {
    const logger = this.#logger;
    if (!logger) return;
    try {
      const method = logger[level];
      if (typeof method !== "function") return;
      const safe = sanitize(fields);
      if (safe) method.call(logger, message, safe);
      else method.call(logger, message);
    } catch {
      // A failing logger must never break the meeting.
    }
  }
}
