/** Maximum UTF-8 byte length of one serialized frame. The realtime service's WebSocket max payload must be at least this. */
export const MAX_MESSAGE_BYTES = 65536 as const;

/** Maximum UTF-8 byte length of `payload.sdp` on `webrtc.offer` / `webrtc.answer`. */
export const MAX_SDP_BYTES = 49152 as const;

/** Maximum length (UTF-16 code units) of `payload.candidate.candidate`. */
export const MAX_ICE_CANDIDATE_LENGTH = 1024 as const;

/** Maximum Unicode code points of `payload.displayName` (matches the API's display_name default). */
export const MAX_DISPLAY_NAME_CODE_POINTS = 255 as const;

/** Maximum length of a reason code. */
export const MAX_REASON_LENGTH = 64 as const;

export const MAX_SDP_MID_LENGTH = 64 as const;
export const MAX_USERNAME_FRAGMENT_LENGTH = 256 as const;
export const MAX_SDP_MLINE_INDEX = 1023 as const;

/** Maximum entries in `session.welcome.iceServers`. */
export const MAX_ICE_SERVERS = 4 as const;

/** Maximum `urls` per `iceServers` entry. */
export const MAX_ICE_SERVER_URLS = 4 as const;

/** Maximum length of one `iceServers[].urls` element. */
export const MAX_ICE_SERVER_URL_LENGTH = 256 as const;

export const MAX_ICE_SERVER_USERNAME_LENGTH = 256 as const;
export const MAX_ICE_SERVER_CREDENTIAL_LENGTH = 256 as const;
