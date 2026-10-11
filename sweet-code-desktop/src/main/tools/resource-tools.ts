import { z } from "zod";
import type { SkillAudit, SkillCandidate, SkillHubItem, SkillSource } from "@shared/types";
import { RESOURCES } from "@shared/resources";
import type { SkillStore } from "../plugins/skills";
import type { Complete } from "../plugins/skill-review";
import { SLUG } from "../plugins/skillhub";
import { defineTool, type ToolSpec } from "./registry";

// Lets the agent find and install skills for the user, e.g. when a card in the resource library
// pushes "install this" to the chat. Every skill goes through the security review first (rule
// scan, plus the AI review when the rules find anything); the user sees the result on the
// approval card, and a skill rated high-risk can only be approved by the user personally.

interface Deps {
  store: SkillStore;
  onInstalled(): Promise<unknown>;
  search(query: string): Promise<SkillHubItem[]>;
  reviewer: Complete;
}

const LEVEL_TEXT = { pass: "安全审核通过", notice: "安全审核：只有提示", warn: "安全审核：有需要注意的地方", danger: "安全审核：发现高风险内容" } as const;

export function resourceTools({ store, onInstalled, search, reviewer }: Deps): ToolSpec[] {
  const installSkills = defineTool({
    name: "install_skills",
    description:
      "Install agent skills (SKILL.md folders) into this app, so future conversations can use them. Sources: a GitHub repository URL, " +
      'or "skillhub:<slug>" for a skill from the SkillHub store (find slugs with search_skillhub). ' +
      "Use it when the user asks to install skills or picks one from the resource library. Name the skills to install when a GitHub " +
      "repository has many and the user only wants some; omit `skills` to install all. Every skill is security-reviewed and the user " +
      "approves the list (with the review results) before anything is installed. Installed skills become available in the next new conversation.",
    schema: z.object({
      source: z.string().min(1),
      skills: z.array(z.string().min(1)).max(60).optional(),
    }),
    inputSchema: {
      type: "object",
      properties: {
        source: { type: "string", description: 'GitHub repository URL (e.g. https://github.com/greensock/gsap-skills) or "skillhub:<slug>"' },
        skills: { type: "array", items: { type: "string" }, description: "Skill names to install (folder names, GitHub only). Omit for all." },
      },
      required: ["source"],
    },
    permission: "confirm",
    parallelSafe: false,
    summarize: (i) => `安装技能 ${i.source.replace(/^https:\/\/github\.com\//, "").replace(/^skillhub:/, "SkillHub · ")}`,
    async run({ source, skills }, ctx) {
      let from: SkillSource;
      const hub = source.trim().match(/^skillhub:(.+)$/i);
      if (hub) {
        if (!SLUG.test(hub[1])) throw new Error(`"${hub[1]}" is not a SkillHub slug. Use search_skillhub to find the exact slug.`);
        from = { kind: "skillhub", slug: hub[1] };
      } else if (/^https:\/\/(github\.com|raw\.githubusercontent\.com)\//.test(source)) {
        from = { kind: "url", url: source, only: skills };
      } else {
        throw new Error('Only GitHub repositories and "skillhub:<slug>" can be installed from here. Ask the user to add other sources in the plugin center.');
      }
      let preview = await store.preview(from);
      // Some repos keep the same skill in several folders (.claude/, .factory/): one each.
      const seen = new Set<string>();
      const all = preview.candidates.filter((c) => !seen.has(c.name) && seen.add(c.name));
      const wanted = skills?.length && !hub ? new Set(skills.map((s) => s.trim().toLowerCase())) : null;
      let chosen = wanted ? all.filter((c) => wanted.has(c.name.toLowerCase())) : all;
      if (!chosen.length) {
        return `No matching skills in ${source}. Available: ${all.map((c) => c.name).join(", ") || "(none found)"}.`;
      }
      const missing = wanted ? [...wanted].filter((w) => !all.some((c) => c.name.toLowerCase() === w)) : [];

      // The AI reads anything the rules flagged, so the card shows more than pattern matches.
      const flagged = chosen.filter((c) => c.audit.level !== "pass" && c.audit.level !== "notice").map((c) => c.id);
      if (flagged.length) {
        try {
          preview = await store.aiReview(preview.previewId, reviewer, ctx.signal, flagged);
          chosen = chosen.map((c) => preview.candidates.find((x) => x.id === c.id) ?? c);
        } catch {
          // The rule results still stand; the card says the AI review didn't run.
        }
      }

      const danger = chosen.filter((c) => c.audit.level === "danger");
      const card = RESOURCES.find((r) => source.toLowerCase().startsWith(r.repo.toLowerCase()));
      const scripted = chosen.filter((c) => c.hasScripts);
      const replacing = chosen.filter((c) => c.exists);
      const outcome = await ctx.requestApproval({
        kind: "tool",
        server: card ? `资源库 · ${card.title}` : hub ? "SkillHub 商店" : "安装技能",
        tool: "install_skills",
        description:
          `从 ${preview.source} 安装 ${chosen.length} 个技能。技能里的说明会影响 AI 做事的方式，装好后在新对话里生效。` +
          (danger.length ? ` ⚠ 安全审核认为 ${danger.map((c) => c.name).join("、")} 有高风险内容，请看下面的说明再决定。` : "") +
          (scripted.length ? ` 其中 ${scripted.length} 个带脚本（${scripted.map((c) => c.name).join("、")}），只在 AI 用到时、经你同意后才会运行。` : "") +
          (replacing.length ? ` ${replacing.map((c) => c.name).join("、")} 已经装过，会被替换成新版本。` : ""),
        args: chosen.map(describeCandidate).join("\n\n"),
        ...(danger.length ? { humanOnly: "安全审核发现了高风险内容，装不装要你亲自决定。" } : {}),
      });
      if (!outcome.approved) {
        return `The user did not approve installing these skills${outcome.feedback ? `: "${outcome.feedback}"` : ""}. Nothing was installed.`;
      }
      // Approval of a danger card can only come from the user (humanOnly), so it is their risk to accept.
      await store.install(preview.previewId, chosen.map((c) => c.id), danger.length > 0);
      await onInstalled();
      const lines = [
        `Installed ${chosen.length} skill(s) from ${preview.source}: ${chosen.map((c) => c.name).join(", ")}.`,
        missing.length ? `Not found in the repo: ${missing.join(", ")}.` : "",
        "They are available from the next new conversation (this one keeps the skills it started with).",
        "Security review:",
        ...chosen.map((c) => `- ${c.name}: ${c.audit.level}${c.audit.findings.length ? ` (${c.audit.findings.slice(0, 3).map((f) => f.title).join("; ")})` : ""}`),
        "Descriptions:",
        ...chosen.map((c) => `- ${c.name}: ${c.description.slice(0, 200)}`),
      ];
      return lines.filter(Boolean).join("\n");
    },
  });

  const searchSkillHub = defineTool({
    name: "search_skillhub",
    description:
      "Search the SkillHub store (skillhub.cn, a Chinese skill store with community and mirrored ClawHub skills) for agent skills. " +
      'Returns slugs to install with install_skills (source "skillhub:<slug>"). Prefer well-used skills (downloads/installs) and say which one you picked and why. ' +
      "Store skills are written by anyone; the install step security-reviews them.",
    schema: z.object({ query: z.string().min(1).max(100) }),
    inputSchema: {
      type: "object",
      properties: { query: { type: "string", description: "Keywords, Chinese or English, e.g. 'pdf', 'Excel 报表', 'react animation'" } },
      required: ["query"],
    },
    permission: "auto",
    parallelSafe: true,
    summarize: (i) => `在 SkillHub 搜索「${i.query}」`,
    async run({ query }) {
      const items = await search(query);
      if (!items.length) return `No SkillHub results for "${query}". Try other keywords (English names often work better).`;
      return [
        `SkillHub results for "${query}" (install with source "skillhub:<slug>"):`,
        ...items.slice(0, 15).map(
          (s) =>
            `- ${s.slug} — ${s.name} v${s.version || "?"} by ${s.owner || "?"} [${s.source}], ${s.downloads} downloads, ${s.installs} installs` +
            `${s.requiresApiKey ? ", needs an API key" : ""}: ${s.summary.slice(0, 160)}`,
        ),
      ].join("\n");
    },
  });

  return [installSkills, searchSkillHub] as ToolSpec[];
}

/** One candidate on the approval card: name, scripts, and what the security review found. */
function describeCandidate(c: SkillCandidate): string {
  const a: SkillAudit = c.audit;
  const lines = [`${c.name}${c.hasScripts ? "（带脚本）" : ""} — ${c.description.slice(0, 120)}`, `  ${LEVEL_TEXT[a.level]}`];
  for (const f of a.findings.filter((x) => x.severity !== "low").slice(0, 6)) {
    lines.push(`  · ${f.severity === "high" ? "高风险" : "注意"}：${f.title}（${f.file}${f.line ? `:${f.line}` : ""}）${f.excerpt ? ` ${f.excerpt.slice(0, 100)}` : ""}`);
  }
  if (a.ai && "verdict" in a.ai) lines.push(`  AI 审核（${a.ai.model}）：${{ safe: "安全", suspicious: "可疑", malicious: "恶意" }[a.ai.verdict]}。${a.ai.summary}`);
  else if (a.ai && "error" in a.ai) lines.push(`  AI 审核没有完成：${a.ai.error}`);
  return lines.join("\n");
}
