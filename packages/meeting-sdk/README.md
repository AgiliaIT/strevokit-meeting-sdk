# @strevokit/meeting-sdk

Embed Strevokit meetings in your web product.

The SDK is **headless**: it joins a meeting, keeps the participant list up to date, and controls the local camera,
microphone, and screen share. It has no UI and no runtime dependencies, so it works with any framework. Build your own
interface on top of it, or use the Strevokit UI components when they are available.

- Zero runtime dependencies, one ES module, full TypeScript types.
- One interface (`MeetingEngine`) for every meeting size. Your code never changes when the platform changes how media
  is delivered.
- Stable error codes with user-safe messages.

## Install

```bash
npm install @strevokit/meeting-sdk
```

The package is ESM-only and runs in browsers. Use it through a bundler (Vite, webpack, esbuild, and so on) or a native
`<script type="module">`.

## Quick start

### 1. Prepare the meeting on your backend

Your backend talks to the Strevokit HTTP API with its API credential, then returns only a short-lived join token to the
browser. **Never** send the API credential to the browser. Full request and response shapes:
[Backend API](./docs/backend-api.md).

```ts
// Server side. Headers on every call:
//   Authorization: Bearer ${process.env.STREVOKIT_API_CREDENTIAL}
//   Content-Type: application/json
const api = "https://api.example.com"; // your Strevokit API base URL
const headers = {
  Authorization: `Bearer ${process.env.STREVOKIT_API_CREDENTIAL}`,
  "Content-Type": "application/json",
};

// Once per environment: allow-list the origin that hosts your page.
await fetch(`${api}/v1/embed-origins`, {
  method: "POST",
  headers,
  body: JSON.stringify({ origin: "https://app.example.com" }),
});

// Create the meeting, then authorize each person who may join.
const { data: meeting } = await fetch(`${api}/v1/meetings`, {
  method: "POST",
  headers,
  body: JSON.stringify({ type: "one_to_one", max_participants: 2 }),
}).then((r) => r.json());

const { data: participant } = await fetch(`${api}/v1/meetings/${meeting.public_id}/participants`, {
  method: "POST",
  headers,
  body: JSON.stringify({
    external_user_id: "user_42",
    display_name: "Alex",
    role: "host",
  }),
}).then((r) => r.json());

// When the signed-in user opens the meeting page, mint a join token and return only data.token.
const { data } = await fetch(`${api}/v1/meetings/${meeting.public_id}/join-token`, {
  method: "POST",
  headers,
  body: JSON.stringify({ participant_public_id: participant.public_id }),
}).then((r) => r.json()); // { token, expires_at, expires_in }
```

### 2. Join from the browser

```ts
import { createMeetingEngine, MeetingError } from "@strevokit/meeting-sdk";

const engine = createMeetingEngine({
  token, // from your backend
  realtimeUrl: "wss://realtime.example.com", // your Strevokit realtime endpoint
});

engine.on("joined", ({ self, participants }) => {
  console.log(`Joined as ${self.role} with ${participants.length} others`);
});
engine.on("participant_joined", ({ participant }) => addTile(participant));
engine.on("participant_left", ({ participantId }) => removeTile(participantId));
engine.on("participant_media_changed", ({ participantId, kind, enabled }) => updateTile(participantId, kind, enabled));
engine.on("closed", ({ reason, error }) => showEndScreen(reason, error?.message));

try {
  await engine.join();
} catch (error) {
  if (error instanceof MeetingError) showError(error.message); // safe to show to users
}
```

### 3. Control media

```ts
await engine.enableCamera();
selfPreview.srcObject = engine.localMedia.camera; // a MediaStream for a <video> element

await engine.unmute();
await engine.startScreenShare(); // rejects with `not_permitted` if your role may not share
```

Every media method is idempotent and rejects with a `MeetingError` (for example `permission_denied` or
`device_not_found`) without changing any state.

### 4. Show other participants

```ts
engine.on("remote_media_changed", ({ participantId, kind, stream }) => {
  if (kind === "camera") videoFor(participantId).srcObject = stream; // a <video autoplay playsinline muted>
  if (kind === "microphone") audioFor(participantId).srcObject = stream; // an <audio autoplay>
});
engine.on("media_connection_changed", ({ participantId, status }) => {
  // "connecting" | "connected" | "interrupted" | "failed", or null when there is no connection any more
  showStatus(participantId, status);
});
```

`stream` is `null` when that media stops being available. `engine.remoteMedia(participantId)` and
`engine.mediaConnectionStatus(participantId)` return the current values at any time.

### 5. Leave

```ts
await engine.leave(); // releases camera, microphone, and screen; then `closed` fires with reason "left"
```

An engine joins once. To join again, mint a new token and create a new engine. Call `engine.dispose()` when your
component unmounts; it releases everything immediately and emits nothing.

More examples: [plain HTML](./docs/examples/vanilla.html), [React](./docs/examples/react.tsx), and
[backend integration](./docs/examples/backend-integration.md).

## Browser support

Current versions of Chrome, Edge, Firefox, and Safari. The page must be served over HTTPS (browsers only allow camera,
microphone, and screen access in secure contexts). In an unsupported browser the SDK throws or rejects with
`unsupported_environment`.

## Security

- **The join token stays in memory.** The SDK sends it only during the connection handshake. It never appears in URLs,
  storage, events, error messages, or log output.
- **Identity comes from the token.** Role and participant identity are decided by your backend when it mints the token.
  The SDK never sends a role or identity of its own.
- **Embed origins are allow-listed.** Joins are accepted only from the origins configured for your tenant. A join from
  any other site fails with `origin_not_allowed`.
- **Local development.** `realtimeUrl` must use `wss://`. Plain `ws://` is accepted only for `localhost` and
  `127.0.0.1`.

## Versioning

The package follows [semantic versioning](https://semver.org/). The public API is exactly what
[docs/api-reference.md](./docs/api-reference.md) describes. Before 1.0.0, breaking changes bump the minor version; from
1.0.0 they bump the major version. New event types and error codes may be added in minor versions, so handle unknown
values generically. See the [changelog](./CHANGELOG.md).

## Documentation

- [Backend API](./docs/backend-api.md): create meeting, authorize participants, mint join tokens, and related routes
  (`POST` / `GET` / `DELETE` with request and response shapes).
- [API reference](./docs/api-reference.md): every export, method, event, error code, and close reason.
- [Examples](./docs/examples/).

## Source and releases

The source is published at [github.com/AgiliaIT/strevokit-meeting-sdk](https://github.com/AgiliaIT/strevokit-meeting-sdk).
Releases are published to npm from that repository with npm provenance, and tagged `meeting-sdk-v<version>`. Report
problems through its [issues](https://github.com/AgiliaIT/strevokit-meeting-sdk/issues).
