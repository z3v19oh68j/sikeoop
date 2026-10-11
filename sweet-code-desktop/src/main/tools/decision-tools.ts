import { z } from "zod";
import type { Answer, JevClient, Question, State } from "../decision/client";
import { JevError } from "../decision/client";
import { assess, describe } from "../decision/policy";
import { defineTool, type ToolSpec } from "./registry";

// The decide tool: the main model hands a set of items and typed questions to the decision
// model (Jev), which answers each with structured values and probabilities. Cheap and fast, so
// the agent uses it instead of judging many items one by one in its own context. Answers it
// isn't sure about are flagged for the agent to check (docs/jev-decision-layer.md §3.1, §4).

const MAX_ITEMS = 50;

const questionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("noul"),
    instructions: z.string().max(2000).optional(),
    criteria: z.object({ true: z.string().optional(), false: z.string().optional() }).optional(),
  }),
  z.object({ type: z.literal("choice"), instructions: z.string().max(2000).optional(), criteria: z.record(z.string(), z.string()) }),
  z.object({ type: z.literal("score"), instructions: z.string().max(2000).optional(), criteria: z.array(z.string()) }),
]);

const stateSchema = z.union([z.string().min(1), z.record(z.string(), z.unknown())]);

interface Deps {
  client: JevClient;
  model(): string;
  /** The open project, for the one-time consent to send its data. */
  root(): string;
  hasConsent(root: string): Promise<boolean>;
  grantConsent(root: string, model: string): Promise<void>;
}

