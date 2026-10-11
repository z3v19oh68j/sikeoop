import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import type { PublishRequest, PublishRecord, PublishEvent, PublishErrorCode } from "@shared/types";
import { getRoot } from "../workspace";
import { bundleProto, collectDir } from "./bundle";
import { scanSite } from "./scan";
import * as store from "./store";

class PublishError extends Error {
  constructor(public readonly code: PublishErrorCode, message: string) { super(message); }
}
const codes = new Set<PublishErrorCode>(["too_big", "quota", "network", "blocked_file", "server", "cancelled"]);
function check(signal: AbortSignal): void {
  if (signal.aborted) throw new PublishError("cancelled", "发布已取消");
}
function endpoint(route: string): string {
  return `${(process.env.SIKEOOP_PUBLISH_API || "https://api.sikeoop.site").replace(/\/+$/, "")}${route}`;
}
async function request(route: string, device: string, token: string, method: string, body?: string | Uint8Array, signal?: AbortSignal): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(endpoint(route), {
      method, signal, redirect: "error",
      headers: { "X-Sikeoop-Device": device, ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body !== undefined ? { "Content-Type": typeof body === "string" ? "application/json" : "application/octet-stream" } : {}) },
      body: body instanceof Uint8Array ? new Uint8Array(body).buffer : body,
    });
  } catch (err) {
    if (signal?.aborted) throw new PublishError("cancelled", "发布已取消");
    throw new PublishError("network", `连接发布服务失败：${err instanceof Error ? err.message : String(err)}`);
  }
  let value: unknown;
  try { value = response.status === 204 ? undefined : JSON.parse(await response.text()); }
  catch (err) {
    if (signal?.aborted) throw new PublishError("cancelled", "发布已取消");
    if (err instanceof SyntaxError) throw new PublishError("server", `发布服务返回了无效响应（${response.status}）`);
    throw new PublishError("network", "读取发布服务响应失败");
  }
  if (!response.ok) {
    const error = (value as { error?: { code?: PublishErrorCode; message?: string } } | undefined)?.error;
    throw new PublishError(error?.code && codes.has(error.code) ? error.code : "server",
      typeof error?.message === "string" ? error.message : `发布服务出错（${response.status}）`);
  }
  return value;
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new PublishError("server", "发布服务响应格式错误");
  return value as Record<string, unknown>;
}
function string(value: unknown): string {
  if (typeof value !== "string" || !value) throw new PublishError("server", "发布服务响应缺少站点信息");
  return value;
}
export function publish(req: PublishRequest, emit: (ev: PublishEvent) => void, signal: AbortSignal): Promise<PublishRecord> {
  const root = getRoot();
  return store.exclusive(async () => {
    let dir: string | undefined;
    try {
      check(signal);
      if (getRoot() !== root) throw new PublishError("cancelled", "项目已切换，请在原项目重新发布");
      const source = store.normalizeSource(root, req.source);
      const bundle = source.kind === "proto" ? await bundleProto(source.name) : await collectDir(source.path);
      dir = bundle.dir;
      if (getRoot() !== root) throw new PublishError("cancelled", "项目已切换，请在原项目重新发布");
      check(signal);
      const result = await scanSite(dir);
      emit({ type: "scan", result });
      check(signal);
      if (result.warnings.some(w => w.blocking)) throw new PublishError("blocked_file", "请先处理阻止发布的文件问题，再重新发布");
      const files = await Promise.all(bundle.files.map(async file => {
        const data = await fs.readFile(path.join(bundle.dir, file));
        return { path: file, sha256: createHash("sha256").update(data).digest("hex"), size: data.length };
      }));
      check(signal);
      const device = await store.deviceId();
      let record = (await store.readRecords(root)).find(r => store.sameSource(store.normalizeSource(root, r.source), source));
      let token = record ? await store.getToken(record.siteId) : "";
      if (record && !token) throw new PublishError("server", "本机缺少这个站点的发布凭证，无法更新原链接");
      if (!record) {
        const created = object(await request("/v1/sites", device, "", "POST", "{}", signal));
        const siteId = string(created.siteId);
        token = string(created.siteToken);
        record = { siteId, url: string(created.url), target: "sikeoop", source, lastPublishedAt: 0, fileCount: 0, bytes: 0 };
        await store.setToken(siteId, token);
        await store.saveRecord(root, record);
      }
      check(signal);
      const site = `/v1/sites/${encodeURIComponent(record.siteId)}`;
      const deployed = object(await request(`${site}/deploy`, device, token, "POST", JSON.stringify({ files }), signal));
      const deployId = string(deployed.deployId);
      const byHash = new Map(files.map(f => [f.sha256, f]));
      if (!Array.isArray(deployed.missing) || deployed.missing.some(h => typeof h !== "string" || !byHash.has(h))) throw new PublishError("server", "发布服务返回了未知文件哈希");
      const missing = [...new Set(deployed.missing as string[])];
      let next = 0, done = 0;
      let failure: unknown;
      emit({ type: "upload", done, total: missing.length });
      await Promise.all(Array.from({ length: Math.min(4, missing.length) }, async () => {
        try {
          while (!failure && next < missing.length) {
            check(signal);
            const hash = missing[next++];
            const data = new Uint8Array(await fs.readFile(path.join(bundle.dir, byHash.get(hash)!.path)));
            for (let attempt = 0; ; attempt++) {
              check(signal);
              try { await request(`${site}/blobs/${hash}`, device, token, "PUT", data, signal); break; }
              catch (err) {
                if (signal.aborted || attempt >= 2 || !(err instanceof PublishError) || !["network", "server"].includes(err.code)) throw err;
              }
            }
            if (!failure) { check(signal); emit({ type: "upload", done: ++done, total: missing.length }); }
          }
        } catch (err) { failure ??= err; }
      }));
      if (failure) throw failure;
      check(signal);
      const committed = object(await request(`${site}/deploy/${encodeURIComponent(deployId)}/commit`, device, token, "POST", "{}", signal));
      if (![committed.fileCount, committed.bytes].every(n => typeof n === "number" && Number.isSafeInteger(n) && n >= 0)) throw new PublishError("server", "发布服务返回了无效文件统计");
      record = { ...record, source, url: string(committed.url), lastPublishedAt: Date.now(), fileCount: committed.fileCount as number, bytes: committed.bytes as number };
      // Persist a successful commit even if cancellation raced with its response.
      await store.saveRecord(root, record);
      check(signal);
      emit({ type: "done", record });
      return record;
    } catch (err) {
      const error = signal.aborted ? new PublishError("cancelled", "发布已取消") : err instanceof PublishError ? err :
        new PublishError("server", err instanceof Error ? err.message : String(err));
      emit({ type: "error", code: error.code, message: error.message });
      throw error;
    } finally {
      if (dir) await fs.rm(dir, { recursive: true, force: true });
    }
  });
}
export function listRecords(): Promise<PublishRecord[]> {
  const root = getRoot();
  return store.exclusive(() => store.readRecords(root));
}
export function unpublish(siteId: string): Promise<void> {
  const root = getRoot();
  return store.exclusive(async () => {
    const token = await store.getToken(siteId);
    if (!token) throw new PublishError("server", "本机缺少这个站点的发布凭证");
    await request(`/v1/sites/${encodeURIComponent(siteId)}`, await store.deviceId(), token, "DELETE");
    await store.removeRecord(root, siteId);
    await store.setToken(siteId);
  });
}
