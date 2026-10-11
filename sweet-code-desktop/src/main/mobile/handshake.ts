import {
  type KeyObject,
  createHash,
  createHmac,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  randomBytes,
  sign,
  timingSafeEqual,
  verify,
} from "node:crypto";
import { deriveMobileSessionKey } from "./crypto.ts";

// The authenticated handshake of protocol/CRYPTO.md and protocol/PAIRING.md, desktop side, as pure
// functions: no sockets, no storage. The gateway feeds it decoded handshake messages and gets back
// the reply to send and, at the end, the session key. Every failure returns null without saying why,
// so a probe can't tell an unknown device from a bad signature.

export const HANDSHAKE_VERSION = 1;
const HANDSHAKE_DOMAIN = "sikeoop/mobile/v1/handshake";
const HELLO_DOMAIN = "sikeoop/mobile/v1/hello";
const B64 = /^[A-Za-z0-9_-]+$/;
const ID = /^[A-Za-z0-9_-]{8,128}$/;

export const b64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64url");

/** base64url → bytes, or null when malformed or longer than max bytes. */
export function unb64(value: unknown, max = 4096): Buffer | null {
  if (typeof value !== "string" || !value || value.length > Math.ceil((max * 4) / 3) + 4 || !B64.test(value)) return null;
  const out = Buffer.from(value, "base64url");
  return out.length && out.length <= max ? out : null;
}

type Field = string | Uint8Array | { u16: number };

/** Each field as u16be(byteLength) || bytes; strings are UTF-8, { u16 } is a two-byte big-endian number. */
export function canonical(fields: Field[]): Buffer {
  const parts: Buffer[] = [];
  for (const f of fields) {
    const bytes =
      typeof f === "string" ? Buffer.from(f, "utf8") : f instanceof Uint8Array ? Buffer.from(f) : Buffer.from([(f.u16 >> 8) & 0xff, f.u16 & 0xff]);
    if (bytes.length > 0xffff) throw new RangeError("handshake field too long");
    const len = Buffer.alloc(2);
    len.writeUInt16BE(bytes.length);
    parts.push(len, bytes);
  }
  return Buffer.concat(parts);
}

const sha256 = (data: Uint8Array) => createHash("sha256").update(data).digest();

/** A P-256 public key from DER SPKI bytes, or null when it isn't one. */
export function p256Public(spki: Uint8Array | null): KeyObject | null {
  if (!spki) return null;
  try {
    const key = createPublicKey({ key: Buffer.from(spki), format: "der", type: "spki" });
    return key.asymmetricKeyType === "ec" && key.asymmetricKeyDetails?.namedCurve === "prime256v1" ? key : null;
  } catch {
    return null;
  }
}

export interface KeyPairDer {
  /** PKCS#8 DER, base64url. Secret. */
  privateKey: string;
  /** SPKI DER, base64url. */
  publicKey: string;
}

export function newP256(): KeyPairDer {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  return {
    privateKey: b64(privateKey.export({ format: "der", type: "pkcs8" })),
    publicKey: b64(publicKey.export({ format: "der", type: "spki" })),
  };
}

export const privateKeyOf = (pkcs8: string) => createPrivateKey({ key: Buffer.from(pkcs8, "base64url"), format: "der", type: "pkcs8" });
export const dh = (priv: KeyObject, pub: KeyObject) => diffieHellman({ privateKey: priv, publicKey: pub });

// ---- messages (JSON inside the relay's handshake envelope, see PAIRING.md) ----

export interface HelloMessage {
  t: "hello";
  v: 1;
  roomId: string;
  /** Present on first pairing (with helloProof); absent on reconnect. */
  pairId?: string;
  deviceId: string;
  deviceName: string;
  deviceSigningPublicKey: string;
  deviceStaticDhPublicKey: string;
  deviceEphemeralPublicKey: string;
  clientNonce: string;
  helloProof?: string;
}

export interface ChallengeMessage {
  t: "challenge";
  v: 1;
  sessionId: string;
  computerId: string;
  computerSigningPublicKey: string;
  computerStaticDhPublicKey: string;
  computerEphemeralPublicKey: string;
  serverNonce: string;
  computerSignature: string;
}

export interface AuthenticateMessage {
  t: "authenticate";
  v: 1;
  sessionId: string;
  deviceSignature: string;
}

/** The only failure the desktop ever sends: no reason, so nothing leaks about enrolled devices. */
export interface HandshakeFailedMessage {
  t: "error";
  v: 1;
  code: "HANDSHAKE_FAILED";
}

export type HandshakeMessage = HelloMessage | ChallengeMessage | AuthenticateMessage | HandshakeFailedMessage;

