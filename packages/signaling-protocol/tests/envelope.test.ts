import assert from "node:assert/strict";
import test from "node:test";
import { MAX_MESSAGE_BYTES, decodeSignalingFrame, parseSignalingMessage } from "../src/index.js";
import type { ParseResult } from "../src/index.js";
import { ALICE, BOB, MEETING, envelope, validEnvelope } from "./helpers.js";

/** Asserts the parse was rejected with `code`, and with `detail` and `field` when given. */
function expectError(result: ParseResult, code: string, detail?: string, field?: string) {
  assert.equal(result.ok, false, "expected rejection");
  if (result.ok) return;
  assert.equal(result.error.code, code);
  if (detail !== undefined) assert.equal(result.error.detail, detail);
  if (field !== undefined) assert.equal(result.error.field, field);
}

test("missing or unsupported version is rejected with unsupported_version", () => {
  const base = validEnvelope("participant.join");
  const { version: _omit, ...withoutVersion } = base;
  expectError(parseSignalingMessage(withoutVersion), "unsupported_version", undefined, "version");
  for (const version of ["1", 1.5, 0, -1, 2, Number.MAX_SAFE_INTEGER, null, true, NaN]) {
    expectError(parseSignalingMessage({ ...base, version }), "unsupported_version");
  }
});

test("unknown types are rejected without normalization", () => {
  for (const type of [
    "participant.teleport",
    "sfu.producer.created",
    "recording.started",
    "ping",
    "",
    "Participant.Join",
    "participant.join ",
    " participant.join",
    "participant..join",
    "constructor",
    "__proto__",
    42,
    null,
  ]) {
    expectError(parseSignalingMessage(envelope(type as string, {})), "unknown_type", undefined, "type");
  }
  const { type: _omit, ...withoutType } = validEnvelope("participant.join");
  expectError(parseSignalingMessage(withoutType), "unknown_type");
});

test("invalid identifiers are rejected with invalid_envelope / invalid_ulid", () => {
  const base = validEnvelope("participant.join");
  for (const field of ["meetingId", "participantId"] as const) {
    for (const value of [undefined, "", MEETING.toLowerCase(), "12345", 12345, "01JQBBBBBBBBBBBBBBBBBBBBBBB"]) {
      const input = { ...base, [field]: value };
      if (value === undefined) delete input[field];
      expectError(parseSignalingMessage(input), "invalid_envelope", "invalid_ulid", field);
    }
  }
});

test("non-object payloads are rejected with invalid_envelope / payload_not_object", () => {
  const base = validEnvelope("participant.join");
  for (const payload of [undefined, null, [], "x", 1]) {
    const input = { ...base, payload };
    if (payload === undefined) delete input.payload;
    expectError(parseSignalingMessage(input), "invalid_envelope", "payload_not_object", "payload");
  }
});

test("non-object inputs are rejected with invalid_envelope / not_an_object", () => {
  for (const input of [undefined, null, 42, "text", [], [validEnvelope("participant.join")], true]) {
    expectError(parseSignalingMessage(input), "invalid_envelope", "not_an_object");
  }
});

test("checks run in order and the earliest failure wins", () => {
  expectError(
    parseSignalingMessage({ version: 2, type: "participant.join", meetingId: "bad", participantId: ALICE, payload: {} }),
    "unsupported_version",
  );
  expectError(
    parseSignalingMessage(envelope("participant.teleport", "not-an-object", { meetingId: "bad" })),
    "unknown_type",
  );
  expectError(
    parseSignalingMessage(envelope("webrtc.offer", { sdp: 5 }, { meetingId: "bad" })),
    "invalid_envelope",
    "invalid_ulid",
    "meetingId",
  );
  // A future v2 with a reshaped envelope is reported as unsupported_version, not invalid_envelope.
  expectError(
    parseSignalingMessage({ version: 2, kind: "participant.join", room: MEETING, from: ALICE, data: {} }),
    "unsupported_version",
  );
});

