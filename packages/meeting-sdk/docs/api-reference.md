# API reference

Everything `@strevokit/meeting-sdk` exports is listed here. Anything not listed is internal and cannot be imported
(deep imports such as `@strevokit/meeting-sdk/dist/index.js` are blocked by the package's `exports` map).

```ts
import { createMeetingEngine, MeetingError } from "@strevokit/meeting-sdk";
import type { MeetingEngine, MeetingEngineOptions /* ... */ } from "@strevokit/meeting-sdk";
```

## `createMeetingEngine(options)`

```ts
function createMeetingEngine(options: MeetingEngineOptions): MeetingEngine;
```

Creates an engine in the `idle` state. Nothing connects until you call `join()`.

Throws synchronously:

- `MeetingError` with code `join_token_invalid` when `token` is empty or is not a well-formed join token.
- `MeetingError` with code `unsupported_environment` when the browser has no `WebSocket`.
- `TypeError` when `realtimeUrl` or `joinTimeoutMs` is malformed. This is a programming error, not a runtime condition.

## `MeetingEngineOptions`

| Option | Type | Required | Description |
|---|---|---|---|
| `token` | `string` | yes | Join token minted by your backend. Kept in memory only. |
| `realtimeUrl` | `string` | yes | Realtime endpoint base URL, `wss://host[:port]`. `ws://` is accepted only for `localhost` and `127.0.0.1`. No path, query, fragment, or credentials. |
| `joinTimeoutMs` | `number` | no | How long `join()` waits for admission before rejecting with `join_timeout`. Integer, 1000–60000. Default 15000. |
| `logger` | `MeetingLogger` | no | Diagnostics sink. Receives short messages and allow-listed fields only. |

### `MeetingLogger`

```ts
interface MeetingLogger {
  debug?(message: string, fields?: Readonly<Record<string, string | number | boolean>>): void;
  info?(message: string, fields?: Readonly<Record<string, string | number | boolean>>): void;
  warn?(message: string, fields?: Readonly<Record<string, string | number | boolean>>): void;
  error?(message: string, fields?: Readonly<Record<string, string | number | boolean>>): void;
}
```

Every method is optional. The SDK never passes the join token, connection negotiation details, or raw browser
exception text to the logger. A logger that throws is ignored.

## `MeetingEngine`

```ts
interface MeetingEngine {
  readonly state: ConnectionState;
  readonly self: SelfParticipant | null;
  readonly participants: readonly Participant[];
  readonly localMediaState: MediaState;
  readonly localMedia: LocalMedia;

  join(): Promise<void>;
  leave(): Promise<void>;
  enableCamera(): Promise<void>;
  disableCamera(): Promise<void>;
  mute(): Promise<void>;
  unmute(): Promise<void>;
  startScreenShare(): Promise<void>;
  stopScreenShare(): Promise<void>;
  on<K extends MeetingEventType>(type: K, listener: MeetingEventListener<K>): () => void;
  dispose(): void;
}
```

### Properties

| Property | Description |
|---|---|
| `state` | The current `ConnectionState`. |
| `self` | This participant, set when `joined` fires; `null` before. |
| `participants` | Other participants currently present. Never includes `self`. Empty until `joined`. |
| `localMediaState` | Which local captures are on (`MediaState`). |
| `localMedia` | The local `MediaStream` for each capture, or `null` when it is off (`LocalMedia`). Use it for a self-preview. |

### Methods

| Method | Allowed in | Resolves when | Rejects with |
|---|---|---|---|
| `join()` | `idle` | Admitted to the meeting and the participant list is received. | `join_token_invalid`, `join_token_expired`, `origin_not_allowed`, `connection_failed`, `join_timeout`, `rate_limited`, `service_unavailable`, `session_replaced`, `meeting_ended`, `not_permitted`, `protocol_error`, `join_cancelled`, `unsupported_environment`, `already_joined` (in `connecting`, `joining`, `joined`, `leaving`), `engine_closed` (in `closed`) |
| `leave()` | any state | In `idle`/`closed`: immediately. In `leaving`: with the in-flight leave. In `connecting`/`joining`: the join is cancelled (`join()` rejects with `join_cancelled`). In `joined`: when the platform confirms, or after 5 seconds. | never |
| `enableCamera()` / `disableCamera()` | `joined` | The camera is on and announced / off and announced. | `not_joined`, `permission_denied`, `device_not_found`, `device_unavailable`, `unsupported_environment` |
| `unmute()` / `mute()` | `joined` | The microphone is live and announced / silenced and announced. | same as the camera |
| `startScreenShare()` / `stopScreenShare()` | `joined` | Screen sharing is on and announced / off and announced. | `not_joined`, `not_permitted` (checked before the browser prompt), `screen_share_cancelled`, `permission_denied`, `device_unavailable`, `unsupported_environment` |
| `on(type, listener)` | any state | Returns an unsubscribe function. | never |
| `dispose()` | any state | Releases devices, the connection, and listeners immediately. Emits nothing. Idempotent. A pending `join()` rejects with `join_cancelled`. | never |

Rules for every media method:

1. **Idempotent.** Asking for the state you are already in resolves immediately with no device prompt.
2. **Ordered per kind.** Calls for the same kind run in call order. A call for the state a pending call will reach
   shares that pending promise.
3. **Failure changes nothing.** On rejection, `localMediaState`, `localMedia`, and what other participants see are
   unchanged.
4. **Local change first.** On success, `local_media_changed` fires before the promise resolves.
5. **Browser stop button.** Stopping a screen share from the browser's own control behaves like `stopScreenShare()`.
6. **Leave releases everything.** `leave()` and `dispose()` stop every capture.

Muting keeps the microphone open and silences it, so unmuting is instant. Turning the camera off or stopping a screen
share releases the device.

## States: `ConnectionState`

```ts
type ConnectionState = "idle" | "connecting" | "joining" | "joined" | "leaving" | "closed";
```

| State | Meaning |
|---|---|
| `idle` | Created; `join()` not called yet. |
| `connecting` | Connecting and presenting the join token. |
| `joining` | The token was accepted; waiting for the participant list. |
| `joined` | In the meeting. Media methods are available. |
| `leaving` | `leave()` was called; waiting for the platform to confirm. |
| `closed` | Finished. The engine cannot be reused; create a new one with a new token. |

## Events

Subscribe with `engine.on(type, listener)`. `state_changed` fires on every transition, before the event that caused
it (for example `state_changed` to `joined`, then `joined`). Events are delivered in the order the platform produced
them. A listener that throws does not affect other listeners or the engine.

### `MeetingEventMap`

| Event | Payload | When |
|---|---|---|
| `state_changed` | `{ state: ConnectionState; previous: ConnectionState }` | Every state transition. |
| `joined` | `{ self: SelfParticipant; participants: readonly Participant[] }` | Admitted. `participants` holds everyone already present. |
| `participant_joined` | `{ participant: Participant }` | Someone joined after you. Never fires twice for someone already present. |
| `participant_left` | `{ participantId: string; reason: ParticipantLeftReason }` | Someone left. |
| `participant_reconnected` | `{ participantId: string }` | Someone's connection was replaced (for example, they rejoined from another tab). |
| `participant_media_changed` | `{ participantId: string; kind: MediaKind; enabled: boolean }` | Someone turned a capture on or off. Fires only for actual changes. |
| `local_media_changed` | `{ kind: MediaKind; enabled: boolean; stream: MediaStream \| null }` | Your capture turned on or off. |
| `error` | `{ error: MeetingError }` | A problem that does not end the meeting (for example, a rejected action). |
| `closed` | `{ reason: CloseReason; error?: MeetingError }` | The engine finished. Fires once. Not fired by `dispose()`. |

**The event set is open.** New event types may be added in minor versions. Do not assume `MeetingEventMap` is closed
(for example, with an exhaustive `switch` that fails on unknown types). `on()` delivers only the types you subscribe
to, so new types never reach existing code.

### `MeetingEventType`

`keyof MeetingEventMap`: the union of event names above.

### `MeetingEventListener`

```ts
type MeetingEventListener<K extends MeetingEventType> = (event: MeetingEventMap[K]) => void;
```

## Data types

### `Participant`

| Field | Type | Description |
|---|---|---|
| `id` | `string` | Opaque participant public ID. |
| `role` | `ParticipantRole` | Role assigned by your backend when the token was minted. |
| `displayName` | `string` (optional) | Display name, when the platform knows one. |
| `media` | `MediaState` | Which captures this participant has on. |

### `SelfParticipant`

| Field | Type | Description |
|---|---|---|
| `id` | `string` | Your opaque participant public ID. |
| `role` | `ParticipantRole` | Your role. |
| `displayName` | `string` (optional) | Your display name, when known. |
| `joinedAt` | `string` | ISO-8601 UTC time you were admitted. |

### `ParticipantRole`

`"host" | "participant"`. Only hosts may share their screen in this version.

### `MediaKind`

`"camera" | "microphone" | "screen"`.

### `MediaState`

`{ camera: boolean; microphone: boolean; screen: boolean }`. `true` means on: camera on, microphone unmuted, screen
being shared.

### `LocalMedia`

`{ camera: MediaStream | null; microphone: MediaStream | null; screen: MediaStream | null }`. `null` when that capture
is off.

### `ParticipantLeftReason`

| Reason | Meaning |
|---|---|
| `left` | They chose to leave. |
| `disconnected` | Their connection dropped. |
| `removed` | They were removed from the meeting. |
| `meeting_ended` | The meeting ended. |
| `other` | Any other reason. |

## Errors

### `MeetingError`

```ts
class MeetingError extends Error {
  readonly name: "MeetingError";
  readonly code: MeetingErrorCode;
  readonly retryable: boolean;
}
```

`message` is a short English sentence that is safe to show to users. It never contains browser exception text, stack
traces, or connection details. `retryable` is `true` when trying the same action again later may succeed.

### `MeetingErrorCode`

New codes may be added in minor versions; handle unknown codes generically (for example, show `message`).

| Code | Retryable | Default message | Raised by |
|---|---|---|---|
| `join_token_invalid` | no | This meeting link is not valid. Ask for a new one. | `createMeetingEngine()`, `join()` |
| `join_token_expired` | yes\* | This meeting link has expired. Ask for a new one. | `join()` |
| `origin_not_allowed` | no | This site is not allowed to join this meeting. | `join()` |
| `connection_failed` | yes | Could not connect to the meeting. Check your connection and try again. | `join()` |
| `join_timeout` | yes | Joining the meeting took too long. Please try again. | `join()` |
| `join_cancelled` | no | Joining was cancelled. | `join()` when `leave()` or `dispose()` is called during the join |
| `connection_lost` | yes | The connection to the meeting was lost. | `closed` after joining |
| `session_replaced` | no | You joined this meeting from another tab or device. | `join()`, `closed` |
| `service_unavailable` | yes | The meeting service is temporarily unavailable. Please try again shortly. | `join()`, `closed`, `error` |
| `rate_limited` | yes | Too many attempts. Please wait a moment and try again. | `join()`, `closed`, `error` |
| `meeting_ended` | no | This meeting has ended. | `join()` |
| `protocol_error` | no | Something went wrong in the meeting connection. | `join()`, `error`, `closed` |
| `already_joined` | no | This meeting is already joined or joining. | `join()` |
| `engine_closed` | no | This meeting session has ended. Create a new one to join again. | `join()` |
| `not_joined` | no | Join the meeting first. | media methods |
| `not_permitted` | no | You don't have permission to do that in this meeting. | `join()`, `startScreenShare()`, `error` |
| `permission_denied` | no | Camera or microphone access was blocked. Allow access in your browser settings. | media methods |
| `device_not_found` | no | No camera or microphone was found. | media methods |
| `device_unavailable` | yes | Your camera or microphone is being used by another application. | media methods |
| `screen_share_cancelled` | no | Screen sharing was cancelled. | `startScreenShare()` |
| `unsupported_environment` | no | This browser does not support meetings. Try a current version of Chrome, Edge, Firefox, or Safari. | `createMeetingEngine()`, `join()`, media methods |

\* Retry only with a new token from your backend.

### Close reasons: `CloseReason`

`closed.reason` tells you why the engine finished.

| Reason | When | `closed.error` |
|---|---|---|
| `left` | After your `leave()`. | none |
| `meeting_ended` | The meeting ended while you were in it. | none |
| `session_replaced` | You joined the same meeting from another tab or device. | `session_replaced` |
| `connection_lost` | The connection dropped after joining. | `connection_lost` |
| `join_failed` | Any failure before joining completed. `join()` rejected with the same error. | always set |
| `error` | The platform closed the connection after joining for another reason (for example `service_unavailable` or `rate_limited`). | the matching code |
