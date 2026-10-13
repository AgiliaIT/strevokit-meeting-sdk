import { describe, expect, it } from "vitest";
import { mapClose, mapLeftReason, mapMediaError, mapRejection } from "../src/internal/errorMapping.js";
import { ERROR_INFO, MeetingError, type MeetingErrorCode } from "../src/public/errors.js";
import type { MediaKind } from "../src/public/types.js";
import { type FailureName, makeFailure } from "./support/fakeMediaDevices.js";

describe("close code mapping before joined", () => {
  it.each([
    [1000, "connection_failed"],
    [1001, "service_unavailable"],
    [4001, "join_token_invalid"],
    [4002, "join_token_expired"],
    [4003, "origin_not_allowed"],
    [4008, "join_timeout"],
    [4009, "session_replaced"],
    [4010, "connection_failed"],
    [4011, "protocol_error"],
    [4029, "rate_limited"],
    [4503, "service_unavailable"],
    [1006, "connection_failed"],
    [4999, "connection_failed"],
  ] as const)("%i → join_failed + %s", (code, expected) => {
    const mapped = mapClose(code, "before_joined");
    expect(mapped.reason).toBe("join_failed");
    expect(mapped.error?.code).toBe(expected);
  });
});

describe("close code mapping after joined", () => {
  it.each([
    [1000, "left", undefined],
    [1001, "error", "service_unavailable"],
    [4001, "error", "join_token_invalid"],
    [4002, "error", "join_token_expired"],
    [4003, "error", "origin_not_allowed"],
    [4009, "session_replaced", "session_replaced"],
    [4010, "connection_lost", "connection_lost"],
    [4011, "error", "protocol_error"],
    [4029, "error", "rate_limited"],
    [4503, "error", "service_unavailable"],
    [1006, "connection_lost", "connection_lost"],
    [4999, "connection_lost", "connection_lost"],
  ] as const)("%i → closed(%s, %s)", (code, reason, error) => {
    const mapped = mapClose(code, "after_joined");
    expect(mapped.reason).toBe(reason);
    expect(mapped.error?.code).toBe(error);
  });
});

describe("session.rejected mapping", () => {
  it.each([
    ["rate_limited", "rate_limited"],
    ["service_unavailable", "service_unavailable"],
    ["role_not_allowed", "not_permitted"],
    ["invalid_envelope", "protocol_error"],
    ["unsupported_version", "protocol_error"],
    ["unknown_type", "protocol_error"],
    ["direction_not_allowed", "protocol_error"],
    ["invalid_payload", "protocol_error"],
    ["not_joined", "protocol_error"],
    ["already_joined", "protocol_error"],
    ["identity_mismatch", "protocol_error"],
    ["target_not_present", "protocol_error"],
    ["a_code_from_the_future", "protocol_error"],
  ])("%s → %s", (code, expected) => {
    expect(mapRejection(code).code).toBe(expected);
  });
});

describe("participant left reason mapping", () => {
  it.each([
    ["left", "left"],
    ["disconnected", "disconnected"],
    ["removed", "removed"],
    ["meeting_ended", "meeting_ended"],
    ["kicked_by_robot", "other"],
  ])("%s → %s", (reason, expected) => {
    expect(mapLeftReason(reason)).toBe(expected);
  });
});

describe("media capture error mapping", () => {
  const deviceCases: [FailureName, MeetingErrorCode][] = [
    ["NotAllowedError", "permission_denied"],
    ["SecurityError", "permission_denied"],
    ["NotFoundError", "device_not_found"],
    ["OverconstrainedError", "device_not_found"],
    ["NotReadableError", "device_unavailable"],
    ["AbortError", "device_unavailable"],
    ["TypeError", "unsupported_environment"],
  ];

  for (const kind of ["camera", "microphone"] as const satisfies readonly MediaKind[]) {
    it.each(deviceCases)(`${kind}: %s → %s`, (name, expected) => {
      const mapped = mapMediaError(kind, makeFailure(name));
      expect(mapped.code).toBe(expected);
    });
  }

  it.each([
    ["NotAllowedError", "screen_share_cancelled"],
    ["AbortError", "screen_share_cancelled"],
    ["SecurityError", "permission_denied"],
    ["NotReadableError", "device_unavailable"],
    ["NotFoundError", "device_unavailable"],
    ["TypeError", "unsupported_environment"],
  ] as const)("screen: %s → %s", (name, expected) => {
    expect(mapMediaError("screen", makeFailure(name)).code).toBe(expected);
  });

  it("maps unknown failures to device_unavailable", () => {
    expect(mapMediaError("camera", new Error("weird")).code).toBe("device_unavailable");
    expect(mapMediaError("camera", "a string").code).toBe("device_unavailable");
    expect(mapMediaError("camera", null).code).toBe("device_unavailable");
  });

  it("never carries the raw browser error or its message", () => {
    const raw = makeFailure("NotAllowedError", "Permission denied by system policy XYZ");
    const mapped = mapMediaError("camera", raw);
    expect(mapped).toBeInstanceOf(MeetingError);
    expect(mapped.cause).toBeUndefined();
    expect(mapped.message).toBe(ERROR_INFO.permission_denied.message);
    expect(mapped.message).not.toContain("XYZ");
  });
});

describe("MeetingError", () => {
  it("uses the default message and retryable flag for every code", () => {
    for (const [code, info] of Object.entries(ERROR_INFO) as [MeetingErrorCode, (typeof ERROR_INFO)[MeetingErrorCode]][]) {
      const error = new MeetingError(code);
      expect(error.name).toBe("MeetingError");
      expect(error.code).toBe(code);
      expect(error.message).toBe(info.message);
      expect(error.retryable).toBe(info.retryable);
      expect(error.cause).toBeUndefined();
      expect(error).toBeInstanceOf(Error);
    }
  });

  it("describes media connection failures as retryable and the participant limit as not retryable", () => {
    expect(new MeetingError("media_connection_failed")).toMatchObject({
      message: "Audio and video couldn't connect to the other participant. Check your network and try rejoining.",
      retryable: true,
    });
    expect(new MeetingError("media_participant_limit")).toMatchObject({
      message: "Audio and video are available with one other participant in this meeting.",
      retryable: false,
    });
  });

  it("freezes the error table", () => {
    expect(Object.isFrozen(ERROR_INFO)).toBe(true);
  });
});
