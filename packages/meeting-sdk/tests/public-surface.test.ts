import { describe, expect, expectTypeOf, it } from "vitest";
import * as sdk from "../src/index.js";
import type {
  CloseReason,
  ConnectionState,
  MediaKind,
  MeetingEngine,
  MeetingErrorCode,
  MeetingEventMap,
  ParticipantLeftReason,
  ParticipantRole,
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
      | "error"
      | "closed"
    >();
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
    >();
  });
});
