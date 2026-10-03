import { describe, expect, it } from "vitest";
import { decodeAddressing } from "../src/internal/token.js";
import { MeetingError } from "../src/public/errors.js";
import { makeTestToken, testUlid } from "./support/fakeRealtime.js";

function b64(value: unknown): string {
  return Buffer.from(typeof value === "string" ? value : JSON.stringify(value), "utf8").toString("base64url");
}

function expectInvalid(token: string): void {
  try {
    decodeAddressing(token);
  } catch (error) {
    expect(error).toBeInstanceOf(MeetingError);
    expect((error as MeetingError).code).toBe("join_token_invalid");
    expect((error as MeetingError).message).not.toContain(token);
    return;
  }
  throw new Error("expected join_token_invalid");
}

describe("decodeAddressing", () => {
  it("reads meeting and participant IDs from a valid token", () => {
    const meetingId = testUlid();
    const participantId = testUlid();
    expect(decodeAddressing(makeTestToken({ meetingId, participantId }))).toEqual({ meetingId, participantId });
  });

  it("does not reject an expired token locally", () => {
    const meetingId = testUlid();
    const participantId = testUlid();
    const token = makeTestToken({ meetingId, participantId, exp: 1 });
    expect(decodeAddressing(token)).toEqual({ meetingId, participantId });
  });

  it("ignores the role claim", () => {
    const meetingId = testUlid();
    const participantId = testUlid();
    const token = `${b64({ alg: "HS256" })}.${b64({ meeting_id: meetingId, participant_id: participantId, role: "superuser" })}.sig`;
    expect(decodeAddressing(token)).toEqual({ meetingId, participantId });
  });

  const valid = { meeting_id: "01JQBBBBBBBBBBBBBBBBBBBBBB", participant_id: "01JQCCCCCCCCCCCCCCCCCCCCCC" };

  it.each([
    ["not a JWT", "not-a-token"],
    ["two segments", `${b64({})}.${b64(valid)}`],
    ["four segments", `${b64({})}.${b64(valid)}.sig.extra`],
    ["bad base64url", `${b64({})}.***.sig`],
    ["non-JSON payload", `${b64({})}.${b64("hello")}.sig`],
    ["array payload", `${b64({})}.${b64([valid])}.sig`],
    ["missing meeting_id", `${b64({})}.${b64({ participant_id: valid.participant_id })}.sig`],
    ["missing participant_id", `${b64({})}.${b64({ meeting_id: valid.meeting_id })}.sig`],
    ["lowercase meeting_id", `${b64({})}.${b64({ ...valid, meeting_id: valid.meeting_id.toLowerCase() })}.sig`],
    ["numeric participant_id", `${b64({})}.${b64({ ...valid, participant_id: 12345 })}.sig`],
    ["empty payload segment", `${b64({})}..sig`],
  ])("rejects %s with join_token_invalid", (_name, token) => {
    expectInvalid(token);
  });
});
