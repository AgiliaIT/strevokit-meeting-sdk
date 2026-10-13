# Changelog

All notable changes to `@strevokit/signaling-protocol` are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this package uses [Semantic Versioning](https://semver.org/). See the compatibility policy in [README.md](./README.md#compatibility-policy).

## [Unreleased]

## [1.5.0] - 2026-10-06

Additive under the compatibility policy. `PROTOCOL_VERSION` stays `1`, and every 1.4.0 message is unchanged.

### Added

- `session.welcome` gains optional `iceServersExpireAt` (RFC 3339 UTC): when the credentials in `iceServers` stop being accepted. It is present only when an entry carries credentials. Receivers may treat its presence as support for the messages below.
- `session.ice_servers` (server to client): `{ iceServers, expiresAt }`. It replaces the connectivity servers used for future connection attempts. A connection that relies on the previous credentials should move to a fresh path before the previous expiry. `iceServers` follows the welcome's rules and may be empty.
- `webrtc.ice_restart` (both directions, relayed to the target): `{ targetParticipantId }`. It asks the peer that creates offers to restart connectivity checks for the shared connection.
- `webrtc.connected` gains optional `path`, `localPath`, and `remotePath`, each an open reason code. The known values are `direct` and `relayed`. `path` is `relayed` when either side uses a relay; `localPath` describes the sender's own side and `remotePath` the other participant's side, as seen by the sender.
- `webrtc.ice_restart_result` (client to server): `{ peerParticipantId, outcome }`, with `outcome` an open reason code. The known values are `completed` and `failed`.
- Exported types `MediaPath` and `IceRestartOutcome`.
- Conformance samples for the new fields and types, and for malformed and wrong-direction variants.

## [1.4.0] - 2026-10-04

Additive under the compatibility policy. `PROTOCOL_VERSION` stays `1`, and every 1.3.0 message is unchanged.

### Added

- `session.welcome` gains optional `mediaMode` (`"p2p"` or `"sfu"`) and `iceServers`, which the client uses to set up media. Older clients ignore both. The payload is now `{ role, joinedAt, displayName?, mediaMode?, iceServers? }`.
- `iceServers` is an array of at most `MAX_ICE_SERVERS` entries `{ urls, username?, credential? }`. `urls` holds 1 to `MAX_ICE_SERVER_URLS` strings starting with `stun:`, `stuns:`, `turn:`, or `turns:`, each at most `MAX_ICE_SERVER_URL_LENGTH` long. `username` and `credential` are bounded by `MAX_ICE_SERVER_USERNAME_LENGTH` and `MAX_ICE_SERVER_CREDENTIAL_LENGTH`. Unknown keys in entries are dropped.
- Exported types `MediaMode` and `IceServerConfig`, and the new limit constants.
- Conformance samples for welcomes with media fields, and for malformed ones.

## [1.3.0] - 2026-10-01

Additive under the compatibility policy. `PROTOCOL_VERSION` stays `1`, and every 1.2.0 message is unchanged.

### Added

- Role policy exports: `ROLE_POLICY`, `allowedRoles(type)`, and `isRoleAllowed(type, role)`. The table is the single source of which roles may send which message types. It currently limits `media.screen.started` and `media.screen.stopped` to `host`, and allows every other type for all roles. The realtime service enforces it, and clients can check it before sending.

## [1.2.0] - 2026-09-30

Additive under the compatibility policy. `PROTOCOL_VERSION` stays `1`, and every 1.1.0 message is unchanged.

### Added

- `session.welcome` gains an optional `displayName`: the recipient's own display name, as the realtime service looked it up. It follows the same rules as `participant.joined.displayName` (non-empty string, at most `MAX_DISPLAY_NAME_CODE_POINTS`) and is omitted when the name is unknown. The payload is now `{ role, joinedAt, displayName? }`.
- Conformance samples for `session.welcome` with a `displayName`, and for an empty, over-limit, or non-string one.

## [1.1.0] - 2026-09-29

Additive under the compatibility policy. `PROTOCOL_VERSION` stays `1`, and every 1.0.0 message is unchanged.

### Added

- The `session` family (server to client only), used by the realtime service: `session.authenticated { role }`, `session.welcome { role, joinedAt }` and `session.rejected { code, detail? }`. The envelope `participantId` is the recipient. The catalog now has 23 types.
- The `SessionRejectionCode` type listing the known `session.rejected.code` values.
- Conformance samples for the new types, including client-sent `session.*` → `direction_not_allowed`.

## [1.0.0] - 2026-09-28

### Added

- Protocol version `1` with the envelope `{ version, type, meetingId, participantId, payload }`. `participantId` is always the sender; identifiers are canonical ULIDs.
- The v1 catalog: 20 message types in four families (participant, WebRTC P2P, media state, meeting), each with a typed payload and an allowed direction.
- Validation that never throws: `parseSignalingMessage` and `decodeSignalingFrame`, with a fixed check order and five reason codes (`invalid_envelope`, `unsupported_version`, `unknown_type`, `direction_not_allowed`, `invalid_payload`).
- Limits: `MAX_MESSAGE_BYTES` (65,536), `MAX_SDP_BYTES` (49,152), `MAX_ICE_CANDIDATE_LENGTH`, `MAX_DISPLAY_NAME_CODE_POINTS`, `MAX_REASON_LENGTH`.
- Outbound helpers: `createSignalingMessage` and `encodeSignalingMessage`, which stamp the version and refuse invalid or oversized messages.
- The test-only `@strevokit/signaling-protocol/conformance` entry point: shared valid and invalid samples, realistic SDP fixtures, and `expectedOutcome`.
