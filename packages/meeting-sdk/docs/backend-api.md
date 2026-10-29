# Backend API for meeting clients

Your backend prepares each meeting with the Strevokit HTTP API, then mints a short-lived **join token** for the
browser. The meeting SDK only ever receives that token — never your API credential.

Base URL in the examples: `https://api.example.com` (replace with your Strevokit API host).

## Auth

Every route below requires:

```http
Authorization: Bearer <STREVOKIT_API_CREDENTIAL>
Content-Type: application/json
```

Keep `STREVOKIT_API_CREDENTIAL` on the server only. Never put it in browser code, `VITE_*` / `NEXT_PUBLIC_*`
variables, or mobile apps.

Meeting and participant identifiers in paths and JSON are opaque `public_id` values (26-character Crockford ULIDs).
Responses never include numeric internal database ids.

## Route index

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/v1/embed-origins` | Allow-list a browser origin that may join |
| `GET` | `/v1/embed-origins` | List allow-listed origins |
| `DELETE` | `/v1/embed-origins/{public_id}` | Remove an allow-listed origin |
| `POST` | `/v1/meetings` | Create a meeting |
| `GET` | `/v1/meetings/{public_id}` | Fetch a meeting |
| `POST` | `/v1/meetings/{public_id}/participants` | Authorize (register) a participant |
| `POST` | `/v1/meetings/{public_id}/join-token` | Mint a join token for one participant |
| `POST` | `/v1/meetings/{public_id}/end` | End the meeting for everyone |

## Integration sequence

1. **Allow-list your app origin** (`POST /v1/embed-origins`) once per environment (for example `https://app.example.com`).
   Joins from other origins fail with `origin_not_allowed` at the realtime handshake.
2. **Create a meeting** (`POST /v1/meetings`) when your product starts a session. Store `data.public_id`.
3. **Authorize each person** (`POST /v1/meetings/{public_id}/participants`) as `host` or `participant`. Store each
   `data.public_id` (the participant public id).
4. **Mint a join token** (`POST /v1/meetings/{public_id}/join-token`) when that user opens the meeting page. Return
   only `data.token` to the browser.
5. **Join in the browser** with `createMeetingEngine({ token, realtimeUrl })` (see the [README](../README.md)).

Optional later: `GET /v1/meetings/{public_id}` to read status; `POST /v1/meetings/{public_id}/end` to end from your
backend.

---

## POST /v1/embed-origins

Register one browser origin that may open meetings.

```http
POST /v1/embed-origins
Authorization: Bearer <STREVOKIT_API_CREDENTIAL>
Content-Type: application/json
```

```json
{ "origin": "https://app.example.com" }
```

`origin` must be a full web origin (`http` or `https`, host, optional non-default port). No path, query, fragment, or
wildcards.

**Success:** `201` when newly inserted, `200` when the same origin already exists.

```json
{
  "data": {
    "public_id": "01ARZ3NDEKTSV4RRFFQ69G5FAV",
    "origin": "https://app.example.com",
    "created_at": "2026-09-24T12:00:00.000000Z"
  }
}
```

Also available: `GET /v1/embed-origins` (list) and `DELETE /v1/embed-origins/{public_id}` (`204` on success). An empty
allow-list means joins fail closed until you add at least one origin.

---

## POST /v1/meetings

Create a meeting.

```http
POST /v1/meetings
Authorization: Bearer <STREVOKIT_API_CREDENTIAL>
Content-Type: application/json
Idempotency-Key: <optional opaque string>
```

```json
{
  "type": "one_to_one",
  "max_participants": 2,
  "recording_requested": false,
  "external_reference": "session_9876",
  "empty_timeout_seconds": 300
}
```

| Field | Required | Notes |
|-------|----------|--------|
| `type` | yes | `one_to_one` or `one_to_many` |
| `max_participants` | yes | `2` for `one_to_one`; `3`–`50` for `one_to_many` |
| `recording_requested` | no | Default `false`. Alias `recording` is accepted |
| `scheduled_start` | no | ISO-8601 with timezone; stored as `scheduled_at` |
| `metadata` | no | Flat JSON object; keep it small |
| `external_reference` | no | Your own id, 1–255 characters when present; echoed unchanged |
| `empty_timeout_seconds` | no | `60`–`86400`; default `300`. Idle empty meetings end after this many seconds |

