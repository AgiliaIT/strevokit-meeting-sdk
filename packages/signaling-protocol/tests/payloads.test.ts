import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_DISPLAY_NAME_CODE_POINTS,
  MAX_ICE_CANDIDATE_LENGTH,
  MAX_REASON_LENGTH,
  MAX_SDP_BYTES,
  MESSAGE_TYPES,
  parseSignalingMessage,
} from "../src/index.js";
import type { ParseResult } from "../src/index.js";
import { ALICE, BOB, SMALL_SDP, VALID_PAYLOADS, envelope, validEnvelope } from "./helpers.js";

/** Asserts the parse succeeded and returns the parsed message. */
function expectOk(result: ParseResult) {
  assert.equal(result.ok, true, result.ok ? "" : JSON.stringify(result.error));
  if (!result.ok) throw new Error("unreachable");
  return result.message;
}

/** Asserts the parse was rejected as `invalid_payload` with exactly `detail` and `field`. */
function expectPayloadError(result: ParseResult, detail: string, field: string) {
  assert.equal(result.ok, false, "expected rejection");
  if (result.ok) return;
  assert.equal(result.error.code, "invalid_payload");
  assert.equal(result.error.detail, detail);
  assert.equal(result.error.field, field);
}

test("every type accepts its documented valid payload", () => {
  for (const type of MESSAGE_TYPES) {
    const message = expectOk(parseSignalingMessage(validEnvelope(type)));
    assert.equal(message.type, type);
    assert.equal(message.version, 1);
    assert.deepEqual(message.payload, VALID_PAYLOADS[type], type);
  }
});

test("optional fields may be omitted", () => {
  const joined = expectOk(parseSignalingMessage(envelope("participant.joined", { role: "participant" })));
  assert.deepEqual(joined.payload, { role: "participant" });
  assert.ok(!("displayName" in joined.payload));

  const ended = expectOk(parseSignalingMessage(envelope("meeting.ended", { endedAt: "2026-09-28T11:00:00Z" })));
  assert.deepEqual(ended.payload, { endedAt: "2026-09-28T11:00:00Z" });

  const ice = expectOk(
    parseSignalingMessage(
      envelope("webrtc.ice_candidate", {
        targetParticipantId: BOB,
        candidate: { candidate: "candidate:1 1 udp 1 192.0.2.1 5000 typ host", sdpMid: null, sdpMLineIndex: 0 },
      }),
    ),
  );
  assert.deepEqual(ice.payload, {
    targetParticipantId: BOB,
    candidate: { candidate: "candidate:1 1 udp 1 192.0.2.1 5000 typ host", sdpMid: null, sdpMLineIndex: 0 },
  });
});

test("end-of-candidates (empty candidate) is accepted with null mid and index", () => {
  expectOk(
    parseSignalingMessage(
      envelope("webrtc.ice_candidate", {
        targetParticipantId: BOB,
        candidate: { candidate: "", sdpMid: null, sdpMLineIndex: null, usernameFragment: null },
      }),
    ),
  );
});

test("unknown but well-formed reason codes are accepted", () => {
  expectOk(parseSignalingMessage(envelope("webrtc.failed", { peerParticipantId: BOB, reason: "dtls_failed" })));
  expectOk(parseSignalingMessage(envelope("participant.left", { reason: "kicked_by_policy" })));
});

test("SDP up to MAX_SDP_BYTES is accepted", () => {
  const sdp = SMALL_SDP + "a=x:".padEnd(MAX_SDP_BYTES - SMALL_SDP.length, "y");
  assert.equal(sdp.length, MAX_SDP_BYTES);
  expectOk(parseSignalingMessage(envelope("webrtc.offer", { targetParticipantId: BOB, sdp })));
});

