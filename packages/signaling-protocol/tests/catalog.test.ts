import assert from "node:assert/strict";
import test from "node:test";
import {
  MESSAGE_CATALOG,
  MESSAGE_TYPES,
  isDirectionAllowed,
  isMessageType,
} from "../src/index.js";

const EXPECTED = {
  participant: [
    "participant.join",
    "participant.joined",
    "participant.leave",
    "participant.left",
    "participant.reconnected",
  ],
  webrtc: [
    "webrtc.offer",
    "webrtc.answer",
    "webrtc.ice_candidate",
    "webrtc.connected",
    "webrtc.disconnected",
    "webrtc.failed",
    "webrtc.ice_restart",
    "webrtc.ice_restart_result",
  ],
  media: [
    "media.camera.started",
    "media.camera.stopped",
    "media.microphone.started",
    "media.microphone.stopped",
    "media.screen.started",
    "media.screen.stopped",
  ],
  meeting: ["meeting.started", "meeting.ended", "meeting.terminated"],
  session: ["session.authenticated", "session.welcome", "session.rejected", "session.ice_servers"],
} as const;

const EXPECTED_DIRECTIONS: Record<string, string> = {
  "participant.join": "client_to_server",
  "participant.joined": "server_to_client",
  "participant.leave": "client_to_server",
  "participant.left": "server_to_client",
  "participant.reconnected": "server_to_client",
  "webrtc.offer": "both",
  "webrtc.answer": "both",
  "webrtc.ice_candidate": "both",
  "webrtc.connected": "client_to_server",
  "webrtc.disconnected": "client_to_server",
  "webrtc.failed": "client_to_server",
  "webrtc.ice_restart": "both",
  "webrtc.ice_restart_result": "client_to_server",
  "media.camera.started": "both",
  "media.camera.stopped": "both",
  "media.microphone.started": "both",
  "media.microphone.stopped": "both",
  "media.screen.started": "both",
  "media.screen.stopped": "both",
  "meeting.started": "server_to_client",
  "meeting.ended": "server_to_client",
  "meeting.terminated": "server_to_client",
  "session.authenticated": "server_to_client",
  "session.welcome": "server_to_client",
  "session.rejected": "server_to_client",
  "session.ice_servers": "server_to_client",
};

test("catalog contains exactly the 26 v1 types", () => {
  const expected = Object.values(EXPECTED).flat();
  assert.equal(MESSAGE_TYPES.length, 26);
  assert.deepEqual([...MESSAGE_TYPES].sort(), [...expected].sort());
});

test("every type has the expected family and direction", () => {
  for (const [family, types] of Object.entries(EXPECTED)) {
    for (const type of types) {
      assert.equal(MESSAGE_CATALOG[type].family, family, type);
      assert.equal(MESSAGE_CATALOG[type].direction, EXPECTED_DIRECTIONS[type], type);
    }
  }
});

test("SFU and recording families are not in v1", () => {
  for (const type of MESSAGE_TYPES) {
    assert.ok(!type.startsWith("sfu."), type);
    assert.ok(!type.startsWith("recording."), type);
  }
  assert.equal(isMessageType("sfu.producer.created"), false);
  assert.equal(isMessageType("recording.started"), false);
});

test("isMessageType ignores prototype keys and non-strings", () => {
  for (const value of ["constructor", "__proto__", "toString", "hasOwnProperty", "", 1, null]) {
    assert.equal(isMessageType(value), false, String(value));
  }
  assert.equal(isMessageType("webrtc.offer"), true);
});

test("catalog is frozen", () => {
  assert.ok(Object.isFrozen(MESSAGE_CATALOG));
  assert.ok(Object.isFrozen(MESSAGE_TYPES));
  assert.ok(Object.isFrozen(MESSAGE_CATALOG["webrtc.offer"]));
});

test("isDirectionAllowed follows catalog directions", () => {
  assert.equal(isDirectionAllowed("participant.join", "client_to_server"), true);
  assert.equal(isDirectionAllowed("participant.join", "server_to_client"), false);
  assert.equal(isDirectionAllowed("meeting.ended", "client_to_server"), false);
  assert.equal(isDirectionAllowed("webrtc.offer", "client_to_server"), true);
  assert.equal(isDirectionAllowed("webrtc.offer", "server_to_client"), true);
});