Do not send `tenant_id`, numeric `id`, or a client-chosen media mode — the platform selects delivery.

Optional `Idempotency-Key` (≤255 characters): same key + same body replays the first response; same key + different
body returns `409` `idempotency_conflict`.

**Success:** `201 Created` (idempotent replay may return the original status).

```json
{
  "data": {
    "public_id": "01JB2Q8ABCDEF01234567890AB",
    "external_reference": "session_9876",
    "type": "one_to_one",
    "max_participants": 2,
    "recording_requested": false,
    "recording_allowed": false,
    "status": "created",
    "scheduled_at": null,
    "started_at": null,
    "ended_at": null,
    "end_reason": null,
    "empty_timeout_seconds": 300,
    "metadata": null,
    "created_at": "2026-09-22T12:00:00+00:00",
    "updated_at": "2026-09-22T12:00:00+00:00"
  }
}
```

The response may also include platform-selected fields (for example how media is delivered). Store `public_id` for
later calls.

| Case | HTTP | `error.code` |
|------|------|--------------|
| Missing or invalid credential | 401 | `unauthorized` |
| Bad or missing fields | 422 | `validation_failed` |
| Idempotency key reused with a different body | 409 | `idempotency_conflict` |
| Rate limited | 429 | `rate_limited` (+ `Retry-After`) |
| Suspended tenant | 403 | `forbidden` |

---

## GET /v1/meetings/{public_id}

Fetch the meeting resource for your tenant (same shape as create). Missing or other-tenant ids return `404`
`meeting_not_found`.

---

## POST /v1/meetings/{public_id}/participants

Authorize (register) a participant on a meeting. Call once per person who may join.

```http
POST /v1/meetings/{public_id}/participants
Authorization: Bearer <STREVOKIT_API_CREDENTIAL>
Content-Type: application/json
Idempotency-Key: <optional opaque string>
```

```json
{
  "external_user_id": "user_42",
  "display_name": "Alex",
  "role": "host"
}
```

| Field | Required | Notes |
|-------|----------|--------|
| `external_user_id` | yes | Your user id within this meeting (1–255 chars; not whitespace-only) |
| `display_name` | yes | Shown name (1–255 chars; not whitespace-only) |
| `role` | yes | `host` or `participant` |

**Upsert:** the same `external_user_id` on the same meeting returns the same participant `public_id`, updates name and
role, and does not consume an extra capacity slot. A **new** identity is rejected with `422`
`participant_limit_exceeded` when the meeting already has `max_participants` distinct people.

Optional `Idempotency-Key` behaves like create (same key + different body → `409` `idempotency_conflict`).

**Success:** `201` on first insert, `200` on upsert of an existing identity (idempotent replay returns the stored
status and body).

```json
{
  "data": {
    "public_id": "01JQ4ABCDEF01234567890ABCD",
    "external_user_id": "user_42",
    "display_name": "Alex",
    "role": "host",
    "status": "invited"
  }
}
```

| Case | HTTP | `error.code` |
|------|------|--------------|
| Missing or invalid credential | 401 | `unauthorized` |
| Bad or missing fields | 422 | `validation_failed` |
| Meeting missing or other tenant | 404 | `meeting_not_found` |
| Meeting already `ended` | 409 | `meeting_ended` |
| Meeting `cancelled` / `failed` | 403 | `forbidden` |
| New identity over capacity | 422 | `participant_limit_exceeded` |
| Idempotency conflict | 409 | `idempotency_conflict` |
| Rate limited | 429 | `rate_limited` (+ `Retry-After`) |

---

## POST /v1/meetings/{public_id}/join-token

Mint a short-lived join token for one authorized participant. Mint a **new** token for every join (including rejoin
after leave). Do **not** send `Idempotency-Key` — each successful call issues a new token.

