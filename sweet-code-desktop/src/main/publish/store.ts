import { promises as fs } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { app, safeStorage } from "electron";
import type { PublishRecord, PublishSource } from "@shared/types";

const local = (name: string) => path.join(app.getPath("userData"), name);
let queue: Promise<unknown> = Promise.resolve();
/** Serialize operations that mutate site identities or encrypted credentials. */
export function exclusive<T>(work: () => Promise<T>): Promise<T> {
  const result = queue.then(work);
  queue = result.catch(() => undefined);
  return result;
}
async function atomic(file: string, data: string | Buffer): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${randomBytes(12).toString("hex")}.tmp`;
  try {
    await fs.writeFile(tmp, data, { mode: 0o600, flag: "wx" });
    await fs.rename(tmp, file);
  } finally { await fs.rm(tmp, { force: true }); }
}
async function readOptional(file: string): Promise<Buffer | undefined> {
  try { return await fs.readFile(file); }
  catch (err) { if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw err; }
}
export async function deviceId(): Promise<string> {
  const file = local("publish-device-id");
  const stored = await readOptional(file);
  if (stored) {
    const id = stored.toString("utf8").trim();
    if (!/^[A-Za-z0-9_-]{43}$/.test(id)) throw new Error("发布设备身份文件损坏");
    return id;
  }
  const id = randomBytes(32).toString("base64url");
  await atomic(file, id);
  return id;
}
export function normalizeSource(root: string, source: PublishSource): PublishSource {
  return source.kind === "proto" ? { kind: "proto", name: source.name } :
    { kind: "dir", path: path.relative(root, path.resolve(root, source.path)).split(path.sep).join("/") || "." };
}
export function sameSource(a: PublishSource, b: PublishSource): boolean {
  return a.kind === b.kind && (a.kind === "proto" ? a.name === (b as typeof a).name : a.path === (b as typeof a).path);
}
async function recordsFile(root: string): Promise<string> {
  const folder = path.join(root, ".sikeoop");
  try {
    const stat = await fs.lstat(folder);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(".sikeoop 必须是实际目录");
  } catch (err) { if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err; }
  const file = path.join(folder, "publish.json");
  try { if ((await fs.lstat(file)).isSymbolicLink()) throw new Error("发布记录不能是符号链接"); }
  catch (err) { if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err; }
  return file;
}
export async function readRecords(root: string): Promise<PublishRecord[]> {
  const data = await readOptional(await recordsFile(root));
  if (!data) return [];
  const records: unknown = JSON.parse(data.toString("utf8"));
  if (!Array.isArray(records) || records.some(r => !r || typeof r.siteId !== "string" ||
    typeof r.url !== "string" || r.target !== "sikeoop" || !r.source ||
    !(r.source.kind === "proto" && typeof r.source.name === "string" || r.source.kind === "dir" && typeof r.source.path === "string") ||
    ![r.lastPublishedAt, r.fileCount, r.bytes].every(n => typeof n === "number" && Number.isFinite(n)))) {
    throw new Error("项目发布记录损坏，请检查 .sikeoop/publish.json");
  }
  return records as PublishRecord[];
}
export async function saveRecord(root: string, record: PublishRecord): Promise<void> {
  const records = await readRecords(root);
  const kept = records.filter(r => r.siteId !== record.siteId && !sameSource(normalizeSource(root, r.source), record.source));
  await atomic(await recordsFile(root), JSON.stringify([...kept, record], null, 2));
}
export async function removeRecord(root: string, siteId: string): Promise<void> {
  await atomic(await recordsFile(root), JSON.stringify((await readRecords(root)).filter(r => r.siteId !== siteId), null, 2));
}
async function tokens(): Promise<Record<string, string>> {
  const data = await readOptional(local("publish-tokens.bin"));
  if (!data) return Object.create(null) as Record<string, string>;
  const value: unknown = JSON.parse(safeStorage.decryptString(data));
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.values(value).some(v => typeof v !== "string")) throw new Error("发布凭证文件损坏");
  return Object.assign(Object.create(null), value) as Record<string, string>;
}
export async function getToken(siteId: string): Promise<string> { return (await tokens())[siteId] || ""; }
export async function setToken(siteId: string, token?: string): Promise<void> {
  if (!safeStorage.isEncryptionAvailable()) throw new Error("系统钥匙串不可用，无法安全保存发布凭证");
  const values = await tokens();
  if (token === undefined) delete values[siteId]; else values[siteId] = token;
  await atomic(local("publish-tokens.bin"), safeStorage.encryptString(JSON.stringify(values)));
}
