import { currentEnvironment } from "./internal/env.js";
import { MeetingEngineImpl } from "./internal/engine.js";
import { SignalingOnlyMediaDelivery } from "./internal/mediaDelivery.js";
import { decodeAddressing } from "./internal/token.js";
import { MeetingError } from "./public/errors.js";
import type { MeetingEngine, MeetingEngineOptions } from "./public/types.js";

const DEFAULT_JOIN_TIMEOUT_MS = 15_000;
const MIN_JOIN_TIMEOUT_MS = 1_000;
const MAX_JOIN_TIMEOUT_MS = 60_000;
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1"]);

function normalizeRealtimeUrl(value: unknown): string {
  const invalid = new TypeError(
    "realtimeUrl must be wss://host[:port] (ws:// only for localhost) with no path, query, or fragment.",
  );
  if (typeof value !== "string" || value.includes("?") || value.includes("#")) throw invalid;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw invalid;
  }
  const secure = url.protocol === "wss:";
  const loopback = url.protocol === "ws:" && LOOPBACK_HOSTS.has(url.hostname);
  if (!secure && !loopback) throw invalid;
  if (url.username !== "" || url.password !== "" || (url.pathname !== "" && url.pathname !== "/")) throw invalid;
  return `${url.protocol}//${url.host}`;
}

function normalizeJoinTimeout(value: unknown): number {
  if (value === undefined) return DEFAULT_JOIN_TIMEOUT_MS;
  if (typeof value !== "number" || !Number.isInteger(value) || value < MIN_JOIN_TIMEOUT_MS || value > MAX_JOIN_TIMEOUT_MS) {
    throw new TypeError(`joinTimeoutMs must be an integer from ${MIN_JOIN_TIMEOUT_MS} to ${MAX_JOIN_TIMEOUT_MS}.`);
  }
  return value;
}

/**
 * Creates a meeting engine for one participant. Pass the join token your backend issued and the realtime
 * service URL, then call `join()`.
 *
 * @throws TypeError when `realtimeUrl` or `joinTimeoutMs` is malformed.
 * @throws MeetingError `join_token_invalid` when the token is not a valid join token, or
 * `unsupported_environment` when the browser has no WebSocket support.
 */
export function createMeetingEngine(options: MeetingEngineOptions): MeetingEngine {
  if (typeof options !== "object" || options === null) throw new TypeError("createMeetingEngine requires options.");
  const realtimeUrl = normalizeRealtimeUrl(options.realtimeUrl);
  const joinTimeoutMs = normalizeJoinTimeout(options.joinTimeoutMs);
  const token: unknown = options.token;
  if (typeof token !== "string" || token.length === 0) throw new MeetingError("join_token_invalid");
  const env = currentEnvironment();
  if (!env.WebSocket) throw new MeetingError("unsupported_environment");
  const addressing = decodeAddressing(token);
  return new MeetingEngineImpl({
    token,
    realtimeUrl,
    joinTimeoutMs,
    logger: options.logger,
    addressing,
    env,
    mediaDelivery: new SignalingOnlyMediaDelivery(),
  });
}
