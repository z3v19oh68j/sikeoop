import type { SkillHubItem } from "@shared/types";

// The SkillHub store (skillhub.cn), used directly over its HTTP API instead of through its
// Python CLI. Endpoints come from the CLI's own metadata.json (kit 2026.8.5):
//   search:   GET https://api.skillhub.cn/api/v1/search?q=…&limit=…  → { results: [...] }
//   download: GET https://api.skillhub.cn/api/v1/download?slug=…     → 302 to a zip on Tencent COS
// The zip is a standard skill folder (SKILL.md at the root, plus _meta.json). Unlike the CLI we
// send no client id and don't fingerprint the calling process.

export const SKILLHUB_SEARCH = "https://api.skillhub.cn/api/v1/search";
export const skillHubDownloadUrl = (slug: string) => `https://api.skillhub.cn/api/v1/download?slug=${encodeURIComponent(slug)}`;
export const skillHubLabel = (slug: string) => `SkillHub · ${slug}`;
export const SLUG = /^[a-z0-9][a-z0-9._-]{0,127}$/i;

type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

export async function searchSkillHub(fetcher: Fetcher, query: string, limit = 24): Promise<SkillHubItem[]> {
  const q = query.trim();
  if (!q) return [];
  let res: Response;
  try {
    res = await fetcher(`${SKILLHUB_SEARCH}?q=${encodeURIComponent(q)}&limit=${Math.min(50, Math.max(1, limit))}`, {
      headers: { Accept: "application/json", "User-Agent": "sikeoop" },
      signal: AbortSignal.timeout(20_000),
    });
  } catch (e) {
    throw new Error(`连不上 SkillHub，检查一下网络：${(e as Error).message}`);
  }
  if (res.status === 429) throw new Error("SkillHub 说请求太频繁了，等一会儿再搜");
  if (!res.ok) throw new Error(`SkillHub 搜索失败（${res.status}）`);
  const body = (await res.json()) as { results?: unknown };
  if (!Array.isArray(body.results)) return [];
  const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  return body.results.flatMap((r): SkillHubItem[] => {
    if (!r || typeof r !== "object") return [];
    const o = r as Record<string, unknown>;
    const slug = str(o.slug);
    if (!SLUG.test(slug)) return [];
    const labels = (o.labels && typeof o.labels === "object" ? o.labels : {}) as Record<string, unknown>;
    const ns = (o.namespace && typeof o.namespace === "object" ? o.namespace : {}) as Record<string, unknown>;
    return [
      {
        slug,
        name: str(o.displayName) || str(o.name) || slug,
        summary: (str(o.description_zh) || str(o.summary) || str(o.description)).slice(0, 300),
        version: str(o.version),
        category: str(o.category),
        source: str(o.source),
        owner: str(o.owner_name) || str(ns.displayName),
        downloads: num(o.downloads),
        installs: num(o.installs),
        stars: num(o.stars),
        requiresApiKey: String(labels.requires_api_key) === "true",
        homepage: /^https:\/\//.test(str(o.homepage)) ? str(o.homepage) : "",
      },
    ];
  });
}
