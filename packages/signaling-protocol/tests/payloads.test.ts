import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_DISPLAY_NAME_CODE_POINTS,
  MAX_ICE_CANDIDATE_LENGTH,
  MAX_ICE_SERVER_CREDENTIAL_LENGTH,
  MAX_ICE_SERVER_URL_LENGTH,
  MAX_ICE_SERVER_URLS,
  MAX_ICE_SERVER_USERNAME_LENGTH,
  MAX_ICE_SERVERS,
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

test("session.welcome accepts optional mediaMode and iceServers", () => {
  const base = { role: "host", joinedAt: "2026-09-28T10:00:00Z" };
  const p2p = expectOk(parseSignalingMessage(envelope("session.welcome", { ...base, mediaMode: "p2p", iceServers: [] })));
  assert.deepEqual(p2p.payload, { ...base, mediaMode: "p2p", iceServers: [] });
  const sfu = expectOk(parseSignalingMessage(envelope("session.welcome", { ...base, mediaMode: "sfu" })));
  assert.deepEqual(sfu.payload, { ...base, mediaMode: "sfu" });
  const servers = [
    { urls: ["stun:stun.example.com:3478"] },
    { urls: ["turn:turn.example.com:3478", "turns:turn.example.com:5349"], username: "u", credential: "c" },
  ];
  const withServers = expectOk(parseSignalingMessage(envelope("session.welcome", { ...base, iceServers: servers })));
  assert.deepEqual(withServers.payload, { ...base, iceServers: servers });
  const fourUrls = ["stun:a.example.com", "stuns:b.example.com", "turn:c.example.com", "turns:d.example.com"];
  expectOk(
    parseSignalingMessage(
      envelope("session.welcome", {
        ...base,
        iceServers: Array.from({ length: MAX_ICE_SERVERS }, () => ({ urls: fourUrls })),
      }),
    ),
  );
  expectOk(
    parseSignalingMessage(
      envelope("session.welcome", {
        ...base,
        iceServers: [{ urls: [`stun:${"s".repeat(MAX_ICE_SERVER_URL_LENGTH - 5)}`], username: "u".repeat(MAX_ICE_SERVER_USERNAME_LENGTH), credential: "c".repeat(MAX_ICE_SERVER_CREDENTIAL_LENGTH) }],
      }),
    ),
  );
});

test("session.welcome rejects malformed mediaMode and iceServers", () => {
  const base = { role: "host", joinedAt: "2026-09-28T10:00:00Z" };
  const welcome = (extra: Record<string, unknown>) => parseSignalingMessage(envelope("session.welcome", { ...base, ...extra }));
  const stun = "stun:stun.example.com";
  const cases: [Record<string, unknown>, string, string][] = [
    [{ mediaMode: 1 }, "wrong_type", "payload.mediaMode"],
    [{ mediaMode: "mesh" }, "invalid_format", "payload.mediaMode"],
    [{ mediaMode: "P2P" }, "invalid_format", "payload.mediaMode"],
    [{ iceServers: "stun:x" }, "wrong_type", "payload.iceServers"],
    [{ iceServers: null }, "wrong_type", "payload.iceServers"],
    [{ iceServers: Array.from({ length: MAX_ICE_SERVERS + 1 }, () => ({ urls: [stun] })) }, "too_long", "payload.iceServers"],
    [{ iceServers: ["stun:x"] }, "wrong_type", "payload.iceServers.0"],
    [{ iceServers: [{}] }, "missing_field", "payload.iceServers.0.urls"],
    [{ iceServers: [{ urls: stun }] }, "wrong_type", "payload.iceServers.0.urls"],
    [{ iceServers: [{ urls: [7] }] }, "wrong_type", "payload.iceServers.0.urls.0"],
    [{ iceServers: [{ urls: [] }] }, "out_of_range", "payload.iceServers.0.urls"],
    [{ iceServers: [{ urls: Array.from({ length: MAX_ICE_SERVER_URLS + 1 }, () => stun) }] }, "out_of_range", "payload.iceServers.0.urls"],
    [{ iceServers: [{ urls: [""] }] }, "invalid_format", "payload.iceServers.0.urls.0"],
    [{ iceServers: [{ urls: ["stun:"] }] }, "invalid_format", "payload.iceServers.0.urls.0"],
    [{ iceServers: [{ urls: ["https://turn.example.com"] }] }, "invalid_format", "payload.iceServers.0.urls.0"],
    [{ iceServers: [{ urls: [`turn:${"t".repeat(MAX_ICE_SERVER_URL_LENGTH)}`] }] }, "too_long", "payload.iceServers.0.urls.0"],
    [{ iceServers: [{ urls: [stun], username: 1 }] }, "wrong_type", "payload.iceServers.0.username"],
    [{ iceServers: [{ urls: [stun], credential: null }] }, "wrong_type", "payload.iceServers.0.credential"],
    [{ iceServers: [{ urls: [stun], username: "u".repeat(MAX_ICE_SERVER_USERNAME_LENGTH + 1) }] }, "too_long", "payload.iceServers.0.username"],
    [{ iceServers: [{ urls: [stun], credential: "c".repeat(MAX_ICE_SERVER_CREDENTIAL_LENGTH + 1) }] }, "too_long", "payload.iceServers.0.credential"],
    [{ iceServers: [{ urls: [stun] }, { urls: ["http://x"] }] }, "invalid_format", "payload.iceServers.1.urls.0"],
  ];
  for (const [extra, detail, field] of cases) expectPayloadError(welcome(extra), detail, field);
});

