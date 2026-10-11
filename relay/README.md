# Local Node relay (development only)

This is the P1 local relay implementation. It binds to `127.0.0.1` by default and is not a production internet service. No Cloudflare Worker, Durable Object, public listener, deployment config, or deployment has been created.

## Run

```sh
node relay/src/node-server.mjs
# Optional: PORT=8788 HOST=127.0.0.1 node relay/src/node-server.mjs
curl http://127.0.0.1:8787/healthz
```

The WebSocket endpoint is `ws://127.0.0.1:8787/v1/relay`. The desktop endpoint must join first and create a room with a random 128-bit base64url room ID and a 256-bit base64url room token. The phone joins with the same room credentials. One desktop and one phone are allowed per room. Empty room records expire after 24 hours. Relay state is memory-only; application envelopes are never queued, written to disk, or logged.

The relay accepts an initial `join` frame, then forwards opaque `handshake` envelopes (signed public-key handshake fields; the relay does not parse them) and `data` envelopes containing version-1 encrypted frames. It validates routing metadata, frame direction, encoding, 1 MiB max message size, and per-connection rate limits, but never decrypts or logs frame payloads. A `presence` message is generated when the counterpart connects or disconnects. Offline messages are dropped; the gateway must request a fresh `session.snapshot` after reconnect.

All transport is plaintext WebSocket in this localhost-only dev server. Do not bind this process to a public interface. The eventual hosted relay must use TLS/WSS and Cloudflare deployment remains blocked on explicit user approval.

## Tests

From the workspace root:

```sh
node --test test/relay/*.test.mjs
```

## Public deployment (relay.sikeoop.modgert.online)

Deployed on 2026-10-10 with the user's approval, on the existing server behind nginx:

- Code: `/opt/sikeoop-relay/src/{node-server,room-hub}.mjs`. Runs as the unprivileged `sikeoop-relay` user under `relay/deploy/sikeoop-relay.service` (systemd sandboxing, 256 MB memory cap). It listens on `127.0.0.1:8787` only, with `TRUST_PROXY=1` so the per-address limit sees nginx's `X-Real-IP`.
- nginx: `relay/deploy/nginx-sikeoop-relay.conf` → `/etc/nginx/sites-available/sikeoop-relay`. certbot added TLS and the http→https redirect. Only `/v1/relay` and `/healthz` are served; nginx logs request lines, never message contents.
- Limits: 20 connections per client address, 2000 in total; connections that don't join within 10 s and peers silent for 90 s are closed. These apply on top of the per-connection rate and size limits.
- Update: copy the two `.mjs` files to `/opt/sikeoop-relay/src/`, then `systemctl restart sikeoop-relay`. Check with `curl https://relay.sikeoop.modgert.online/healthz`.
- An nginx backup from before the change is at `/root/nginx-backup-20261009-164403.tgz`.

## Channel isolation

- Every computer has its own room: a random 128-bit room id, plus two 256-bit secrets.
  - `roomToken` is shared with paired phones (it is in the QR code).
  - `ownerToken` never leaves the computer. Only it can take the desktop seat, so no phone (revoked or not) can sit in the computer's place.
- A connection is bound to one room and one role for life. Frames go only to the other seat of the same room; the relay keeps no queue and nothing crosses rooms.
- Only a room's desktop can send `{"type":"kick"}`, which disconnects that room's phone. The gateway sends it after a failed handshake, a rejected pairing, a bad frame, and when a connected device is revoked.
- Per client address: at most 20 connections and at most 4 rooms it created and still holds. In total: at most 2000 connections and 10000 rooms.
- All of this sits on top of end-to-end encryption: even a misrouted frame can't be opened by anyone but the paired phone and computer.
