import { createCipheriv, createDecipheriv, createHash, hkdfSync } from "node:crypto";

export type MobileDirection = "mobile-to-desktop" | "desktop-to-mobile";
export interface SealedMobileFrame {
  version: 1;
  sessionId: string;
  direction: MobileDirection;
  counter: string;
  ciphertext: string;
  tag: string;
}

const NONCE_PREFIX: Record<MobileDirection, Buffer> = {
  "mobile-to-desktop": Buffer.from("4d4f4231", "hex"), // MOB1
  "desktop-to-mobile": Buffer.from("484f5331", "hex"), // HOS1
};

function uint64(counter: bigint): Buffer {
  if (counter < 0n || counter > 0xffff_ffff_ffff_ffffn) throw new RangeError("counter must fit uint64");
  const out = Buffer.alloc(8);
  out.writeBigUInt64BE(counter);
  return out;
}

function nonce(direction: MobileDirection, counter: bigint): Buffer {
  return Buffer.concat([NONCE_PREFIX[direction], uint64(counter)]);
}

function aad(sessionId: string, direction: MobileDirection, counter: bigint): Buffer {
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(sessionId)) throw new TypeError("sessionId must be 8-128 base64url characters");
  return Buffer.from(`sikeoop-mobile-v1\n${sessionId}\n${direction}\n${counter}`, "utf8");
}

function assertKey(key: Uint8Array): Buffer {
  const value = Buffer.from(key);
  if (value.byteLength !== 32) throw new RangeError("AES-256-GCM key must be 32 bytes");
  return value;
}

/**
 * HKDF contract from protocol/CRYPTO.md. `dh` keys are always ordered ss, es, se, ee.
 * Pairing uses a 32-byte one-time token; resumed sessions pass an empty token.
 */
export function deriveMobileSessionKey(input: {
  ss: Uint8Array;
  es: Uint8Array;
  se: Uint8Array;
  ee: Uint8Array;
  pairingToken?: Uint8Array;
  transcriptHash: Uint8Array;
}): Buffer {
  const secrets = [input.ss, input.es, input.se, input.ee].map((part) => Buffer.from(part));
  if (secrets.some((part) => part.byteLength !== 32)) throw new RangeError("each P-256 ECDH result must be 32 bytes");
  const token = Buffer.from(input.pairingToken ?? Buffer.alloc(0));
  if (token.length !== 0 && token.length !== 32) throw new RangeError("pairingToken must be empty or 32 bytes");
  const transcriptHash = Buffer.from(input.transcriptHash);
  if (transcriptHash.length !== 32) throw new RangeError("transcriptHash must be SHA-256 (32 bytes)");
  const ikm = Buffer.concat([...secrets, Buffer.from([token.length]), token]);
  const salt = createHash("sha256").update("sikeoop/mobile/v1/kdf/salt\0", "utf8").update(transcriptHash).digest();
  return Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("sikeoop/mobile/v1/session-key", "utf8"), 32));
}

export function sealMobileFrame(
  keyInput: Uint8Array,
  sessionId: string,
  direction: MobileDirection,
  counter: bigint,
  plaintext: Uint8Array,
): SealedMobileFrame {
  const key = assertKey(keyInput);
  const cipher = createCipheriv("aes-256-gcm", key, nonce(direction, counter), { authTagLength: 16 });
  cipher.setAAD(aad(sessionId, direction, counter));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    version: 1,
    sessionId,
    direction,
    counter: counter.toString(10),
    ciphertext: ciphertext.toString("base64url"),
    tag: cipher.getAuthTag().toString("base64url"),
  };
}

/** Rejects any out-of-order, repeated, or future counter before attempting decryption. */
export function openMobileFrame(
  keyInput: Uint8Array,
  frame: SealedMobileFrame,
  expectedDirection: MobileDirection,
  expectedCounter: bigint,
): Buffer {
  if (frame.version !== 1 || frame.direction !== expectedDirection) throw new Error("wrong frame version or direction");
  if (!/^(0|[1-9][0-9]*)$/.test(frame.counter)) throw new Error("invalid frame counter");
  const counter = BigInt(frame.counter);
  if (counter !== expectedCounter) throw new Error("replayed or out-of-order frame");
  const key = assertKey(keyInput);
  const decipher = createDecipheriv("aes-256-gcm", key, nonce(expectedDirection, counter), { authTagLength: 16 });
  decipher.setAAD(aad(frame.sessionId, expectedDirection, counter));
  decipher.setAuthTag(Buffer.from(frame.tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(frame.ciphertext, "base64url")), decipher.final()]);
}