test("missing required fields are rejected with the field path", () => {
  const cases: Array<[string, Record<string, unknown>, string]> = [
    ["participant.joined", {}, "payload.role"],
    ["participant.left", {}, "payload.reason"],
    ["webrtc.offer", { sdp: SMALL_SDP }, "payload.targetParticipantId"],
    ["webrtc.offer", { targetParticipantId: BOB }, "payload.sdp"],
    ["webrtc.answer", { targetParticipantId: BOB }, "payload.sdp"],
    ["webrtc.ice_candidate", { targetParticipantId: BOB }, "payload.candidate"],
    [
      "webrtc.ice_candidate",
      { targetParticipantId: BOB, candidate: { sdpMid: "0", sdpMLineIndex: 0 } },
      "payload.candidate.candidate",
    ],
    [
      "webrtc.ice_candidate",
      { targetParticipantId: BOB, candidate: { candidate: "", sdpMLineIndex: 0 } },
      "payload.candidate.sdpMid",
    ],
    [
      "webrtc.ice_candidate",
      { targetParticipantId: BOB, candidate: { candidate: "", sdpMid: "0" } },
      "payload.candidate.sdpMLineIndex",
    ],
    ["webrtc.connected", {}, "payload.peerParticipantId"],
    ["webrtc.disconnected", {}, "payload.peerParticipantId"],
    ["webrtc.failed", { peerParticipantId: BOB }, "payload.reason"],
    ["meeting.started", {}, "payload.startedAt"],
    ["meeting.ended", {}, "payload.endedAt"],
    ["meeting.terminated", { reason: "system" }, "payload.terminatedAt"],
    ["meeting.terminated", { terminatedAt: "2026-09-28T11:30:00Z" }, "payload.reason"],
  ];
  for (const [type, payload, field] of cases) {
    expectPayloadError(parseSignalingMessage(envelope(type, payload)), "missing_field", field);
  }
});

test("wrong field types are rejected", () => {
  const cases: Array<[string, Record<string, unknown>, string]> = [
    ["participant.joined", { role: 1 }, "payload.role"],
    ["participant.joined", { role: "host", displayName: 42 }, "payload.displayName"],
    ["participant.joined", { role: "host", displayName: null }, "payload.displayName"],
    ["participant.left", { reason: ["left"] }, "payload.reason"],
    ["webrtc.offer", { targetParticipantId: BOB, sdp: 1 }, "payload.sdp"],
    ["webrtc.offer", { targetParticipantId: 7, sdp: SMALL_SDP }, "payload.targetParticipantId"],
    ["webrtc.ice_candidate", { targetParticipantId: BOB, candidate: "candidate:1" }, "payload.candidate"],
    ["webrtc.ice_candidate", { targetParticipantId: BOB, candidate: [] }, "payload.candidate"],
    [
      "webrtc.ice_candidate",
      { targetParticipantId: BOB, candidate: { candidate: 1, sdpMid: "0", sdpMLineIndex: 0 } },
      "payload.candidate.candidate",
    ],
    [
      "webrtc.ice_candidate",
      { targetParticipantId: BOB, candidate: { candidate: "", sdpMid: 0, sdpMLineIndex: 0 } },
      "payload.candidate.sdpMid",
    ],
    [
      "webrtc.ice_candidate",
      { targetParticipantId: BOB, candidate: { candidate: "", sdpMid: "0", sdpMLineIndex: "0" } },
      "payload.candidate.sdpMLineIndex",
    ],
    [
      "webrtc.ice_candidate",
      {
        targetParticipantId: BOB,
        candidate: { candidate: "", sdpMid: "0", sdpMLineIndex: 0, usernameFragment: 5 },
      },
      "payload.candidate.usernameFragment",
    ],
    ["meeting.started", { startedAt: 1727518530 }, "payload.startedAt"],
  ];
  for (const [type, payload, field] of cases) {
    expectPayloadError(parseSignalingMessage(envelope(type, payload)), "wrong_type", field);
  }
});