test("session.welcome accepts an optional UTC iceServersExpireAt", () => {
  const base = { role: "host", joinedAt: "2026-09-28T10:00:00Z", mediaMode: "p2p" };
  const servers = [{ urls: ["turn:turn.example.com:3478"], username: "u", credential: "c" }];
  const welcome = expectOk(
    parseSignalingMessage(
      envelope("session.welcome", { ...base, iceServers: servers, iceServersExpireAt: "2026-09-28T13:00:00Z" }),
    ),
  );
  assert.deepEqual(welcome.payload, { ...base, iceServers: servers, iceServersExpireAt: "2026-09-28T13:00:00Z" });
  expectPayloadError(
    parseSignalingMessage(envelope("session.welcome", { ...base, iceServersExpireAt: 1780000000 })),
    "wrong_type",
    "payload.iceServersExpireAt",
  );
  expectPayloadError(
    parseSignalingMessage(envelope("session.welcome", { ...base, iceServersExpireAt: "2026-09-28T13:00:00+03:00" })),
    "invalid_format",
    "payload.iceServersExpireAt",
  );
});

test("session.ice_servers requires a bounded server list and a UTC expiresAt", () => {
  const servers = [
    { urls: ["stun:stun.example.com:3478"] },
    { urls: ["turn:turn.example.com:3478?transport=udp", "turn:turn.example.com:3478?transport=tcp"], username: "u", credential: "c" },
  ];
  const full = expectOk(
    parseSignalingMessage(envelope("session.ice_servers", { iceServers: servers, expiresAt: "2026-09-28T13:00:00Z", extra: 1 })),
  );
  assert.deepEqual(full.payload, { iceServers: servers, expiresAt: "2026-09-28T13:00:00Z" });
  const none = expectOk(
    parseSignalingMessage(envelope("session.ice_servers", { iceServers: [], expiresAt: "2026-09-28T13:00:00Z" })),
  );
  assert.deepEqual(none.payload, { iceServers: [], expiresAt: "2026-09-28T13:00:00Z" });

  const push = (payload: Record<string, unknown>) => parseSignalingMessage(envelope("session.ice_servers", payload));
  const cases: [Record<string, unknown>, string, string][] = [
    [{ expiresAt: "2026-09-28T13:00:00Z" }, "missing_field", "payload.iceServers"],
    [{ iceServers: [] }, "missing_field", "payload.expiresAt"],
    [{ iceServers: [], expiresAt: "tomorrow" }, "invalid_format", "payload.expiresAt"],
    [{ iceServers: [], expiresAt: 1780000000 }, "wrong_type", "payload.expiresAt"],
    [{ iceServers: {}, expiresAt: "2026-09-28T13:00:00Z" }, "wrong_type", "payload.iceServers"],
    [
      { iceServers: Array.from({ length: MAX_ICE_SERVERS + 1 }, () => servers[0]), expiresAt: "2026-09-28T13:00:00Z" },
      "too_long",
      "payload.iceServers",
    ],
    [{ iceServers: [{ urls: ["http://x"] }], expiresAt: "2026-09-28T13:00:00Z" }, "invalid_format", "payload.iceServers.0.urls.0"],
  ];
  for (const [payload, detail, field] of cases) expectPayloadError(push(payload), detail, field);
});

