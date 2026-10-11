import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { b64, newP256, type ComputerKeys, type KeyPairDer } from "./handshake.ts";

// What the phone gateway keeps on disk, in userData/mobile/:
//   gateway.json  — plain: on/off, relay addresses, computer and room ids, enrolled devices' PUBLIC keys
//   secrets.bin   — the computer's private keys and the relay room token, encrypted by the OS keychain
// Pairing tokens are never written anywhere: they live in memory for five minutes.

/** The OS keychain (Electron safeStorage in the app, a stand-in in tests). */
export interface SecretBox {
  available(): boolean;
  encrypt(plain: string): Buffer;
  decrypt(data: Buffer): string;
}

export interface StoredDevice {
  id: string;
  name: string;
  signingPublicKey: string;
  staticDhPublicKey: string;
  addedAt: number;
  lastSeenAt?: number;
}

interface PublicFile {
  v: 1;
  enabled: boolean;
  relayUrl: string;
  /** The address the phone uses to reach the same relay, when it differs (an emulator uses 10.0.2.2). */
  phoneRelayUrl?: string;
  computerId: string;
  roomId: string;
  devices: StoredDevice[];
}

interface SecretFile {
  v: 1;
  signing: KeyPairDer;
  staticDh: KeyPairDer;
  roomToken: string;
  /** Proves to the relay that this computer owns the room (phones only get roomToken). */
  ownerToken?: string;
}

/** The public relay (relay/deploy/): reachable from anywhere, so the phone works away from home. */
export const DEFAULT_RELAY_URL = "wss://relay.sikeoop.modgert.online/v1/relay";
/** The old default (the local dev relay): settings still on it untouched move to the public relay. */
const OLD_DEFAULT_RELAY_URL = "ws://127.0.0.1:8787/v1/relay";
const MAX_DEVICES = 10;

export class MobileStore {
  private pub: PublicFile | null = null;
  private secret: SecretFile | null = null;
  private writing: Promise<void> = Promise.resolve();

  private readonly dir: string;
  private readonly box: SecretBox;

  constructor(dir: string, box: SecretBox) {
    this.dir = dir;
    this.box = box;
  }

  private get pubFile() {
    return path.join(this.dir, "gateway.json");
  }
  private get secretFile() {
    return path.join(this.dir, "secrets.bin");
  }

  /** Reads the files, creating the computer's identity the first time. Throws when the keychain is unavailable. */
  async load(): Promise<void> {
    if (this.pub && this.secret) return;
    const pub = await readJson<PublicFile>(this.pubFile);
    let secret: SecretFile | null = null;
    const raw = await fs.readFile(this.secretFile).catch(() => null);
    if (raw) {
      if (!this.box.available()) throw new Error("系统钥匙串不可用，读不了手机连接的密钥");
      secret = JSON.parse(this.box.decrypt(raw)) as SecretFile;
    }
    if (pub?.v === 1 && secret?.v === 1) {
      this.pub = { ...pub, devices: (pub.devices ?? []).slice(0, MAX_DEVICES) };
      this.secret = secret;
      if (!secret.ownerToken) {
        // Written before the relay had owner tokens: add one (the room is re-created on the next join).
        secret.ownerToken = b64(randomBytes(32));
        await this.save(true);
      }
      if (pub.relayUrl === OLD_DEFAULT_RELAY_URL && !pub.phoneRelayUrl) {
        this.pub.relayUrl = DEFAULT_RELAY_URL;
        await this.save();
      }
      return;
    }
    // First run, or one half is missing: a fresh identity. Old devices can't be trusted against new keys.
    if (!this.box.available()) throw new Error("系统钥匙串不可用，没法安全保存手机连接的密钥");
    this.secret = { v: 1, signing: newP256(), staticDh: newP256(), roomToken: b64(randomBytes(32)), ownerToken: b64(randomBytes(32)) };
    this.pub = {
      v: 1,
      enabled: pub?.enabled ?? false,
      relayUrl: pub?.relayUrl ?? DEFAULT_RELAY_URL,
      ...(pub?.phoneRelayUrl ? { phoneRelayUrl: pub.phoneRelayUrl } : {}),
      computerId: b64(randomBytes(16)),
      roomId: b64(randomBytes(16)),
      devices: [],
    };
    await this.save(true);
  }

  private get p(): PublicFile {
    if (!this.pub) throw new Error("mobile store not loaded");
    return this.pub;
  }
  private get s(): SecretFile {
    if (!this.secret) throw new Error("mobile store not loaded");
    return this.secret;
  }

  get enabled() {
    return this.p.enabled;
  }
  get relayUrl() {
    return this.p.relayUrl;
  }
  get phoneRelayUrl() {
    return this.p.phoneRelayUrl ?? this.p.relayUrl;
  }
  get roomId() {
    return this.p.roomId;
  }
  get roomToken() {
    return this.s.roomToken;
  }
  get ownerToken() {
    return this.s.ownerToken!;
  }
  get computer(): ComputerKeys {
    return { computerId: this.p.computerId, signing: this.s.signing, staticDh: this.s.staticDh };
  }
  get devices(): readonly StoredDevice[] {
    return this.p.devices;
  }
  device(id: string): StoredDevice | null {
    return this.p.devices.find((d) => d.id === id) ?? null;
  }

  async setEnabled(on: boolean) {
    this.p.enabled = on;
    await this.save();
  }

  async setRelay(relayUrl: string, phoneRelayUrl?: string) {
    this.p.relayUrl = relayUrl;
    if (phoneRelayUrl) this.p.phoneRelayUrl = phoneRelayUrl;
    else delete this.p.phoneRelayUrl;
    await this.save();
  }

  /** Enrolls (or re-enrolls, with new keys) a device the person approved. */
  async addDevice(d: Omit<StoredDevice, "addedAt">) {
    const others = this.p.devices.filter((x) => x.id !== d.id);
    if (others.length >= MAX_DEVICES) throw new Error(`最多连 ${MAX_DEVICES} 台手机，先移除一台`);
    this.p.devices = [...others, { ...d, addedAt: Date.now() }];
    await this.save();
  }

  async removeDevice(id: string) {
    this.p.devices = this.p.devices.filter((d) => d.id !== id);
    await this.save();
  }

  async touchDevice(id: string) {
    const d = this.p.devices.find((x) => x.id === id);
    if (!d) return;
    d.lastSeenAt = Date.now();
    await this.save();
  }

  /** Writes are queued so two quick changes can't interleave; each file is replaced atomically. */
  private save(withSecret = false): Promise<void> {
    const pub = JSON.stringify(this.p, null, 2);
    const secret = withSecret ? this.box.encrypt(JSON.stringify(this.s)) : null;
    this.writing = this.writing.then(async () => {
      await fs.mkdir(this.dir, { recursive: true, mode: 0o700 });
      await atomicWrite(this.pubFile, pub);
      if (secret) await atomicWrite(this.secretFile, secret);
    });
    return this.writing;
  }
}

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(file, "utf8")) as T;
  } catch {
    return null;
  }
}

async function atomicWrite(file: string, data: string | Buffer) {
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, data, { mode: 0o600 });
  await fs.rename(tmp, file);
}
