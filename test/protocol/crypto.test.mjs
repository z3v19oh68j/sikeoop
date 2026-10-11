import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createPrivateKey, createPublicKey, diffieHellman } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { deriveMobileSessionKey, openMobileFrame, sealMobileFrame } from "../../sweet-code-desktop/src/main/mobile/crypto.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const vector = JSON.parse(await readFile(resolve(root, "protocol/crypto-vectors.json"), "utf8"));
const privateKeys = vector.privateKeysPkcs8DerBase64Url.map((value) => createPrivateKey({ key: Buffer.from(value, "base64url"), format: "der", type: "pkcs8" }));
const publicKeys = vector.publicKeysSpkiDerBase64Url.map((value) => createPublicKey({ key: Buffer.from(value, "base64url"), format: "der", type: "spki" }));
const dh = (privateIndex, publicIndex) => diffieHellman({ privateKey: privateKeys[privateIndex], publicKey: publicKeys[publicIndex] });
const secrets = { ss: dh(0, 2), es: dh(1, 2), se: dh(0, 3), ee: dh(1, 3) };
const fromHex = (value) => Buffer.from(value, "hex");

test("Node ECDH + HKDF + AES-GCM match the shared P0 vector", () => {
  for (const [name, secret] of Object.entries(secrets)) assert.equal(secret.toString("hex"), vector.ecdhSecretsHex[name], name);
  const key = deriveMobileSessionKey({
    ...secrets,
    pairingToken: fromHex(vector.pairingTokenHex),
    transcriptHash: fromHex(vector.transcriptHashHex),
  });
  assert.equal(key.toString("hex"), vector.sessionKeyHex);

  const expected = vector.frame;
  const plaintext = Buffer.from(expected.plaintextUtf8, "utf8");
  const frame = sealMobileFrame(key, expected.sessionId, expected.direction, BigInt(expected.counter), plaintext);
  assert.equal(frame.ciphertext, expected.ciphertext);
  assert.equal(frame.tag, expected.tag);
  assert.deepEqual(openMobileFrame(key, frame, expected.direction, BigInt(expected.counter)), plaintext);
});

test("counter ordering, direction, and GCM authentication reject invalid frames", () => {
  const key = fromHex(vector.sessionKeyHex);
  const expected = vector.frame;
  const frame = sealMobileFrame(key, expected.sessionId, expected.direction, BigInt(expected.counter), Buffer.from(expected.plaintextUtf8));
  assert.throws(() => openMobileFrame(key, frame, expected.direction, 6n), /replayed or out-of-order/);
  assert.throws(() => openMobileFrame(key, frame, "desktop-to-mobile", 7n), /wrong frame version or direction/);
  assert.throws(() => openMobileFrame(key, { ...frame, tag: Buffer.alloc(16).toString("base64url") }, expected.direction, 7n));
});

