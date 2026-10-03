# Changelog

All notable changes to `@strevokit/meeting-sdk` are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the package follows
[semantic versioning](https://semver.org/). Before 1.0.0, breaking changes bump the minor version.

## [Unreleased]

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
