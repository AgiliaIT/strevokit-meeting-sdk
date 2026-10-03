# Changelog

All notable changes to `@strevokit/signaling-protocol` are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this package uses [Semantic Versioning](https://semver.org/). See the compatibility policy in [README.md](./README.md#compatibility-policy).

## [Unreleased]

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
