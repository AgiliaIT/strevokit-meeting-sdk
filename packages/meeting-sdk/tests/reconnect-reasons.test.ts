import { describe, expect, it } from "vitest";
import {
  assertNoForbiddenReconnectFields,
  isReconnectReasonClass,
  reconnectLogFields,
  type ReconnectReasonClass,
} from "../src/internal/reconnect/reasons.js";

const REASONS: readonly ReconnectReasonClass[] = [
  "token_refresh_failed",
  "admission_refused",
  "recovery_window_exhausted",
  "meeting_ended",
  "session_replaced",
  "left",
  "hard_failure",
];

describe("reconnect reasons", () => {
  it("recognizes the stable reason-class union", () => {
    for (const reason of REASONS) expect(isReconnectReasonClass(reason)).toBe(true);
    expect(isReconnectReasonClass("connection_lost")).toBe(false);
    expect(isReconnectReasonClass("")).toBe(false);
  });

  it("builds logger fields with attempt, trigger, elapsedMs, reason, and opaque ids only", () => {
    expect(
      reconnectLogFields({
        attempt: 2,
        trigger: "meeting_service",
        elapsedMs: 1500,
        reason: "recovery_window_exhausted",
        meetingId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
        participantId: "01ARZ3NDEKTSV4RRFFQ69G5FAW",
        requestId: "req_1",
        correlationId: "corr_1",
      }),
    ).toEqual({
      attempt: 2,
      trigger: "meeting_service",
      elapsedMs: 1500,
      reason: "recovery_window_exhausted",
      meetingId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      participantId: "01ARZ3NDEKTSV4RRFFQ69G5FAW",
      requestId: "req_1",
      correlationId: "corr_1",
    });
  });

  it("never accepts token-shaped keys on reconnect logger helpers", () => {
    const withToken = reconnectLogFields({
      attempt: 1,
      trigger: "meeting_service",
      token: "x",
      joinToken: "x",
      authorization: "Bearer x",
    } as Parameters<typeof reconnectLogFields>[0] & { token: string; joinToken: string; authorization: string });
    expect(withToken).toEqual({ attempt: 1, trigger: "meeting_service" });
    expect(Object.keys(withToken)).not.toContain("token");
    expect(Object.keys(withToken)).not.toContain("joinToken");
    expect(Object.keys(withToken)).not.toContain("authorization");

    expect(() => assertNoForbiddenReconnectFields({ attempt: 1 })).not.toThrow();
    expect(() => assertNoForbiddenReconnectFields({ token: "x" })).toThrow(/forbidden/);
    expect(() => assertNoForbiddenReconnectFields({ join_token: "x" })).toThrow(/forbidden/);
  });
});