test("frame entry point: non-text, bad JSON, and oversized frames", () => {
  expectError(decodeSignalingFrame(new Uint8Array([123, 125])), "invalid_envelope", "not_text");
  expectError(decodeSignalingFrame(42), "invalid_envelope", "not_text");
  expectError(decodeSignalingFrame(undefined), "invalid_envelope", "not_text");
  expectError(decodeSignalingFrame("{oops"), "invalid_envelope", "invalid_json");
  expectError(decodeSignalingFrame(""), "invalid_envelope", "invalid_json");
  expectError(decodeSignalingFrame("x".repeat(MAX_MESSAGE_BYTES + 1)), "invalid_envelope", "message_too_large");
});

test("a frame of exactly MAX_MESSAGE_BYTES is not size-rejected", () => {
  const skeleton = JSON.stringify(envelope("participant.join", {}, { pad: "" }));
  const pad = "p".repeat(MAX_MESSAGE_BYTES - skeleton.length);
  const frame = JSON.stringify(envelope("participant.join", {}, { pad }));
  assert.equal(Buffer.byteLength(frame, "utf8"), MAX_MESSAGE_BYTES);
  const result = decodeSignalingFrame(frame);
  assert.equal(result.ok, true);
});

test("oversize is measured in UTF-8 bytes, not string length", () => {
  const skeleton = JSON.stringify(envelope("participant.join", {}, { pad: "" }));
  const pad = "€".repeat(Math.ceil((MAX_MESSAGE_BYTES - skeleton.length) / 3) + 1);
  const frame = JSON.stringify(envelope("participant.join", {}, { pad }));
  assert.ok(frame.length < MAX_MESSAGE_BYTES);
  assert.ok(Buffer.byteLength(frame, "utf8") > MAX_MESSAGE_BYTES);
  expectError(decodeSignalingFrame(frame), "invalid_envelope", "message_too_large");
});

test("deeply nested JSON never throws", () => {
  const depth = 30000;
  const nested = "[".repeat(depth) + "]".repeat(depth);
  const bare = decodeSignalingFrame(nested);
  assert.equal(bare.ok, false);
  if (!bare.ok) assert.equal(bare.error.code, "invalid_envelope");

  const inside = `{"version":1,"type":"participant.join","meetingId":"${MEETING}","participantId":"${ALICE}","payload":{},"x":${"[".repeat(20000)}${"]".repeat(20000)}}`;
  const result = decodeSignalingFrame(inside);
  assert.equal(typeof result.ok, "boolean");
});

test("rejections never echo input values", () => {
  const markers = {
    sdp: "v=0 MARKER_SDP_BODY_7f3a",
    displayName: "MARKER_DISPLAY_NAME_Zoë",
    candidate: "candidate:MARKER_CANDIDATE 1 udp 1 192.0.2.1 5000 typ host",
    id: "MARKERIDNOTAULID",
    type: "MARKER_TYPE.nope",
  };
  const rejections: ParseResult[] = [
    parseSignalingMessage(envelope("webrtc.offer", { targetParticipantId: ALICE, sdp: markers.sdp })),
    parseSignalingMessage(envelope("webrtc.offer", { targetParticipantId: markers.id, sdp: markers.sdp })),
    parseSignalingMessage(envelope("participant.joined", { role: markers.displayName, displayName: markers.displayName })),
    parseSignalingMessage(
      envelope("webrtc.ice_candidate", {
        targetParticipantId: BOB,
        candidate: { candidate: markers.candidate, sdpMid: null, sdpMLineIndex: null },
      }),
    ),
    parseSignalingMessage(envelope(markers.type, {})),
    parseSignalingMessage(envelope("participant.join", {}, { meetingId: markers.id })),
    decodeSignalingFrame(`{"sdp":"${markers.sdp}"`),
  ];
  for (const result of rejections) {
    assert.equal(result.ok, false);
    const serialized = JSON.stringify(result);
    for (const marker of Object.values(markers)) {
      assert.ok(!serialized.includes(marker), `rejection echoed ${marker}: ${serialized}`);
    }
    assert.ok(!serialized.includes("MARKER"), serialized);
  }
});
