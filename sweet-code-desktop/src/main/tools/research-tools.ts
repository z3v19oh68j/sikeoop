import { z } from "zod";
import { defineTool, type ToolSpec } from "./registry";

// lookup_packages: real numbers for technology research. Before recommending a library the agent
// checks that it is alive (latest version, last release), widely used (weekly downloads) and not
// deprecated, instead of going by what it remembers. Read-only GETs to the public npm and PyPI
// registries, so no approval is needed.

type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

interface PackageFacts {
  name: string;
  found: boolean;
  version?: string;
  description?: string;
  /** ISO date of the latest release. */
  released?: string;
  weeklyDownloads?: number;
  license?: string;
  homepage?: string;
  deprecated?: string;
}

const TIMEOUT = 15_000;
const NAME = /^(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/i;

async function getJson(fetcher: Fetcher, url: string): Promise<unknown | null> {
  try {
    const res = await fetcher(url, { headers: { Accept: "application/json", "User-Agent": "sikeoop" }, signal: AbortSignal.timeout(TIMEOUT) });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);

async function npmFacts(fetcher: Fetcher, name: string): Promise<PackageFacts> {
  const enc = name.startsWith("@") ? `@${encodeURIComponent(name.slice(1))}` : encodeURIComponent(name);
  // Small endpoints only: the full document of a big package (typescript, react) is megabytes.
  const [v, dl, found] = await Promise.all([
    getJson(fetcher, `https://registry.npmjs.org/${enc}/latest`) as Promise<Record<string, unknown> | null>,
    getJson(fetcher, `https://api.npmjs.org/downloads/point/last-week/${name}`) as Promise<{ downloads?: number } | null>,
    getJson(fetcher, `https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(name)}&size=5`) as Promise<{
      objects?: { package?: { name?: string; date?: string } }[];
    } | null>,
  ]);
  if (!v || !str(v.version)) return { name, found: false };
  const repo = v.repository as { url?: string } | string | undefined;
  const date = found?.objects?.find((o) => o.package?.name === name)?.package?.date;
  return {
    name,
    found: true,
    version: str(v.version),
    description: str(v.description),
    released: date?.slice(0, 10),
    weeklyDownloads: typeof dl?.downloads === "number" ? dl.downloads : undefined,
    license: str(v.license),
    homepage: str(v.homepage) ?? (typeof repo === "string" ? repo : str(repo?.url)?.replace(/^git\+/, "")),
    deprecated: str(v.deprecated),
  };
}

async function pypiFacts(fetcher: Fetcher, name: string): Promise<PackageFacts> {
  const [doc, stats] = await Promise.all([
    getJson(fetcher, `https://pypi.org/pypi/${encodeURIComponent(name)}/json`) as Promise<{ info?: Record<string, unknown>; urls?: { upload_time_iso_8601?: string }[] } | null>,
    getJson(fetcher, `https://pypistats.org/api/packages/${encodeURIComponent(name.toLowerCase())}/recent`) as Promise<{ data?: { last_week?: number } } | null>,
  ]);
  const info = doc?.info;
  if (!info) return { name, found: false };
  const urls = (info.project_urls ?? {}) as Record<string, string>;
  return {
    name,
    found: true,
    version: str(info.version),
    description: str(info.summary),
    released: doc?.urls?.[0]?.upload_time_iso_8601?.slice(0, 10),
    weeklyDownloads: stats?.data?.last_week,
    license: str(info.license)?.slice(0, 40),
    homepage: str(info.home_page) ?? urls.Homepage ?? urls.Source,
    deprecated: info.yanked ? "yanked" : undefined,
  };
}

async function npmSearch(fetcher: Fetcher, query: string): Promise<string[]> {
  const body = (await getJson(fetcher, `https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(query)}&size=8`)) as {
    objects?: { package?: { name?: string } }[];
  } | null;
  return (body?.objects ?? []).flatMap((o) => (o.package?.name ? [o.package.name] : []));
}

function ago(date?: string): string {
  if (!date) return "?";
  const days = Math.round((Date.now() - Date.parse(date)) / 86_400_000);
  return days < 31 ? `${date} (${days} days ago)` : days < 365 ? `${date} (${Math.round(days / 30)} months ago)` : `${date} (${(days / 365).toFixed(1)} years ago)`;
}

const fmt = (f: PackageFacts) =>
  f.found
    ? `- ${f.name} ${f.version ?? "?"} — released ${ago(f.released)}, ${f.weeklyDownloads !== undefined ? `${f.weeklyDownloads.toLocaleString("en")} downloads/week` : "downloads unknown"}` +
      `${f.license ? `, ${f.license}` : ""}${f.deprecated ? `, ⚠ DEPRECATED: ${f.deprecated.slice(0, 120)}` : ""}` +
      `${f.description ? `\n  ${f.description.slice(0, 200)}` : ""}${f.homepage ? `\n  ${f.homepage}` : ""}`
    : `- ${f.name}: not found`;

export function researchTools(fetcher: Fetcher): ToolSpec[] {
  const lookup = defineTool({
    name: "lookup_packages",
    description:
      "Look up libraries on the npm or PyPI registry: latest version, date of the last release, weekly downloads, license and whether " +
      "it is deprecated. Use it when choosing technologies for a new project or feature, to compare candidates with current facts " +
      "rather than memory (a library may be abandoned, renamed or have a new major version), and to pick versions to install. " +
      "Give exact package names, or a `search` phrase to find candidates on npm. Read-only.",
    schema: z.object({
      ecosystem: z.enum(["npm", "pypi"]).default("npm"),
      names: z.array(z.string().regex(NAME)).max(12).optional(),
      search: z.string().min(2).max(80).optional(),
    }),
    inputSchema: {
      type: "object",
      properties: {
        ecosystem: { type: "string", enum: ["npm", "pypi"], description: "npm (JavaScript/TypeScript) or pypi (Python). Default npm." },
        names: { type: "array", items: { type: "string" }, description: "Exact package names, e.g. ['react', 'vue', 'svelte']. Up to 12." },
        search: { type: "string", description: "npm only: keywords to find candidate packages, e.g. 'react drag and drop'." },
      },
    },
    permission: "auto",
    parallelSafe: true,
    summarize: (i) => `查资料：${i.search ? `搜索 ${i.search}` : (i.names ?? []).slice(0, 4).join("、")}${(i.names?.length ?? 0) > 4 ? " 等" : ""}`,
    async run({ ecosystem, names, search }) {
      let list = names ?? [];
      const lines: string[] = [];
      if (search) {
        if (ecosystem !== "npm") return "Search works on npm only; for PyPI give exact names.";
        const found = await npmSearch(fetcher, search);
        if (!found.length) return `npm search for "${search}" found nothing (or the registry couldn't be reached).`;
        lines.push(`npm search "${search}": ${found.join(", ")}`);
        list = [...new Set([...list, ...found])].slice(0, 12);
      }
      if (!list.length) return "Give package names or a search phrase.";
      const facts = await Promise.all(list.map((n) => (ecosystem === "pypi" ? pypiFacts(fetcher, n) : npmFacts(fetcher, n))));
      if (facts.every((f) => !f.found)) lines.push(`(None found on ${ecosystem}. Check the names, or the registry may be unreachable.)`);
      lines.push(`${ecosystem} facts as of ${new Date().toISOString().slice(0, 10)}:`, ...facts.map(fmt));
      return lines.join("\n");
    },
  });
  return [lookup] as ToolSpec[];
}
