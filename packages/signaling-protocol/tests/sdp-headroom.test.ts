import assert from "node:assert/strict";
import test from "node:test";
import { SDP_FIXTURES } from "../src/conformance/index.js";
import {
  MAX_MESSAGE_BYTES,
  MAX_SDP_BYTES,
  createSignalingMessage,
  decodeSignalingFrame,
  encodeSignalingMessage,
  utf8ByteLength,
} from "../src/index.js";
import { ALICE, BOB, MEETING } from "./helpers.js";

test("realistic SDP fixtures are accepted with at least 2x headroom", () => {
  assert.ok(Object.keys(SDP_FIXTURES).length >= 3);
  for (const [name, sdp] of Object.entries(SDP_FIXTURES)) {
    assert.ok(utf8ByteLength(sdp) < MAX_SDP_BYTES, `${name} SDP exceeds MAX_SDP_BYTES`);
    for (const type of ["webrtc.offer", "webrtc.answer"] as const) {
      const message = createSignalingMessage(type, {
        meetingId: MEETING,
        participantId: ALICE,
        payload: { targetParticipantId: BOB, sdp },
      });
      const frame = encodeSignalingMessage(message);
      const bytes = utf8ByteLength(frame);
      assert.ok(bytes < MAX_MESSAGE_BYTES / 2, `${name} ${type} frame is ${bytes} bytes (>= 50% of limit)`);
      assert.equal(decodeSignalingFrame(frame, { direction: "client_to_server" }).ok, true, name);
    }
  }
});

test("the worst-case P2P fixture is in the expected 20-32 KB range", () => {
  const sdp = SDP_FIXTURES.worstCaseP2P;
  assert.ok(sdp !== undefined);
  const bytes = utf8ByteLength(sdp);
  assert.ok(bytes > 20_000 && bytes < 32_768, `worstCaseP2P is ${bytes} bytes`);
});