/** SHA-256 of the hello fields that helloProof covers (every field but the proof, in this order). */
export function helloDigest(h: Pick<HelloMessage, "roomId" | "pairId" | "deviceId" | "deviceName" | "deviceSigningPublicKey" | "deviceStaticDhPublicKey" | "deviceEphemeralPublicKey" | "clientNonce">): Buffer {
  return sha256(
    canonical([
      HELLO_DOMAIN,
      { u16: HANDSHAKE_VERSION },
      h.roomId,
      h.pairId ?? "",
      h.deviceId,
      h.deviceName,
      Buffer.from(h.deviceSigningPublicKey, "base64url"),
      Buffer.from(h.deviceStaticDhPublicKey, "base64url"),
      Buffer.from(h.deviceEphemeralPublicKey, "base64url"),
      Buffer.from(h.clientNonce, "base64url"),
    ]),
  );
}

export const helloProof = (pairingToken: Uint8Array, digest: Uint8Array) => createHmac("sha256", Buffer.from(pairingToken)).update(digest).digest();

export interface TranscriptParts {
  roomId: string;
  pairId: string;
  computerId: string;
  deviceId: string;
  deviceName: string;
  computerSigningPublicKey: Uint8Array;
  computerStaticDhPublicKey: Uint8Array;
  deviceSigningPublicKey: Uint8Array;
  deviceStaticDhPublicKey: Uint8Array;
  computerEphemeralPublicKey: Uint8Array;
  deviceEphemeralPublicKey: Uint8Array;
  clientNonce: Uint8Array;
  serverNonce: Uint8Array;
}

/** baseTranscript, field order fixed by CRYPTO.md. */
export function baseTranscript(p: TranscriptParts): Buffer {
  return canonical([
    HANDSHAKE_DOMAIN,
    { u16: HANDSHAKE_VERSION },
    p.roomId,
    p.pairId,
    p.computerId,
    p.deviceId,
    p.deviceName,
    p.computerSigningPublicKey,
    p.computerStaticDhPublicKey,
    p.deviceSigningPublicKey,
    p.deviceStaticDhPublicKey,
    p.computerEphemeralPublicKey,
    p.deviceEphemeralPublicKey,
    p.clientNonce,
    p.serverNonce,
  ]);
}

export const transcriptHash = (base: Uint8Array, computerSignature: Uint8Array, deviceSignature: Uint8Array) =>
  sha256(canonical([base, computerSignature, deviceSignature]));

