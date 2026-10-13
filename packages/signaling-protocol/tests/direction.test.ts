import assert from "node:assert/strict";
import test from "node:test";
import { MESSAGE_CATALOG, MESSAGE_TYPES, decodeSignalingFrame, parseSignalingMessage } from "../src/index.js";
import type { ReceiveDirection } from "../src/index.js";
import { envelope, validEnvelope } from "./helpers.js";

const DIRECTIONS: ReceiveDirection[] = ["client_to_server", "server_to_client"];

test("every type is accepted exactly in its allowed directions", () => {
  for (const type of MESSAGE_TYPES) {
    for (const direction of DIRECTIONS) {
      const allowed = MESSAGE_CATALOG[type].direction;
      const expectOk = allowed === "both" || allowed === direction;
      const result = parseSignalingMessage(validEnvelope(type), { direction });
      assert.equal(result.ok, expectOk, `${type} as ${direction}`);
      if (!result.ok) {
        assert.equal(result.error.code, "direction_not_allowed");
        assert.equal(result.error.field, "type");
      }
    }
  }
});

test("clients cannot send platform-authoritative events", () => {
  for (const type of ["meeting.ended", "meeting.terminated", "meeting.started", "participant.joined", "participant.left"] as const) {
    const result = parseSignalingMessage(validEnvelope(type), { direction: "client_to_server" });
    assert.equal(result.ok, false, type);
    if (!result.ok) assert.equal(result.error.code, "direction_not_allowed");
  }
});

test("clients cannot send session notices", () => {
  for (const type of ["session.authenticated", "session.welcome", "session.rejected"] as const) {
    const result = parseSignalingMessage(validEnvelope(type), { direction: "client_to_server" });
    assert.equal(result.ok, false, type);
    if (!result.ok) assert.equal(result.error.code, "direction_not_allowed");
    assert.equal(parseSignalingMessage(validEnvelope(type), { direction: "server_to_client" }).ok, true, type);
  }
});

test("connectivity-server pushes are server-only and restart results are client-only", () => {
  const push = parseSignalingMessage(validEnvelope("session.ice_servers"), { direction: "client_to_server" });
  assert.equal(push.ok, false);
  if (!push.ok) assert.equal(push.error.code, "direction_not_allowed");
  const result = parseSignalingMessage(validEnvelope("webrtc.ice_restart_result"), { direction: "server_to_client" });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "direction_not_allowed");
  for (const direction of DIRECTIONS) {
    assert.equal(parseSignalingMessage(validEnvelope("webrtc.ice_restart"), { direction }).ok, true, direction);
  }
});

test("the server cannot emit client-only requests", () => {
  const result = parseSignalingMessage(validEnvelope("participant.join"), { direction: "server_to_client" });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "direction_not_allowed");
});

test("relayed WebRTC negotiation is accepted both ways", () => {
  for (const type of ["webrtc.offer", "webrtc.answer", "webrtc.ice_candidate"] as const) {
    for (const direction of DIRECTIONS) {
      assert.equal(parseSignalingMessage(validEnvelope(type), { direction }).ok, true, `${type} ${direction}`);
    }
  }
});

test("without a direction option every valid message is accepted", () => {
  for (const type of MESSAGE_TYPES) {
    assert.equal(parseSignalingMessage(validEnvelope(type)).ok, true, type);
  }
});

test("direction is checked before envelope fields and payload", () => {
  const result = parseSignalingMessage(
    envelope("meeting.ended", { endedAt: "not-a-time" }, { meetingId: "bad" }),
    { direction: "client_to_server" },
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "direction_not_allowed");
});

test("decodeSignalingFrame forwards the direction option", () => {
  const frame = JSON.stringify(validEnvelope("meeting.ended"));
  assert.equal(decodeSignalingFrame(frame).ok, true);
  const result = decodeSignalingFrame(frame, { direction: "client_to_server" });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "direction_not_allowed");
});
