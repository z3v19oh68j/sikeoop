import { createHash, createPrivateKey, createPublicKey, diffieHellman, createECDH } from "node:crypto";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { deriveMobileSessionKey, sealMobileFrame } from "../sweet-code-desktop/src/main/mobile/crypto.ts";

const toBase64Url = (value) => Buffer.from(value).toString("base64url");
const scalars = [1, 2, 3, 4].map((n) => Buffer.from(n.toString(16).padStart(64, "0"), "hex"));
const keys = scalars.map((d) => {
  const ecdh = createECDH("prime256v1");
  ecdh.setPrivateKey(d);
  const point = ecdh.getPublicKey(undefined, "uncompressed");
  const privateKey = createPrivateKey({
    key: { kty: "EC", crv: "P-256", x: toBase64Url(point.subarray(1, 33)), y: toBase64Url(point.subarray(33, 65)), d: toBase64Url(d) },
    format: "jwk",
  });
  return { ecdh, point, privateKey, publicKey: createPublicKey(privateKey) };
});
const dh = (privateIndex, publicIndex) => diffieHellman({ privateKey: keys[privateIndex].privateKey, publicKey: keys[publicIndex].publicKey });
const secrets = { ss: dh(0, 2), es: dh(1, 2), se: dh(0, 3), ee: dh(1, 3) };
const pairingToken = Buffer.from(Array.from({ length: 32 }, (_, i) => i));
const transcriptHash = createHash("sha256").update("sikeoop-mobile-vector-v1|desktop-01|phone-01|pair-01", "utf8").digest();
const key = deriveMobileSessionKey({ ...secrets, pairingToken, transcriptHash });
const plaintext = Buffer.from('{"jsonrpc":"2.0","id":"1","method":"initialize","params":{"protocolVersion":1}}', "utf8");
const frame = sealMobileFrame(key, "vector-session-01", "mobile-to-desktop", 7n, plaintext);

const vector = {
  description: "Deterministic P-256 ECDH + HKDF-SHA256 + AES-256-GCM interoperability vector. Private scalars are test-only public fixtures.",
  curve: "secp256r1",
  privateKeysPkcs8DerBase64Url: keys.map(({ privateKey }) => privateKey.export({ format: "der", type: "pkcs8" }).toString("base64url")),
  publicKeysSpkiDerBase64Url: keys.map(({ publicKey }) => publicKey.export({ format: "der", type: "spki" }).toString("base64url")),
  publicPointsUncompressedHex: keys.map(({ point }) => point.toString("hex")),
  keyRoles: { phoneStatic: 0, phoneEphemeral: 1, computerStatic: 2, computerEphemeral: 3 },
  ecdhSecretsHex: Object.fromEntries(Object.entries(secrets).map(([name, value]) => [name, value.toString("hex")])),
  pairingTokenHex: pairingToken.toString("hex"),
  transcriptHashHex: transcriptHash.toString("hex"),
  sessionKeyHex: key.toString("hex"),
  frame: { ...frame, plaintextUtf8: plaintext.toString("utf8") },
};
writeFileSync(resolve("protocol/crypto-vectors.json"), `${JSON.stringify(vector, null, 2)}\n`, "utf8");
process.stdout.write("Wrote protocol/crypto-vectors.json\n");
