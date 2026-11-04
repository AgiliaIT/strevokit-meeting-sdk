# Backend integration (create, authorize, join token)

The meeting SDK needs a join token for each participant. Tokens are short-lived and single-use. Only your backend can
mint them, because minting needs your Strevokit API credential.

Before minting, your backend usually **creates** the meeting and **authorizes** participants. The full HTTP reference
(methods, paths, bodies, errors) is in [Backend API](../backend-api.md).

**Keep the API credential on your server.** Never ship it in browser code, environment variables exposed to the
browser (such as `VITE_*` or `NEXT_PUBLIC_*`), or mobile apps. The browser only ever receives the join token.

## Flow

1. (Once) Allow-list the origin that hosts your meeting page (`POST /v1/embed-origins`).
2. When your product starts a session, create a meeting (`POST /v1/meetings`) and authorize each person
   (`POST /v1/meetings/{public_id}/participants`).
3. The signed-in user opens a meeting page in your app.
4. The page asks your backend for a join token.
5. Your backend checks that this user may join, then calls `POST /v1/meetings/{public_id}/join-token`.
6. Your backend returns only the token to the page, which passes it to `createMeetingEngine({ token, realtimeUrl })`.

## Example (Node.js with Express)

```ts
import express from "express";

const app = express();
app.use(express.json());

const STREVOKIT_API = "https://api.example.com"; // your Strevokit API base URL
const API_CREDENTIAL = process.env.STREVOKIT_API_CREDENTIAL; // server-side secret, never sent to browsers

const strevokitHeaders = {
  Authorization: `Bearer ${API_CREDENTIAL}`,
  "Content-Type": "application/json",
};

// Once per environment (run from a setup script or admin path):
// await fetch(`${STREVOKIT_API}/v1/embed-origins`, {
//   method: "POST",
//   headers: strevokitHeaders,
//   body: JSON.stringify({ origin: "https://app.example.com" }),
// });

app.post("/api/meetings", requireSignedInUser, async (req, res) => {
  const response = await fetch(`${STREVOKIT_API}/v1/meetings`, {
    method: "POST",
    headers: { ...strevokitHeaders, "Idempotency-Key": crypto.randomUUID() },
    body: JSON.stringify({
      type: "one_to_one",
      max_participants: 2,
      external_reference: req.body.bookingId,
    }),
  });
  if (!response.ok) return res.sendStatus(502);
  const { data: meeting } = await response.json();

  const hostResponse = await fetch(`${STREVOKIT_API}/v1/meetings/${meeting.public_id}/participants`, {
    method: "POST",
    headers: strevokitHeaders,
    body: JSON.stringify({
      external_user_id: String(req.user.id),
      display_name: req.user.displayName,
      role: "host",
    }),
  });
  if (!hostResponse.ok) return res.sendStatus(502);
  const { data: host } = await hostResponse.json();

  // Persist meeting.public_id and host.public_id in your own database, keyed by your booking / room.
  res.status(201).json({ meetingPublicId: meeting.public_id, participantPublicId: host.public_id });
});

app.post("/api/meetings/:meetingId/join-token", requireSignedInUser, async (req, res) => {
  // Your own authorization: may this user join this meeting, and as which Strevokit participant?
  const participantPublicId = await participantFor(req.user, req.params.meetingId);
  if (!participantPublicId) return res.sendStatus(403);

  const response = await fetch(
    `${STREVOKIT_API}/v1/meetings/${encodeURIComponent(req.params.meetingId)}/join-token`,
    {
      method: "POST",
      headers: strevokitHeaders,
      body: JSON.stringify({ participant_public_id: participantPublicId }),
    },
  );
  if (!response.ok) return res.sendStatus(502);

  const { data } = await response.json(); // { token, expires_at, expires_in }
  res.set("Cache-Control", "no-store").json({ token: data.token });
});
```

`requireSignedInUser` and `participantFor` stand for your own session and authorization code.

## Notes

- Create and authorize before the first join-token call; join-token needs an existing participant `public_id`.
- Pass a real `display_name` on authorize; join-token cannot set or change it. If the UI shows **Guest**, authorize
  used a missing or placeholder name, or that step was skipped.
- Mint a new token for every join, including rejoining after `leave()` / `dispose()`.
- Send the join-token response with `Cache-Control: no-store` so the token isn't cached.
- Don't log the token or put it in a URL. The SDK keeps it in memory only.
