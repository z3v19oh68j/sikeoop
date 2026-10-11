# Mobile v1 handshake and encrypted frame profile

This profile is the P0 wire-security contract. It is intentionally independent of WebSocket and relay implementation. The relay forwards opaque `handshake` envelopes and `SealedMobileFrame` JSON; handshake routing metadata and public keys/nonces are visible, but the relay never parses signatures or application content and never logs or persists envelope payloads.

## Pairing payload

The desktop creates a random 128-bit `pairId`, a random 256-bit `pairingToken`, and a five-minute expiry. The QR payload is UTF-8 JSON encoded as `sikeoop://pair/<base64url-no-padding>` and contains `{v:1, relayUrl, roomId, roomToken, computerId, computerName, pairId, expiresAt, pairingToken, computerSigningPublicKey, computerStaticDhPublicKey}` (`roomToken` added in PAIRING.md, which has the exact message formats). Public keys are DER `SubjectPublicKeyInfo` (P-256), base64url without padding. The desktop never writes the pairing token to disk; it keeps it in memory for at most 300 seconds (the HMAC proof needs the token itself) and consumes it at the first hello naming the pairId. Never put this payload in app logs, analytics, clipboard history, or relay logs.

The phone creates two P-256 key pairs: an identity-signing key and a static ECDH key. Private key material is wrapped by an Android Keystore AES-256-GCM key and excluded from Android backup. The long-term public keys are enrolled only after explicit desktop approval.

## Authenticated handshake

All fields below use base64url without padding unless stated otherwise. Nonces are 32 random bytes. ECDH keys use P-256; identity signatures use ECDSA/SHA-256 with DER-encoded signatures. The canonical handshake encoding is a concatenation of fields, each encoded as `u16be(byteLength) || UTF-8-or-binary-bytes`; lengths over 65535 are rejected. No JSON serialization is signed.

1. `hello`: phone sends protocol version, room/pair IDs, device ID/name, phone identity signing SPKI, phone static-DH SPKI, phone ephemeral SPKI, client nonce, and `helloProof = HMAC-SHA256(pairingToken, SHA-256(canonical hello fields excluding helloProof))`.
2. `challenge`: desktop verifies the one-time token hash and expiry, generates its ephemeral P-256 key and server nonce, then sends its static-DH SPKI, ephemeral SPKI, server nonce, and `computerSignature = ECDSA-SHA256(computerIdentityPrivate, baseTranscript)`.
3. `authenticate`: phone checks the QR computer identity key against the challenge, verifies `computerSignature`, and sends `deviceSignature = ECDSA-SHA256(phoneIdentityPrivate, baseTranscript || computerSignature)`.
4. Desktop verifies the phone signature, consumes the one-time pairing token and asks the person at the desktop to approve the device. Until approval, only encrypted pairing status frames are allowed. Approval stores the device public keys; rejection destroys pending session state. A reconnect uses a new pair of ephemeral keys and fresh nonces, skips the QR proof, and requires signatures from the enrolled device identity key.

`baseTranscript` is the canonical field sequence in this fixed order: domain `sikeoop/mobile/v1/handshake`, u16 protocol version, room ID, pair ID (empty on reconnect), computer ID, device ID, device name, computer identity signing SPKI, computer static-DH SPKI, phone identity signing SPKI, phone static-DH SPKI, computer ephemeral SPKI, phone ephemeral SPKI, client nonce, server nonce. The final transcript `T` is the canonical encoding of `baseTranscript`, computer signature, and device signature. `transcriptHash = SHA-256(T)`.

## Session key

Each ECDH output is the 32-byte big-endian P-256 shared secret. Both sides derive the four values in this exact role order:

* `ss = DH(phone static, computer static)`
* `es = DH(phone ephemeral, computer static)`
* `se = DH(phone static, computer ephemeral)`
* `ee = DH(phone ephemeral, computer ephemeral)`

For first pairing, `pairingToken` is the 32-byte QR secret. On reconnect, it is an empty byte string. Form `IKM = ss || es || se || ee || u8(tokenLength) || token`. Derive:

* `salt = SHA-256(UTF8("sikeoop/mobile/v1/kdf/salt\0") || transcriptHash)`
* `sessionKey = HKDF-SHA256(IKM, salt, UTF8("sikeoop/mobile/v1/session-key"), 32)`

Test vector inputs, intermediate ECDH values, key and sealed frame are in `crypto-vectors.json`. The test-only private scalars in that file are public fixtures and must never be reused in production.

## Encrypted frames

The JSON frame is `{version:1, sessionId, direction, counter, ciphertext, tag}`. `counter` is an unsigned decimal string; ciphertext and 16-byte tag are base64url without padding. `sessionId` is 8–128 base64url characters and is fresh per handshake. AES-256-GCM uses 12-byte nonce `directionPrefix[4] || uint64be(counter)`, with `MOB1` for `mobile-to-desktop` and `HOS1` for `desktop-to-mobile`. AAD is UTF-8 `sikeoop-mobile-v1\n<sessionId>\n<direction>\n<counter>`.

Each direction starts at counter zero and increments exactly once per encrypted frame. A receiver accepts only the exact next counter and advances it only after successful GCM authentication. Duplicate, lower, higher, malformed, wrong-direction, or unauthenticated frames are rejected and never delivered. Counter state is per fresh session key. Disconnect/reconnect always creates new ephemeral keys and a new session ID. Frames over 1 MiB are rejected before decrypting.

## Operational rules

* The relay routes a room and sees room IDs, roles, public handshake fields, and the one-time-token HMAC proof. It never receives the pairing token itself or plaintext application RPC. Handshake envelopes stop after key establishment; all later RPC and events are sealed frames.
* Handshake messages are length-capped and rate-limited. The desktop accepts one successful use of a pairing token; failed handshakes do not disclose whether a device ID is enrolled.
* Device removal revokes its key immediately, closes its relay session, and prevents reconnect. All methods are still checked against the protocol allowlist and desktop policy after decryption.
* Human-only approvals remain single-item decisions and expire after ten minutes; lazy-mode hard-deny policy cannot be overridden through this protocol.