test("webrtc.ice_restart targets another participant", () => {
  const restart = expectOk(parseSignalingMessage(envelope("webrtc.ice_restart", { targetParticipantId: BOB, sdp: "x" })));
  assert.deepEqual(restart.payload, { targetParticipantId: BOB });
  expectPayloadError(
    parseSignalingMessage(envelope("webrtc.ice_restart", {})),
    "missing_field",
    "payload.targetParticipantId",
  );
  expectPayloadError(
    parseSignalingMessage(envelope("webrtc.ice_restart", { targetParticipantId: ALICE })),
    "invalid_format",
    "payload.targetParticipantId",
  );
  expectPayloadError(
    parseSignalingMessage(envelope("webrtc.ice_restart", { targetParticipantId: "12345" })),
    "invalid_ulid",
    "payload.targetParticipantId",
  );
});

test("webrtc.connected accepts an optional open path code", () => {
  for (const path of ["direct", "relayed", "future_path"]) {
    const connected = expectOk(parseSignalingMessage(envelope("webrtc.connected", { peerParticipantId: BOB, path })));
    assert.deepEqual(connected.payload, { peerParticipantId: BOB, path });
  }
  expectPayloadError(
    parseSignalingMessage(envelope("webrtc.connected", { peerParticipantId: BOB, path: "Relayed" })),
    "invalid_format",
    "payload.path",
  );
  expectPayloadError(
    parseSignalingMessage(envelope("webrtc.connected", { peerParticipantId: BOB, path: 1 })),
    "wrong_type",
    "payload.path",
  );
});

test("webrtc.connected accepts optional open localPath and remotePath codes", () => {
  const payload = { peerParticipantId: BOB, path: "relayed", localPath: "relayed", remotePath: "direct" };
  assert.deepEqual(expectOk(parseSignalingMessage(envelope("webrtc.connected", payload))).payload, payload);
  const future = { peerParticipantId: BOB, localPath: "future_path", remotePath: "future_path" };
  assert.deepEqual(expectOk(parseSignalingMessage(envelope("webrtc.connected", future))).payload, future);
  for (const key of ["localPath", "remotePath"]) {
    expectPayloadError(
      parseSignalingMessage(envelope("webrtc.connected", { peerParticipantId: BOB, [key]: "Relayed" })),
      "invalid_format",
      `payload.${key}`,
    );
    expectPayloadError(
      parseSignalingMessage(envelope("webrtc.connected", { peerParticipantId: BOB, [key]: 1 })),
      "wrong_type",
      `payload.${key}`,
    );
  }
});

test("webrtc.ice_restart_result carries a peer and an open outcome code", () => {
  for (const outcome of ["completed", "failed", "future_outcome"]) {
    const result = expectOk(
      parseSignalingMessage(envelope("webrtc.ice_restart_result", { peerParticipantId: BOB, outcome })),
    );
    assert.deepEqual(result.payload, { peerParticipantId: BOB, outcome });
  }
  expectPayloadError(
    parseSignalingMessage(envelope("webrtc.ice_restart_result", { peerParticipantId: BOB })),
    "missing_field",
    "payload.outcome",
  );
  expectPayloadError(
    parseSignalingMessage(envelope("webrtc.ice_restart_result", { peerParticipantId: BOB, outcome: "Done!" })),
    "invalid_format",
    "payload.outcome",
  );
  expectPayloadError(
    parseSignalingMessage(envelope("webrtc.ice_restart_result", { peerParticipantId: ALICE, outcome: "completed" })),
    "invalid_format",
    "payload.peerParticipantId",
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
