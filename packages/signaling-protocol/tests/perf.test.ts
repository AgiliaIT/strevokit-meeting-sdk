import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import test from "node:test";
import { SDP_FIXTURES } from "../src/conformance/index.js";
import { createSignalingMessage, decodeSignalingFrame, encodeSignalingMessage, utf8ByteLength } from "../src/index.js";
import { ALICE, BOB, MEETING } from "./helpers.js";

const ITERATIONS = 1_000;
const WARMUP = 200;

test("decoding the largest fixture offer averages under 1 ms", () => {
  const largest = Object.values(SDP_FIXTURES).reduce((a, b) => (utf8ByteLength(b) > utf8ByteLength(a) ? b : a));
  const frame = encodeSignalingMessage(
    createSignalingMessage("webrtc.offer", {
      meetingId: MEETING,
      participantId: ALICE,
      payload: { targetParticipantId: BOB, sdp: largest },
    }),
  );

  for (let i = 0; i < WARMUP; i++) decodeSignalingFrame(frame, { direction: "client_to_server" });

  const start = performance.now();
  for (let i = 0; i < ITERATIONS; i++) {
    const result = decodeSignalingFrame(frame, { direction: "client_to_server" });
    if (!result.ok) assert.fail(`decode failed: ${result.error.code}`);
  }
  const averageMs = (performance.now() - start) / ITERATIONS;
  console.log(`decode ${utf8ByteLength(frame)}-byte offer: ${averageMs.toFixed(4)} ms average over ${ITERATIONS}`);
  assert.ok(averageMs < 1, `average decode ${averageMs} ms`);
});