test("length limits are enforced", () => {
  const bigSdp = "v".repeat(MAX_SDP_BYTES + 1);
  expectPayloadError(
    parseSignalingMessage(envelope("webrtc.offer", { targetParticipantId: BOB, sdp: bigSdp })),
    "too_long",
    "payload.sdp",
  );

  const multiByteSdp = "€".repeat(Math.ceil((MAX_SDP_BYTES + 1) / 3));
  assert.ok(multiByteSdp.length < MAX_SDP_BYTES);
  expectPayloadError(
    parseSignalingMessage(envelope("webrtc.answer", { targetParticipantId: BOB, sdp: multiByteSdp })),
    "too_long",
    "payload.sdp",
  );

  expectPayloadError(
    parseSignalingMessage(
      envelope("participant.joined", { role: "host", displayName: "😀".repeat(MAX_DISPLAY_NAME_CODE_POINTS + 1) }),
    ),
    "too_long",
    "payload.displayName",
  );
  expectOk(
    parseSignalingMessage(
      envelope("participant.joined", { role: "host", displayName: "😀".repeat(MAX_DISPLAY_NAME_CODE_POINTS) }),
    ),
  );

  expectPayloadError(
    parseSignalingMessage(
      envelope("webrtc.ice_candidate", {
        targetParticipantId: BOB,
        candidate: { candidate: "c".repeat(MAX_ICE_CANDIDATE_LENGTH + 1), sdpMid: "0", sdpMLineIndex: 0 },
      }),
    ),
    "too_long",
    "payload.candidate.candidate",
  );

  expectPayloadError(
    parseSignalingMessage(
      envelope("webrtc.ice_candidate", {
        targetParticipantId: BOB,
        candidate: { candidate: "", sdpMid: "m".repeat(65), sdpMLineIndex: 0 },
      }),
    ),
    "too_long",
    "payload.candidate.sdpMid",
  );

  expectPayloadError(
    parseSignalingMessage(envelope("participant.left", { reason: "r".repeat(MAX_REASON_LENGTH + 1) })),
    "too_long",
    "payload.reason",
  );
});

test("ranges and formats are enforced", () => {
  for (const index of [1024, -1, 1.5]) {
    expectPayloadError(
      parseSignalingMessage(
        envelope("webrtc.ice_candidate", {
          targetParticipantId: BOB,
          candidate: { candidate: "", sdpMid: "0", sdpMLineIndex: index },
        }),
      ),
      "out_of_range",
      "payload.candidate.sdpMLineIndex",
    );
  }

  expectPayloadError(
    parseSignalingMessage(
      envelope("webrtc.ice_candidate", {
        targetParticipantId: BOB,
        candidate: { candidate: "candidate:1 1 udp 1 192.0.2.1 5000 typ host", sdpMid: null, sdpMLineIndex: null },
      }),
    ),
    "invalid_format",
    "payload.candidate",
  );

  expectPayloadError(
    parseSignalingMessage(envelope("webrtc.offer", { targetParticipantId: BOB, sdp: "" })),
    "invalid_format",
    "payload.sdp",
  );
  expectPayloadError(
    parseSignalingMessage(envelope("participant.joined", { role: "host", displayName: "" })),
    "invalid_format",
    "payload.displayName",
  );
  expectPayloadError(
    parseSignalingMessage(envelope("participant.joined", { role: "advisor" })),
    "invalid_format",
    "payload.role",
  );
  expectPayloadError(
    parseSignalingMessage(envelope("meeting.started", { startedAt: "2026-09-28T10:00:00+03:00" })),
    "invalid_format",
    "payload.startedAt",
  );
  expectPayloadError(
    parseSignalingMessage(envelope("participant.left", { reason: "Left Early" })),
    "invalid_format",
    "payload.reason",
  );
});

test("session.authenticated requires a known role", () => {
  expectOk(parseSignalingMessage(envelope("session.authenticated", { role: "host" })));
  expectPayloadError(parseSignalingMessage(envelope("session.authenticated", {})), "missing_field", "payload.role");
  expectPayloadError(parseSignalingMessage(envelope("session.authenticated", { role: 1 })), "wrong_type", "payload.role");
  expectPayloadError(
    parseSignalingMessage(envelope("session.authenticated", { role: "admin" })),
    "invalid_format",
    "payload.role",
  );
});

test("session.welcome requires role and a UTC joinedAt", () => {
  expectOk(parseSignalingMessage(envelope("session.welcome", { role: "participant", joinedAt: "2026-09-28T10:00:00Z" })));
  expectPayloadError(
    parseSignalingMessage(envelope("session.welcome", { joinedAt: "2026-09-28T10:00:00Z" })),
    "missing_field",
    "payload.role",
  );
  expectPayloadError(parseSignalingMessage(envelope("session.welcome", { role: "host" })), "missing_field", "payload.joinedAt");
  expectPayloadError(
    parseSignalingMessage(envelope("session.welcome", { role: "host", joinedAt: "2026-09-28T10:00:00+03:00" })),
    "invalid_format",
    "payload.joinedAt",
  );
});

