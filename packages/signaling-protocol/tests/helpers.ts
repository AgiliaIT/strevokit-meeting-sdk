import type { MessageType } from "../src/catalog.js";
import type { PayloadMap } from "../src/types.js";

export const MEETING = "01JQBBBBBBBBBBBBBBBBBBBBBB";
export const ALICE = "01JQCCCCCCCCCCCCCCCCCCCCCC";
export const BOB = "01JQDDDDDDDDDDDDDDDDDDDDDD";

export const SMALL_SDP =
  "v=0\r\no=- 4611731400430051336 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\na=group:BUNDLE 0\r\n" +
  "m=audio 9 UDP/TLS/RTP/SAVPF 111\r\nc=IN IP4 0.0.0.0\r\na=mid:0\r\na=rtpmap:111 opus/48000/2\r\n";

/** One valid payload per type, with Alice as sender. */
export const VALID_PAYLOADS: { [K in MessageType]: PayloadMap[K] } = {
  "participant.join": {},
  "participant.joined": { role: "host", displayName: "Alice" },
  "participant.leave": {},
  "participant.left": { reason: "left" },
  "participant.reconnected": {},
  "webrtc.offer": { targetParticipantId: BOB, sdp: SMALL_SDP },
  "webrtc.answer": { targetParticipantId: BOB, sdp: SMALL_SDP },
  "webrtc.ice_candidate": {
    targetParticipantId: BOB,
    candidate: {
      candidate: "candidate:842163049 1 udp 1677729535 203.0.113.7 46154 typ srflx raddr 0.0.0.0 rport 0",
      sdpMid: "0",
      sdpMLineIndex: 0,
      usernameFragment: "EsEl",
    },
  },
  "webrtc.connected": { peerParticipantId: BOB },
  "webrtc.disconnected": { peerParticipantId: BOB },
  "webrtc.failed": { peerParticipantId: BOB, reason: "ice_failed" },
  "webrtc.ice_restart": { targetParticipantId: BOB },
  "webrtc.ice_restart_result": { peerParticipantId: BOB, outcome: "completed" },
  "media.camera.started": {},
  "media.camera.stopped": {},
  "media.microphone.started": {},
  "media.microphone.stopped": {},
  "media.screen.started": {},
  "media.screen.stopped": {},
  "meeting.started": { startedAt: "2026-09-28T10:00:00Z" },
  "meeting.ended": { endedAt: "2026-09-28T11:00:00.250Z", endedByParticipantId: BOB },
  "meeting.terminated": { terminatedAt: "2026-09-28T11:30:00Z", reason: "duration_limit" },
  "session.authenticated": { role: "participant" },
  "session.welcome": { role: "host", joinedAt: "2026-09-28T10:00:12.000Z" },
  "session.rejected": { code: "target_not_present" },
  "session.ice_servers": {
    iceServers: [{ urls: ["stun:stun.example.com:3478"] }],
    expiresAt: "2026-09-28T13:00:00Z",
  },
};

export function envelope(
  type: string,
  payload: unknown,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return { version: 1, type, meetingId: MEETING, participantId: ALICE, payload, ...overrides };
}

export function validEnvelope(type: MessageType): Record<string, unknown> {
  return envelope(type, structuredClone(VALID_PAYLOADS[type]));
}