export function decisionTools(deps: Deps): ToolSpec[] {
  const decide = defineTool({
    name: "decide",
    description:
      "Ask the decision model (TypeSafe Jev) typed questions about a list of items. It returns structured answers with probabilities, " +
      "never prose: `noul` = yes/no probability, `choice` = one of named options, `score` = a level on an ordered scale. " +
      "Use it when the same judgement has to be made about many items (classify tickets or emails, route requests, rate relevance, " +
      "risk or priority, filter records) instead of judging them one by one yourself. Up to 50 items per call, up to 32 questions. " +
      "Each item is judged on its own; put shared background (a policy, the user's goal) in `background`. " +
      "Write instructions and option descriptions that state the criterion precisely; the answers are only as good as the options. " +
      "Answers marked unsure should be checked by you (read the item) or shown to the user, not taken as final. " +
      "Never use it as the only basis for decisions about a specific person (hiring, discipline); say so to the user.",
    schema: z.object({
      questions: z.record(z.string(), questionSchema),
      items: z.array(stateSchema).min(1).max(MAX_ITEMS),
      background: z.string().max(20_000).optional(),
    }),
    inputSchema: {
      type: "object",
      properties: {
        questions: {
          type: "object",
          description:
            'Named questions, e.g. {"urgent": {"type": "noul", "instructions": "Does this need a reply today?"}, ' +
            '"team": {"type": "choice", "instructions": "Which team owns it?", "criteria": {"billing": "Charges and refunds", "tech": "Bugs and errors"}}, ' +
            '"impact": {"type": "score", "instructions": "How much does it block the user?", "criteria": ["None", "Minor", "Major", "Blocked"]}}. ' +
            "Names: letters, digits, _ or -. choice criteria: {option: description}, 2-255 options. score criteria: levels from lowest to highest, 2-10.",
          additionalProperties: {
            type: "object",
            properties: {
              type: { type: "string", enum: ["noul", "choice", "score"] },
              instructions: { type: "string" },
              criteria: { description: "noul: {true, false} (optional); choice: {option: description}; score: [level, ...] lowest first" },
            },
            required: ["type"],
          },
        },
        items: {
          type: "array",
          description: "The things to judge, each a string or a JSON object (e.g. one table row). Up to 50.",
          items: {},
        },
        background: { type: "string", description: "Context shared by every item, e.g. the routing policy." },
      },
      required: ["questions", "items"],
    },
    permission: "auto",
    parallelSafe: true,
    summarize: (i) => `用决策模型判断 ${i.items.length} 条（${Object.keys(i.questions).join("、")}）`,
    async run({ questions, items, background }, ctx) {
      if (!deps.client.ready()) {
        return "The decision model isn't set up: there is no TokenDance key. Tell the user to add it in 设置 → 决策模型, or judge the items yourself.";
      }
      const root = deps.root();
      if (!(await deps.hasConsent(root))) {
        const sample = items.slice(0, 2).map((it, i) => `第 ${i + 1} 条：${(typeof it === "string" ? it : JSON.stringify(it)).slice(0, 300)}`);
        const outcome = await ctx.requestApproval({
          kind: "tool",
          server: "决策模型 · TokenDance",
          tool: "decide",
          description:
            `AI 想把 ${items.length} 条内容${background ? "和一段背景说明" : ""}发给决策模型 ${deps.model()}（TokenDance → ${deps.model().split("-")[0]}）做判断。` +
            "内容会离开这台电脑。同意后，这个项目以后再用决策模型就不再问你。",
          args: [`问题：${Object.entries(questions).map(([n, q]) => `${n}（${q.type}）${q.instructions ? `：${q.instructions}` : ""}`).join("；")}`, ...sample].join("\n"),
          humanOnly: "要把项目里的内容发给第三方服务，第一次需要你亲自同意。",
        });
        if (!outcome.approved) {
          return `The user did not agree to send this data to the decision model${outcome.feedback ? `: "${outcome.feedback}"` : ""}. Judge the items yourself or ask the user how to proceed.`;
        }
        await deps.grantConsent(root, deps.model());
      }

      const started = Date.now();
      const qs = questions as Record<string, Question>;
      const results = await Promise.all(
        items.map(async (item) => {
          const state: State = background ? { background, item } : (item as State);
          try {
            return { ok: true as const, ...(await deps.client.decide(state, qs, ctx.signal)) };
          } catch (e) {
            if (ctx.signal.aborted) throw e;
            return { ok: false as const, error: e instanceof JevError ? e : new JevError((e as Error).message, 0, "error", false) };
          }
        }),
      );
      // The same mistake on every item (bad question, bad key) is reported once, for the agent to fix.
      const failures = results.filter((r) => !r.ok);
      if (failures.length === results.length) throw failures[0].error;

      const lines: string[] = [];
      const unsure: number[] = [];
      let tokens = 0;
      let requests = 0;
      let model = deps.model();
      results.forEach((r, i) => {
        if (!r.ok) {
          lines.push(`#${i + 1} 出错：${r.error.message}`);
          return;
        }
        tokens += r.inputTokens;
        requests += r.requests;
        model = r.model || model;
        const doubts = Object.entries(r.answers)
          .map(([n, a]) => [n, assess(a)] as const)
          .filter(([, s]) => !s.sure)
          .map(([n, s]) => `${n}：${s.why}`);
        if (doubts.length) unsure.push(i + 1);
        lines.push(`#${i + 1} ${Object.entries(r.answers).map(([n, a]) => describe(n, a)).join(" · ")}${doubts.length ? `  ⚠ 拿不准（${doubts.join("；")}）` : ""}`);
      });

      const answered = results.flatMap((r) => (r.ok ? [r.answers] : []));
      return [
        `Decision model ${model} judged ${answered.length}/${items.length} item(s) in ${((Date.now() - started) / 1000).toFixed(1)}s ` +
          `(${requests} request(s), ${tokens} input tokens). #n is the item's position in \`items\`, starting at 1.`,
        ...lines,
        "",
        "Totals:",
        ...Object.keys(qs).map((n) => `- ${totals(n, answered.map((a) => a[n]).filter(Boolean))}`),
        unsure.length
          ? `\nUnsure: ${unsure.map((n) => `#${n}`).join(" ")}. Check these yourself (read the item) or show them to the user; don't treat them as final.`
          : "\nAll answers are confident.",
        failures.length ? `${failures.length} item(s) failed; retry them or judge them yourself.` : "",
      ]
        .filter((l) => l !== "")
        .join("\n");
    },
  });
  return [decide] as ToolSpec[];
}

/** One question's answers summed up across items. */
function totals(name: string, answers: Answer[]): string {
  if (!answers.length) return `${name}: no answers`;
  const a0 = answers[0];
  if (a0.type === "noul") {
    const yes = answers.filter((a) => a.type === "noul" && a.p >= 0.5).length;
    return `${name}: 是 ${yes} / 否 ${answers.length - yes}`;
  }
  if (a0.type === "choice") {
    const counts = new Map<string, number>();
    for (const a of answers) if (a.type === "choice") counts.set(a.choice, (counts.get(a.choice) ?? 0) + 1);
    return `${name}: ${[...counts].sort((x, y) => y[1] - x[1]).map(([k, v]) => `${k} ${v}`).join(", ")}`;
  }
  const scores = answers.flatMap((a) => (a.type === "score" ? [a] : []));
  const avg = scores.reduce((s, a) => s + a.score, 0) / scores.length;
  const levels = new Map<string, number>();
  for (const a of scores) {
    const label = a.legend[String(Math.round(a.score))] ?? String(Math.round(a.score));
    levels.set(label, (levels.get(label) ?? 0) + 1);
  }
  return `${name}: 平均 ${avg.toFixed(1)}；${[...levels].map(([k, v]) => `「${k}」${v}`).join("，")}`;
}