```http
POST /v1/meetings/{public_id}/join-token
Authorization: Bearer <STREVOKIT_API_CREDENTIAL>
Content-Type: application/json
```

```json
{ "participant_public_id": "01JQ4ABCDEF01234567890ABCD" }
```

| Field | Required | Notes |
|-------|----------|--------|
| `participant_public_id` | yes | From authorize; must belong to this meeting |

Do not send `role`, `tenant_id`, or numeric `id`. Role comes from the authorized participant row.

**Success:** `201 Created`

```json
{
  "data": {
    "token": "<compact JWT>",
    "expires_at": "2026-09-24T15:05:00Z",
    "expires_in": 300
  }
}
```

Default TTL is 300 seconds. Treat `token` like a secret: do not log it, put it in URLs, or cache it (`Cache-Control:
no-store` on your app response). Return only the token string to the browser.

| Case | HTTP | `error.code` |
|------|------|--------------|
| Missing or invalid credential | 401 | `unauthorized` |
| Bad or missing `participant_public_id` | 422 | `validation_failed` |
| Meeting missing or other tenant | 404 | `meeting_not_found` |
| Participant missing or not on this meeting | 404 | `participant_not_found` |
| Meeting already `ended` | 409 | `meeting_ended` |
| Meeting `cancelled` / `failed` | 403 | `forbidden` |
| Join-token rate limited | 429 | `rate_limited` (+ `Retry-After`) |

Realtime handshake failures (after you hand the token to the SDK) include `invalid_join_token`, `join_token_expired`,
and `origin_not_allowed`.

---

## POST /v1/meetings/{public_id}/end

End the meeting for everyone from your backend. Optional `Idempotency-Key`. Success returns the updated meeting
resource with `status` `ended` and `end_reason` `tenant_api`.

---

## Errors

Error bodies use a stable `error.code` string (and a message). On `429`, honor `Retry-After`. Prefer mapping known
codes in your backend rather than parsing message text.

## End-to-end example (Node.js)

```ts
const STREVOKIT_API = "https://api.example.com";
const API_CREDENTIAL = process.env.STREVOKIT_API_CREDENTIAL!;

async function strevokit(path: string, init: RequestInit = {}) {
  const response = await fetch(`${STREVOKIT_API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${API_CREDENTIAL}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  if (!response.ok) throw new Error(`Strevokit ${path} → HTTP ${response.status}`);
  if (response.status === 204) return null;
  return response.json();
}

// Once per environment:
await strevokit("/v1/embed-origins", {
  method: "POST",
  body: JSON.stringify({ origin: "https://app.example.com" }),
});

// When your product starts a session:
const { data: meeting } = await strevokit("/v1/meetings", {
  method: "POST",
  headers: { "Idempotency-Key": crypto.randomUUID() },
  body: JSON.stringify({
    type: "one_to_one",
    max_participants: 2,
    external_reference: "booking_123",
  }),
});

const { data: host } = await strevokit(`/v1/meetings/${meeting.public_id}/participants`, {
  method: "POST",
  body: JSON.stringify({
    external_user_id: "user_host",
    display_name: "Alex",
    role: "host",
  }),
});

const { data: guest } = await strevokit(`/v1/meetings/${meeting.public_id}/participants`, {
  method: "POST",
  body: JSON.stringify({
    external_user_id: "user_guest",
    display_name: "Sam",
    role: "participant",
  }),
});

// When that signed-in user opens the meeting page:
const { data: issued } = await strevokit(`/v1/meetings/${meeting.public_id}/join-token`, {
  method: "POST",
  body: JSON.stringify({ participant_public_id: host.public_id }),
});
// Return issued.token to the browser only.
```

## Hand the token to the SDK

```ts
import { createMeetingEngine } from "@strevokit/meeting-sdk";

const engine = createMeetingEngine({
  token, // from your backend
  realtimeUrl: "wss://realtime.example.com",
});
await engine.join();
```

A longer Express-style proxy that creates, authorizes, and mints is in
[examples/backend-integration.md](./examples/backend-integration.md).
