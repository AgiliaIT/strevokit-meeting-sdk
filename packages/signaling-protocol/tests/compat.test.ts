import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { PROTOCOL_VERSION, SUPPORTED_PROTOCOL_VERSIONS, decodeSignalingFrame, parseSignalingMessage } from "../src/index.js";
import { ALICE, BOB, MEETING, SMALL_SDP, envelope } from "./helpers.js";

test("extra top-level and payload fields are accepted and stripped", () => {
  const result = parseSignalingMessage(
    envelope(
      "webrtc.offer",
      { targetParticipantId: BOB, sdp: SMALL_SDP, foo: 1, nested: { deep: { deeper: true } } },
      { tenantId: "01JQAAAAAAAAAAAAAAAAAAAAAA", extra: "x" },
    ),
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(Object.keys(result.message).sort(), ["meetingId", "participantId", "payload", "type", "version"]);
  assert.deepEqual(Object.keys(result.message.payload).sort(), ["sdp", "targetParticipantId"]);
});

test("extra fields inside the ICE candidate are stripped", () => {
  const result = parseSignalingMessage(
    envelope("webrtc.ice_candidate", {
      targetParticipantId: BOB,
      candidate: { candidate: "", sdpMid: "0", sdpMLineIndex: 0, foundation: "x", relayProtocol: "udp" },
    }),
  );
  assert.equal(result.ok, true);
  if (result.ok && result.message.type === "webrtc.ice_candidate") {
    assert.deepEqual(Object.keys(result.message.payload.candidate).sort(), ["candidate", "sdpMLineIndex", "sdpMid"]);
  }
});

test("hostile keys from a JSON frame are not copied and do not pollute prototypes", () => {
  const frame =
    `{"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}},` +
    `"version":1,"type":"participant.joined","meetingId":"${MEETING}","participantId":"${ALICE}",` +
    `"payload":{"role":"host","__proto__":{"polluted":true}}}`;
  const result = decodeSignalingFrame(frame);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.ok(!Object.hasOwn(result.message, "__proto__"));
  assert.ok(!Object.hasOwn(result.message.payload, "__proto__"));
  assert.equal(Object.getPrototypeOf(result.message), Object.prototype);
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
  assert.deepEqual(Object.keys(result.message.payload), ["role"]);
});

test("protocol and package versions are declared", () => {
  assert.equal(PROTOCOL_VERSION, 1);
  assert.deepEqual([...SUPPORTED_PROTOCOL_VERSIONS], [1]);
  const pkgUrl = new URL("../../package.json", import.meta.url);
  const pkg = JSON.parse(readFileSync(pkgUrl, "utf8")) as { version: string; name: string; dependencies?: object };
  assert.equal(pkg.name, "@strevokit/signaling-protocol");
  assert.equal(pkg.version, "1.3.0");
  assert.equal(pkg.dependencies, undefined, "package must have no runtime dependencies");
});

test("changelog has 1.0.0, 1.1.0, 1.2.0 and 1.3.0 entries", () => {
  const changelog = readFileSync(new URL("../../CHANGELOG.md", import.meta.url), "utf8");
  assert.match(changelog, /^## \[1\.0\.0\]/m);
  assert.match(changelog, /^## \[1\.1\.0\]/m);
  assert.match(changelog, /^## \[1\.2\.0\]/m);
  assert.match(changelog, /^## \[1\.3\.0\]/m);
});

test("a 1.1.0-era session.welcome without displayName is still accepted by 1.2.0", () => {
  const result = parseSignalingMessage(envelope("session.welcome", { role: "host", joinedAt: "2026-09-28T10:00:00Z" }));
  assert.equal(result.ok, true);
  if (result.ok) assert.deepEqual(Object.keys(result.message.payload).sort(), ["joinedAt", "role"]);
});

test("a 1.0.0-era message is still accepted unchanged by 1.1.0", () => {
  const result = decodeSignalingFrame(
    JSON.stringify(envelope("webrtc.offer", { targetParticipantId: BOB, sdp: SMALL_SDP })),
  );
  assert.equal(result.ok, true);
});
