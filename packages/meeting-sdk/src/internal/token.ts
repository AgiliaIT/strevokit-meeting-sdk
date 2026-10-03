import { isCanonicalUlid } from "@strevokit/signaling-protocol";
import { MeetingError } from "../public/errors.js";

export type Addressing = { readonly meetingId: string; readonly participantId: string };

const BASE64URL = /^[A-Za-z0-9_-]+$/;

function decodeSegment(segment: string): unknown {
  if (!BASE64URL.test(segment)) throw new MeetingError("join_token_invalid");
  const padded = segment.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(segment.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}

/**
 * Reads the meeting and participant IDs from a join token so the engine can address the connection. The
 * signature, expiry, and role are deliberately not checked here: the realtime service verifies the token.
 */
export function decodeAddressing(token: string): Addressing {
  const segments = token.split(".");
  if (segments.length !== 3) throw new MeetingError("join_token_invalid");
  let claims: unknown;
  try {
    claims = decodeSegment(segments[1] ?? "");
  } catch {
    throw new MeetingError("join_token_invalid");
  }
  if (typeof claims !== "object" || claims === null || Array.isArray(claims)) {
    throw new MeetingError("join_token_invalid");
  }
  const { meeting_id: meetingId, participant_id: participantId } = claims as Record<string, unknown>;
  if (!isCanonicalUlid(meetingId) || !isCanonicalUlid(participantId)) {
    throw new MeetingError("join_token_invalid");
  }
  return { meetingId, participantId };
}
