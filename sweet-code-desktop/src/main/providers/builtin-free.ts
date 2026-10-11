/** Build configuration only. Diagnostics never interpolate supplied values or errors. */
export interface BuiltinFreeProvider {
  id: string;
  name: string;
  baseUrl: string;
  key: string;
  protocol: "openai" | "anthropic";
  /** A fixed model id; without one the provider routes as "auto". */
  model?: string;
}
export type BuiltinConfigLog = (message: string) => void;
const defaultLog: BuiltinConfigLog = message => console.warn(message);

function endpoint(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return;
  try {
    const url = new URL(value.trim());
    if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.search || url.hash) return;
    return url.href.replace(/\/+$/, "");
  } catch { return; }
}

export function parseBuiltinFreeProviders(raw: string = "[]", log: BuiltinConfigLog = defaultLog): BuiltinFreeProvider[] {
  let values: unknown;
  try { values = JSON.parse(raw); }
  catch { log("[builtin-free] ignored configuration: invalid JSON"); return []; }
  if (!Array.isArray(values)) { log("[builtin-free] ignored configuration: expected array"); return []; }
  const out: BuiltinFreeProvider[] = [];
  const ids = new Set<string>(), endpoints = new Set<string>();
  values.forEach((value, index) => {
    const invalid = () => log(`[builtin-free] ignored item ${index}: invalid or duplicate configuration`);
    if (!value || typeof value !== "object" || Array.isArray(value)) { invalid(); return; }
    const item = value as Record<string, unknown>;
    const baseUrl = endpoint(item.baseUrl);
    if (typeof item.id !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(item.id)
      || typeof item.name !== "string" || !item.name.trim() || !baseUrl
      || typeof item.key !== "string" || !item.key.trim()
      || (item.protocol !== "openai" && item.protocol !== "anthropic")
      || (item.model !== undefined && (typeof item.model !== "string" || !item.model.trim()))) { invalid(); return; }
    const model = typeof item.model === "string" ? item.model.trim() : undefined;
    const id = item.id === "builtin-free" || item.id.startsWith("builtin-free-") ? item.id : `builtin-free-${item.id}`;
    // The same endpoint may appear once per fixed model (one key each).
    const fingerprint = `${item.protocol}:${baseUrl}:${model ?? "auto"}`;
    if (ids.has(id) || endpoints.has(fingerprint)) { invalid(); return; }
    ids.add(id); endpoints.add(fingerprint);
    out.push({ id, name: item.name.trim(), baseUrl, key: item.key.trim(), protocol: item.protocol, ...(model ? { model } : {}) });
  });
  return out;
}

/** Explicit array entries win duplicates; unique legacy configuration retains its stable id. */
export function mergeBuiltinFreeProviders(raw: string, legacyURL: string, legacyKey: string,
  log: BuiltinConfigLog = defaultLog): BuiltinFreeProvider[] {
  const providers = parseBuiltinFreeProviders(raw, log);
  if (!legacyURL.trim() || !legacyKey.trim()) return providers;
  const baseUrl = endpoint(legacyURL);
  if (!baseUrl) { log("[builtin-free] ignored legacy configuration: invalid endpoint"); return providers; }
  if (!providers.some(p => p.id === "builtin-free" || (p.protocol === "openai" && p.baseUrl === baseUrl)))
    providers.push({ id: "builtin-free", name: "内置免费模型", baseUrl, key: legacyKey.trim(), protocol: "openai" });
  return providers;
}
