# Changelog

All notable changes to `@strevokit/meeting-sdk` are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the package follows
[semantic versioning](https://semver.org/). Before 1.0.0, breaking changes bump the minor version.

## [Unreleased]

## [0.4.0]

Bundles `@strevokit/signaling-protocol` 1.5.0. No changes are needed in existing integrations.

### Added

- Device choice: `enableCamera(options?)` and `unmute(options?)` accept `MediaDeviceOptions` with a `deviceId` from
  `navigator.mediaDevices.enumerateDevices()`. Calling either while that device kind is already on switches to the
  chosen device in place, without turning it off, so other participants see no interruption.
- A chosen device that is missing rejects with `device_not_found`, and a busy one with `device_unavailable`; the
  device already in use keeps running.

## [0.3.0]

Bundles `@strevokit/signaling-protocol` 1.5.0. Calls connect on more networks and stay connected through credential
renewals, with no changes needed in existing integrations.

## [0.2.0]

Bundles `@strevokit/signaling-protocol` 1.4.0. No changes are needed in existing integrations.

### Added

- Remote media: `remote_media_changed` event and `remoteMedia(participantId)`, so you can render other participants'
  camera and microphone.
- Connection status per participant: `media_connection_changed` event and `mediaConnectionStatus(participantId)`.
- Error codes `media_connection_failed` and `media_participant_limit`.

## [0.1.0]

Bundles `@strevokit/signaling-protocol` 1.3.0.

### Added

- `createMeetingEngine(options)` returning a `MeetingEngine`: `join()`, `leave()`, `dispose()`, and the participant
  list with each participant's role and media state.
- Local media controls: `enableCamera()`, `disableCamera()`, `mute()`, `unmute()`, `startScreenShare()`, and
  `stopScreenShare()`, with `localMediaState` and `localMedia` for self-preview.
- Events: `state_changed`, `joined`, `participant_joined`, `participant_left`, `participant_reconnected`,
  `participant_media_changed`, `local_media_changed`, `error`, and `closed`.
- `MeetingError` with stable codes, user-safe messages, and a `retryable` flag.
