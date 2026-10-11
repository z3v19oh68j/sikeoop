# Mobile v1 pairing and handshake messages

Companion to `CRYPTO.md`: the exact JSON the phone and the desktop exchange, as implemented by the desktop in `sweet-code-desktop/src/main/mobile/{handshake,gateway}.ts` and exercised end to end (simulated phone + local relay) by `test/mobile/gateway.test.mjs`. Where this file and `CRYPTO.md` differ, this file is newer.

## QR code

`sikeoop://pair/<base64url-no-padding(UTF-8 JSON)>`, the JSON being:

| field | meaning |
|---|---|
| `v` | `1` |
| `relayUrl` | WebSocket address the **phone** joins (`ws://` only on loopback/private networks, else `wss://`). An emulator reaches the Mac's local relay at `ws://10.0.2.2:8787/v1/relay`: the desktop's「手机中继地址」setting controls this. |
| `roomId` | relay room, 128-bit base64url |
| `roomToken` | relay room credential, 256-bit base64url. **Added here; missing from CRYPTO.md.** It only lets the phone into the relay room; it grants nothing end to end. The phone keeps it (encrypted) to reconnect later. |
| `computerId`, `computerName` | the desktop's id and display name |
| `pairId` | 128-bit base64url, identifies this QR code |
| `expiresAt` | ms since epoch, five minutes after creation |
| `pairingToken` | 256-bit base64url one-time secret |
| `computerSigningPublicKey`, `computerStaticDhPublicKey` | P-256 SPKI DER, base64url |

The desktop keeps the pairing token in memory only (never on disk) and takes it out of the pending list at the **first hello naming the pairId**, before the proof is checked: a wrong proof burns the code. A new code replaces any code still showing.

## Relay framing

After `{"type":"join","protocolVersion":1,"roomId","roomToken","role":"mobile"}` and the relay's `{"type":"joined"}`, each endpoint sends envelopes directly and receives them wrapped as `{"type":"forward","from":"desktop"|"mobile","envelope":…}`:

* handshake: `{"type":"handshake","payload":"<base64url(UTF-8 JSON message)>"}` (payload ≤ 32 KiB)
* data: `{"type":"data","frame":<SealedMobileFrame>}` (see CRYPTO.md)

## Canonical encoding

Each field is `u16be(byteLength) || bytes`. String fields are UTF-8. **Fields carried as base64url in JSON (public keys, nonces, signatures) are decoded and encoded as their raw bytes.** The protocol version is the two-byte big-endian number `0x0001`.

## Messages

**hello** (phone → desktop)

```json
{"t":"hello","v":1,"roomId":"…","pairId":"…","deviceId":"…","deviceName":"小恒的手机",
 "deviceSigningPublicKey":"…","deviceStaticDhPublicKey":"…","deviceEphemeralPublicKey":"…",
 "clientNonce":"<32 bytes>","helloProof":"…"}
```

* `deviceId`: 8–128 base64url characters, chosen by the phone once and kept. `deviceName`: 1–64 characters.
* First pairing: `pairId` and `helloProof` present. Reconnect: both absent, and the two long-term keys must equal the enrolled ones.
* `helloProof = HMAC-SHA256(key = pairingToken bytes, data = SHA-256(canonical(["sikeoop/mobile/v1/hello", 0x0001, roomId, pairId, deviceId, deviceName, deviceSigningPublicKey, deviceStaticDhPublicKey, deviceEphemeralPublicKey, clientNonce])))`.

**challenge** (desktop → phone)

```json
{"t":"challenge","v":1,"sessionId":"…","computerId":"…","computerSigningPublicKey":"…",
 "computerStaticDhPublicKey":"…","computerEphemeralPublicKey":"…","serverNonce":"<32 bytes>",
 "computerSignature":"<DER ECDSA-SHA256 over baseTranscript>"}
```

The phone must check `computerSigningPublicKey` (and the static-DH key) against the QR code (first pairing) or the stored values (reconnect) before trusting anything else.

**authenticate** (phone → desktop)

```json
{"t":"authenticate","v":1,"sessionId":"…","deviceSignature":"<DER ECDSA-SHA256 over baseTranscript || computerSignature>"}
```

`||` here is plain byte concatenation (not canonical encoding). `baseTranscript`, the transcript hash and the session key are exactly as in CRYPTO.md, with `pairId` = `""` on reconnect and the pairing token = empty on reconnect.

**error** (desktop → phone): `{"t":"error","v":1,"code":"HANDSHAKE_FAILED"}` and nothing else, whatever went wrong. The phone starts over with a new hello (a burned QR code needs a new code).

## After the handshake

All traffic is sealed frames carrying JSON-RPC 2.0 (`src/shared/protocol.ts`).

* First pairing: the desktop immediately sends the notification `mobile.pairing {"status":"pending"}` and asks the person at the desktop. Requests meanwhile get error `-32006` (`PAIRING_PENDING`). Then `mobile.pairing {"status":"approved"}` (RPC opens) or `{"status":"rejected"}` (the session is dropped). No answer within five minutes counts as rejected.
* Reconnect of an enrolled device: no `mobile.pairing`; RPC is open at once.
* The desktop drops the session on any frame that fails to open (wrong counter, replay, tampering) and when the relay reports the phone offline; the phone reconnects with a fresh handshake and should call `session.snapshot` to resync.
* While approved, the desktop pushes `mobile.event {cursor, event}` for every event of the main conversation, and `mobile.status <MobileView>` (debounced) after status-changing events.
* Revoking a device on the desktop drops its session and makes its keys fail the next handshake. It does not change the room token, so a revoked phone can still occupy the relay's single mobile slot until it disconnects (known limitation, see the report).
