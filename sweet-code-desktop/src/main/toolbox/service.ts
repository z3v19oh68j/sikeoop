import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { AiSite, AiToolboxPrefs } from "../../shared/types.ts";

const categories = new Set(["cn-search", "cn-assistant", "global", "academic", "dev", "custom"]);
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("配置必须是对象");
  return value as Record<string, unknown>;
}
function text(value: unknown, max = 8192): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error("文本字段无效");
  return value;
}
export function validateUrl(value: unknown): string {
  const raw = text(value);
  const url = new URL(raw);
  if (!["http:", "https:"].includes(url.protocol) || !url.hostname || url.username || url.password || /[\u0000-\u0020\\]/.test(raw)) throw new Error("站点只允许无凭据的 http/https URL");
  return raw;
}
export function validateSite(value: unknown, custom = false): AiSite {
  const s = record(value);
  const id = text(s.id, 100);
  if (!/^[a-zA-Z0-9_-]+$/.test(id) || !categories.has(String(s.category)) || !["none", "optional", "required"].includes(String(s.login))) throw new Error("站点字段无效");
  const site: AiSite = { id, name: text(s.name, 200), category: custom ? "custom" : s.category as AiSite["category"], home: validateUrl(s.home), login: s.login as AiSite["login"] };
  if (s.query !== undefined && s.query !== "") {
    const query = text(s.query);
    if (!query.includes("{q}")) throw new Error("查询模板必须含 {q}");
    validateUrl(query.replaceAll("{q}", "test"));
    // Questions must not alter scheme, credentials or the destination host.
    if (new URL(query.replaceAll("{q}", "test")).origin !== new URL(query.replaceAll("{q}", "other")).origin) throw new Error("查询占位符不能位于站点地址中");
    site.query = query;
  }
  if (s.note !== undefined) { if (typeof s.note !== "string" || s.note.length > 2000) throw new Error("备注无效"); site.note = s.note; }
  if (s.cnDirect !== undefined) { if (typeof s.cnDirect !== "boolean") throw new Error("cnDirect 无效"); site.cnDirect = s.cnDirect; }
  return site;
}
export function emptyPrefs(): AiToolboxPrefs { return { favorites: [], order: [], hidden: [], custom: [], groups: [] }; }
function ids(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 1000 || value.some(v => typeof v !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(v))) throw new Error("站点 ID 列表无效");
  return [...new Set(value as string[])];
}
export function validatePrefs(value: unknown, builtins: AiSite[]): AiToolboxPrefs {
  const p = record(value);
  if (!Array.isArray(p.custom) || p.custom.length > 200 || !Array.isArray(p.groups) || p.groups.length > 100) throw new Error("自定义站点或组合无效");
  const custom = p.custom.map(s => validateSite(s, true));
  const used = new Set(builtins.map(s => s.id));
  for (const s of custom) { if (used.has(s.id)) throw new Error("站点 ID 重复"); used.add(s.id); }
  const groupIds = new Set<string>();
  const groups = p.groups.map(raw => { const g = record(raw); const id = text(g.id, 100); if (!/^[a-zA-Z0-9_-]+$/.test(id) || groupIds.has(id)) throw new Error("组合 ID 无效或重复"); groupIds.add(id); return { id, name: text(g.name, 200), sites: ids(g.sites) }; });
  return { favorites: ids(p.favorites), order: ids(p.order), hidden: ids(p.hidden), custom, groups };
}
export function buildOpenUrl(site: AiSite, question?: string): { url: string; copied: boolean } {
  if (question !== undefined && (typeof question !== "string" || question.length > 100_000)) throw new Error("问题无效或过长");
  const s = validateSite(site);
  if (question && s.query) return { url: validateUrl(s.query.replaceAll("{q}", encodeURIComponent(question))), copied: false };
  return { url: s.home, copied: Boolean(question && !s.query) };
}
export class ToolboxService {
  private manifest: string;
  private prefsFile: string;
  private copy: (text: string) => void;
  private saves: Promise<void> = Promise.resolve();
  constructor(manifest: string, userData: string, copy: (text: string) => void) { this.manifest = manifest; this.prefsFile = path.join(userData, "toolbox.json"); this.copy = copy; }
  private async builtins(): Promise<AiSite[]> {
    try {
      const raw: unknown = JSON.parse(await fs.readFile(this.manifest, "utf8"));
      if (!Array.isArray(raw) || raw.length > 1000) return [];
      const result: AiSite[] = []; const seen = new Set<string>();
      for (const entry of raw) { try { const site = validateSite(entry); if (!seen.has(site.id)) { seen.add(site.id); result.push(site); } } catch { /* An invalid entry must not disable other sites. */ } }
      return result;
    } catch { return []; }
  }
  async prefs(): Promise<AiToolboxPrefs> {
    try { return validatePrefs(JSON.parse(await fs.readFile(this.prefsFile, "utf8")), await this.builtins()); } catch { return emptyPrefs(); }
  }
  async sites(): Promise<AiSite[]> { return [...await this.builtins(), ...(await this.prefs()).custom]; }
  async savePrefs(input: AiToolboxPrefs): Promise<void> {
    const snapshot = structuredClone(input);
    const operation = this.saves.then(async () => {
      const prefs = validatePrefs(snapshot, await this.builtins());
      await fs.mkdir(path.dirname(this.prefsFile), { recursive: true });
      const tmp = this.prefsFile + "." + randomUUID() + ".tmp";
      try { await fs.writeFile(tmp, JSON.stringify(prefs, null, 2), { flag: "wx", mode: 0o600 }); await fs.rename(tmp, this.prefsFile); }
      finally { await fs.rm(tmp, { force: true }); }
    });
    this.saves = operation.catch(() => {});
    await operation;
  }
  async openUrl(siteId: string, question?: string): Promise<{ url: string; copied: boolean }> {
    if (typeof siteId !== "string") throw new Error("站点 ID 无效");
    const site = (await this.sites()).find(s => s.id === siteId);
    if (!site) throw new Error("站点不存在");
    const result = buildOpenUrl(site, question);
    if (result.copied) this.copy(question!);
    return result;
  }
}
