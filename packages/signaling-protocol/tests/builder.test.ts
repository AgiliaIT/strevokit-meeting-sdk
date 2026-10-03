import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_MESSAGE_BYTES,
  MESSAGE_TYPES,
  SignalingProtocolError,
  createSignalingMessage,
  decodeSignalingFrame,
  encodeSignalingMessage,
  parseSignalingMessage,
} from "../src/index.js";
import type { SignalingMessage } from "../src/index.js";
import { ALICE, BOB, MEETING, SMALL_SDP, VALID_PAYLOADS } from "./helpers.js";

test("createSignalingMessage stamps version 1 and passes validation for every type", () => {
  for (const type of MESSAGE_TYPES) {
    const message = createSignalingMessage(type, {
      meetingId: MEETING,
      participantId: ALICE,
      payload: structuredClone(VALID_PAYLOADS[type]) as never,
    });
    assert.equal(message.version, 1);
    assert.equal(message.type, type);
    const reparsed = parseSignalingMessage(message);
    assert.equal(reparsed.ok, true, type);
  }
});

test("encode then decode round-trips to an equal message", () => {
  for (const type of MESSAGE_TYPES) {
    const message = createSignalingMessage(type, {
      meetingId: MEETING,
      participantId: ALICE,
      payload: structuredClone(VALID_PAYLOADS[type]) as never,
    });
    const frame = encodeSignalingMessage(message);
    const decoded = decodeSignalingFrame(frame);
    assert.equal(decoded.ok, true, type);
    if (decoded.ok) assert.deepEqual(decoded.message, message);
  }
});

test("typed narrowing works on the discriminated union", () => {
  const message: SignalingMessage = createSignalingMessage("webrtc.offer", {
    meetingId: MEETING,
    participantId: ALICE,
    payload: { targetParticipantId: BOB, sdp: SMALL_SDP },
  });
  if (message.type === "webrtc.offer") {
    assert.equal(message.payload.sdp, SMALL_SDP);
  } else {
    assert.fail("expected webrtc.offer");
  }
});

test("createSignalingMessage throws SignalingProtocolError on invalid input", () => {
  assert.throws(
    () =>
      createSignalingMessage("webrtc.offer", {
        meetingId: MEETING,
        participantId: ALICE,
        payload: { targetParticipantId: "nope", sdp: SMALL_SDP },
      }),
    (error: unknown) =>
      error instanceof SignalingProtocolError &&
      error.rejection.code === "invalid_payload" &&
      error.rejection.detail === "invalid_ulid",
  );
  assert.throws(
    () =>
      createSignalingMessage("participant.join", {
        meetingId: "12345",
        participantId: ALICE,
        payload: {},
      }),
    (error: unknown) =>
      error instanceof SignalingProtocolError && error.rejection.code === "invalid_envelope",
  );
});

test("encodeSignalingMessage serializes only documented fields", () => {
  const padded = {
    version: 1,
    type: "participant.join",
    meetingId: MEETING,
    participantId: ALICE,
    payload: { padding: "x".repeat(MAX_MESSAGE_BYTES) },
    extra: "dropped",
  } as unknown as SignalingMessage;
  const frame = encodeSignalingMessage(padded);
  assert.equal(
    frame,
    JSON.stringify({ version: 1, type: "participant.join", meetingId: MEETING, participantId: ALICE, payload: {} }),
  );
});

test("encodeSignalingMessage refuses invalid messages", () => {
  const invalid = {
    version: 2,
    type: "participant.join",
    meetingId: MEETING,
    participantId: ALICE,
    payload: {},
  } as unknown as SignalingMessage;
  assert.throws(
    () => encodeSignalingMessage(invalid),
    (error: unknown) =>
      error instanceof SignalingProtocolError && error.rejection.code === "unsupported_version",
  );
});

test("encodeSignalingMessage throws message_too_large when a valid message serializes above the limit", () => {
  // 48 KiB of SDP made of characters JSON escapes to 6 bytes each (\u0001) blows past 64 KiB when framed.
  const sdp = "\u0001".repeat(12000);
  const offer = createSignalingMessage("webrtc.offer", {
    meetingId: MEETING,
    participantId: ALICE,
    payload: { targetParticipantId: BOB, sdp },
  });
  assert.throws(
    () => encodeSignalingMessage(offer),
    (error: unknown) =>
      error instanceof SignalingProtocolError &&
      error.rejection.code === "invalid_envelope" &&
      error.rejection.detail === "message_too_large",
  );
});