test("session.welcome accepts an optional displayName with the participant.joined rules", () => {
  const named = expectOk(
    parseSignalingMessage(
      envelope("session.welcome", { role: "host", joinedAt: "2026-09-28T10:00:00Z", displayName: "Zoë Müller" }),
    ),
  );
  assert.deepEqual(named.payload, { role: "host", joinedAt: "2026-09-28T10:00:00Z", displayName: "Zoë Müller" });
  const base = { role: "host", joinedAt: "2026-09-28T10:00:00Z" };
  expectPayloadError(
    parseSignalingMessage(envelope("session.welcome", { ...base, displayName: "" })),
    "invalid_format",
    "payload.displayName",
  );
  expectPayloadError(
    parseSignalingMessage(envelope("session.welcome", { ...base, displayName: null })),
    "wrong_type",
    "payload.displayName",
  );
  expectPayloadError(
    parseSignalingMessage(
      envelope("session.welcome", { ...base, displayName: "n".repeat(MAX_DISPLAY_NAME_CODE_POINTS + 1) }),
    ),
    "too_long",
    "payload.displayName",
  );
});

test("session.rejected requires a reason code and accepts an optional detail", () => {
  const withDetail = expectOk(
    parseSignalingMessage(envelope("session.rejected", { code: "invalid_envelope", detail: "message_too_large" })),
  );
  assert.deepEqual(withDetail.payload, { code: "invalid_envelope", detail: "message_too_large" });
  expectPayloadError(parseSignalingMessage(envelope("session.rejected", {})), "missing_field", "payload.code");
  expectPayloadError(
    parseSignalingMessage(envelope("session.rejected", { code: "Not Joined" })),
    "invalid_format",
    "payload.code",
  );
  expectPayloadError(
    parseSignalingMessage(envelope("session.rejected", { code: "not_joined", detail: "Bad-Detail" })),
    "invalid_format",
    "payload.detail",
  );
});

test("session payloads drop undocumented fields", () => {
  const rejected = expectOk(
    parseSignalingMessage(envelope("session.rejected", { code: "rate_limited", sdp: "v=0", echo: { a: 1 } })),
  );
  assert.deepEqual(rejected.payload, { code: "rate_limited" });
  const welcome = expectOk(
    parseSignalingMessage(
      envelope("session.welcome", { role: "host", joinedAt: "2026-09-28T10:00:00Z", tenantId: "x" }),
    ),
  );
  assert.deepEqual(Object.keys(welcome.payload).sort(), ["joinedAt", "role"]);
});

test("participant references must be canonical ULIDs and not self", () => {
  expectPayloadError(
    parseSignalingMessage(envelope("webrtc.offer", { targetParticipantId: "12345", sdp: SMALL_SDP })),
    "invalid_ulid",
    "payload.targetParticipantId",
  );
  expectPayloadError(
    parseSignalingMessage(envelope("webrtc.connected", { peerParticipantId: BOB.toLowerCase() })),
    "invalid_ulid",
    "payload.peerParticipantId",
  );
  expectPayloadError(
    parseSignalingMessage(
      envelope("meeting.ended", { endedAt: "2026-09-28T11:00:00Z", endedByParticipantId: "x" }),
    ),
    "invalid_ulid",
    "payload.endedByParticipantId",
  );
  expectPayloadError(
    parseSignalingMessage(envelope("webrtc.offer", { targetParticipantId: ALICE, sdp: SMALL_SDP })),
    "invalid_format",
    "payload.targetParticipantId",
  );
  expectPayloadError(
    parseSignalingMessage(envelope("webrtc.failed", { peerParticipantId: ALICE, reason: "timeout" })),
    "invalid_format",
    "payload.peerParticipantId",
  );
  // The recipient of meeting.ended may be the participant who ended it.
  expectOk(
    parseSignalingMessage(
      envelope("meeting.ended", { endedAt: "2026-09-28T11:00:00Z", endedByParticipantId: ALICE }),
    ),
  );
});
