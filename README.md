# Easy Elm Intercom relay

Small WebSocket relay for the Easy Elm Intercom Cellular (Test) Android app. Phones that are not on the same Wi-Fi
connect to `wss://<host>/ws?room=<6-digit code>` with header `x-app-token`, and the relay forwards binary frames
to the other phones in the same room. Nothing is stored; the frames are already end-to-end encrypted by the phones.

- `GET /health` – health check (also used by the app to wake the free Render instance).
- Limits: 4 KB per frame, 150 frames/s and 120 KB/s per connection, 30 phones per room, 10 connections per IP.
- Env: `APP_TOKEN` (required, set in Render, never committed), `PORT`.

Test: `RELAY=wss://<host> APP_TOKEN=... npm test`
