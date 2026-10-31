# Easy Elm Intercom relay

Small WebSocket relay for Easy Elm Intercom Cellular / Holo apps. Phones that are not on the
same Wi-Fi connect to `wss://<host>/ws?room=<6-digit code>` with header `x-app-token`, and the
relay forwards binary frames to the other phones in the same room. Live audio frames are
end-to-end encrypted by the phones; the relay only sees opaque bytes.

## HTTP (v0.2+)

All `/v1/*` routes require `x-app-token` (or `?token=`).

| Route | Purpose |
|---|---|
| `GET /health` | Wake / health (also used by the app on Render free tier) |
| `POST /v1/username/claim` | Claim or rename a unique username (`{username,peerId,room}`) |
| `POST /v1/username/update-room` | Keep username → room mapping current |
| `GET /v1/username/:name` | Look up a username → `{peerId,room}` |
| `POST /v1/missed` | Store a missed-call for an offline peer (24 h) |
| `POST /v1/voice` | Store a short voice message (`audioB64`, ≤ ~60 s) for 24 h |
| `GET /v1/inbox?room=&peer=` | Fetch pending missed/voice items |
| `POST /v1/ack` | Delete delivered items by id |

Inbox is in-memory (cleared on Render free-tier sleep/redeploy). Max ~40 items per peer; voice auto-deleted on ack or after 24 h.

- Limits (live WS): 4 KB/frame, 300 frames/s, 250 KB/s, 30 phones/room, 10 conn/IP.
- Env: `APP_TOKEN` (required), `PORT`.

Test: `RELAY=https://<host> APP_TOKEN=... npm test` and `npm run test:inbox`
