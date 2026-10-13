import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, expectTypeOf, it } from "vitest";
import * as sdk from "../src/index.js";
import { ERROR_INFO } from "../src/public/errors.js";
import type {
  CloseReason,
  ConnectionState,
  MediaConnectionStatus,
  MediaKind,
  MeetingEngine,
  MeetingErrorCode,
  MeetingEventMap,
  ParticipantLeftReason,
  ParticipantRole,
  RemoteMedia,
} from "../src/index.js";

describe("public surface", () => {
  it("exports exactly createMeetingEngine and MeetingError at runtime", () => {
    expect(Object.keys(sdk).sort()).toEqual(["MeetingError", "createMeetingEngine"]);
  });

  it("MeetingEngine has exactly the documented members", () => {
    expectTypeOf<keyof MeetingEngine>().toEqualTypeOf<
      | "state"
      | "self"
      | "participants"
      | "localMediaState"
      | "localMedia"
      | "remoteMedia"
      | "mediaConnectionStatus"
      | "join"
      | "leave"
      | "enableCamera"
      | "disableCamera"
      | "mute"
      | "unmute"
      | "startScreenShare"
      | "stopScreenShare"
      | "on"
      | "dispose"
    >();
  });

  it("MeetingEventMap has exactly the documented events", () => {
    expectTypeOf<keyof MeetingEventMap>().toEqualTypeOf<
      | "state_changed"
      | "joined"
      | "participant_joined"
      | "participant_left"
      | "participant_reconnected"
      | "participant_media_changed"
      | "local_media_changed"
      | "remote_media_changed"
      | "media_connection_changed"
      | "error"
      | "closed"
    >();
  });

  it("remote media types match the contract", () => {
    expectTypeOf<MediaConnectionStatus>().toEqualTypeOf<"connecting" | "connected" | "interrupted" | "failed">();
    expectTypeOf<keyof RemoteMedia>().toEqualTypeOf<"camera" | "microphone" | "screen">();
    expectTypeOf<RemoteMedia["camera"]>().toEqualTypeOf<MediaStream | null>();
    expectTypeOf<MeetingEventMap["remote_media_changed"]>().toEqualTypeOf<{
      readonly participantId: string;
      readonly kind: MediaKind;
      readonly stream: MediaStream | null;
    }>();
    expectTypeOf<MeetingEventMap["media_connection_changed"]>().toEqualTypeOf<{
      readonly participantId: string;
      readonly status: MediaConnectionStatus | null;
    }>();
  });

  it("public sources use no `any` and no media topology vocabulary in names, comments or messages", () => {
    const terms = ["p2p", "peer-to-peer", "sfu", "mediasoup", "turn", "ice", "sdp", "router", "transport", "producer", "consumer", "webrtc"];
    const termPattern = new RegExp(`(?<![\\w-])(${terms.map((t) => t.replace(/-/g, "\\-")).join("|")})(?![\\w-])`, "gi");
    for (const file of ["types.ts", "errors.ts"]) {
      const source = readFileSync(join(import.meta.dirname, "..", "src", "public", file), "utf8");
      expect([...source.matchAll(termPattern)].map((m) => m[0]), file).toEqual([]);
      const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
      expect([...code.matchAll(/(?<![\w$."'])any(?![\w$"'])/g)], file).toHaveLength(0);
    }
    for (const code of ["media_connection_failed", "media_participant_limit"] as const) {
      expect(ERROR_INFO[code].message).not.toMatch(termPattern);
    }
  });

  it("string unions match the contract", () => {
    expectTypeOf<ConnectionState>().toEqualTypeOf<"idle" | "connecting" | "joining" | "joined" | "leaving" | "closed">();
    expectTypeOf<ParticipantRole>().toEqualTypeOf<"host" | "participant">();
    expectTypeOf<MediaKind>().toEqualTypeOf<"camera" | "microphone" | "screen">();
    expectTypeOf<ParticipantLeftReason>().toEqualTypeOf<"left" | "disconnected" | "removed" | "meeting_ended" | "other">();
    expectTypeOf<CloseReason>().toEqualTypeOf<
      "left" | "meeting_ended" | "session_replaced" | "connection_lost" | "join_failed" | "error"
    >();
    expectTypeOf<MeetingErrorCode>().toEqualTypeOf<
      | "join_token_invalid"
      | "join_token_expired"
      | "origin_not_allowed"
      | "connection_failed"
      | "join_timeout"
      | "join_cancelled"
      | "connection_lost"
      | "session_replaced"
      | "service_unavailable"
      | "rate_limited"
      | "meeting_ended"
      | "protocol_error"
      | "already_joined"
      | "engine_closed"
      | "not_joined"
      | "not_permitted"
      | "permission_denied"
      | "device_not_found"
      | "device_unavailable"
      | "screen_share_cancelled"
      | "unsupported_environment"
      | "media_connection_failed"
      | "media_participant_limit"
    >();
  });
});