export const signP256 = (priv: KeyObject, data: Uint8Array) => sign("sha256", data, priv);
export function verifyP256(pub: KeyObject, data: Uint8Array, signature: Uint8Array | null): boolean {
  if (!signature) return false;
  try {
    return verify("sha256", data, pub, signature);
  } catch {
    return false;
  }
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

// ---- desktop side ----

export interface ComputerKeys {
  computerId: string;
  signing: KeyPairDer;
  staticDh: KeyPairDer;
}

export interface EnrolledKeys {
  signingPublicKey: string;
  staticDhPublicKey: string;
}

export interface DesktopHandshakeContext {
  roomId: string;
  computer: ComputerKeys;
  /** Takes the pairing out of the pending list (one use): its token, or null when unknown or expired. */
  consumePairing(pairId: string): Buffer | null;
  /** Keys of an enrolled device, or null. */
  enrolled(deviceId: string): EnrolledKeys | null;
}

/** What the desktop keeps between its challenge and the phone's authenticate. */
export interface PendingHandshake {
  sessionId: string;
  pairing: boolean;
  deviceId: string;
  deviceName: string;
  deviceSigningPublicKey: string;
  deviceStaticDhPublicKey: string;
  base: Buffer;
  computerSignature: Buffer;
  secrets: { ss: Buffer; es: Buffer; se: Buffer; ee: Buffer };
  token: Buffer;
}

export interface EstablishedSession {
  sessionId: string;
  key: Buffer;
  deviceId: string;
  deviceName: string;
  /** First pairing: the device isn't enrolled yet and needs the person at the desktop to approve it. */
  pairing: boolean;
  deviceSigningPublicKey: string;
  deviceStaticDhPublicKey: string;
}

const DEVICE_NAME_MAX = 64;

/** Step 2: check a hello and answer with a signed challenge. null = fail silently. */
export function acceptHello(ctx: DesktopHandshakeContext, raw: unknown): { challenge: ChallengeMessage; pending: PendingHandshake } | null {
  const h = raw as Partial<HelloMessage>;
  if (!h || h.t !== "hello" || h.v !== HANDSHAKE_VERSION || h.roomId !== ctx.roomId) return null;
  if (typeof h.deviceId !== "string" || !ID.test(h.deviceId)) return null;
  if (typeof h.deviceName !== "string" || !h.deviceName.trim() || h.deviceName.length > DEVICE_NAME_MAX) return null;
  const devSign = unb64(h.deviceSigningPublicKey, 512);
  const devDh = unb64(h.deviceStaticDhPublicKey, 512);
  const devEph = unb64(h.deviceEphemeralPublicKey, 512);
  const clientNonce = unb64(h.clientNonce, 64);
  const devSignKey = p256Public(devSign);
  const devDhKey = p256Public(devDh);
  const devEphKey = p256Public(devEph);
  if (!devSignKey || !devDhKey || !devEphKey || !clientNonce || clientNonce.length !== 32) return null;

  const pairing = h.pairId !== undefined;
  let token: Buffer = Buffer.alloc(0);
  if (pairing) {
    if (typeof h.pairId !== "string" || !ID.test(h.pairId)) return null;
    const proof = unb64(h.helloProof, 64);
    // Consumed before the proof is checked: a wrong guess burns the QR code too.
    const t = ctx.consumePairing(h.pairId);
    if (!t || !proof) return null;
    if (!sameBytes(helloProof(t, helloDigest(h as HelloMessage)), proof)) return null;
    token = t;
  } else {
    if (h.helloProof !== undefined) return null;
    const known = ctx.enrolled(h.deviceId);
    if (!known) return null;
    if (!sameBytes(Buffer.from(known.signingPublicKey, "base64url"), devSign!) || !sameBytes(Buffer.from(known.staticDhPublicKey, "base64url"), devDh!)) return null;
  }

  const eph = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const ephPub = eph.publicKey.export({ format: "der", type: "spki" });
  const serverNonce = randomBytes(32);
  const sessionId = b64(randomBytes(18));
  const compSignPub = Buffer.from(ctx.computer.signing.publicKey, "base64url");
  const compDhPub = Buffer.from(ctx.computer.staticDh.publicKey, "base64url");
  const base = baseTranscript({
    roomId: ctx.roomId,
    pairId: pairing ? h.pairId! : "",
    computerId: ctx.computer.computerId,
    deviceId: h.deviceId,
    deviceName: h.deviceName,
    computerSigningPublicKey: compSignPub,
    computerStaticDhPublicKey: compDhPub,
    deviceSigningPublicKey: devSign!,
    deviceStaticDhPublicKey: devDh!,
    computerEphemeralPublicKey: ephPub,
    deviceEphemeralPublicKey: devEph!,
    clientNonce,
    serverNonce,
  });
  const computerSignature = signP256(privateKeyOf(ctx.computer.signing.privateKey), base);
  const compDhPriv = privateKeyOf(ctx.computer.staticDh.privateKey);
  const secrets = {
    ss: dh(compDhPriv, devDhKey),
    es: dh(compDhPriv, devEphKey),
    se: dh(eph.privateKey, devDhKey),
    ee: dh(eph.privateKey, devEphKey),
  };
  return {
    challenge: {
      t: "challenge",
      v: 1,
      sessionId,
      computerId: ctx.computer.computerId,
      computerSigningPublicKey: ctx.computer.signing.publicKey,
      computerStaticDhPublicKey: ctx.computer.staticDh.publicKey,
      computerEphemeralPublicKey: b64(ephPub),
      serverNonce: b64(serverNonce),
      computerSignature: b64(computerSignature),
    },
    pending: {
      sessionId,
      pairing,
      deviceId: h.deviceId,
      deviceName: h.deviceName.trim(),
      deviceSigningPublicKey: h.deviceSigningPublicKey!,
      deviceStaticDhPublicKey: h.deviceStaticDhPublicKey!,
      base,
      computerSignature,
      secrets,
      token,
    },
  };
}

/** Step 4: check the phone's signature and derive the session key. null = fail silently. */
export function acceptAuthenticate(pending: PendingHandshake, raw: unknown): EstablishedSession | null {
  const a = raw as Partial<AuthenticateMessage>;
  if (!a || a.t !== "authenticate" || a.v !== HANDSHAKE_VERSION || a.sessionId !== pending.sessionId) return null;
  const deviceSignature = unb64(a.deviceSignature, 128);
  const devSignKey = p256Public(Buffer.from(pending.deviceSigningPublicKey, "base64url"));
  if (!devSignKey || !deviceSignature) return null;
  if (!verifyP256(devSignKey, Buffer.concat([pending.base, pending.computerSignature]), deviceSignature)) return null;
  const key = deriveMobileSessionKey({
    ...pending.secrets,
    pairingToken: pending.token,
    transcriptHash: transcriptHash(pending.base, pending.computerSignature, deviceSignature),
  });
  return {
    sessionId: pending.sessionId,
    key,
    deviceId: pending.deviceId,
    deviceName: pending.deviceName,
    pairing: pending.pairing,
    deviceSigningPublicKey: pending.deviceSigningPublicKey,
    deviceStaticDhPublicKey: pending.deviceStaticDhPublicKey,
  };
}
