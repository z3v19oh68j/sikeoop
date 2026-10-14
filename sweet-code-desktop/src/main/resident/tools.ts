import { z } from "zod";
import { defineTool, type ToolSpec } from "../tools/registry.ts";

export interface ResidentReport {
  topic: string;
  summary: string;
  outputs: string[];
}

/** resident_report: how a learning round hands in what it learned and what it left behind. Only resident rounds have it. */
export function residentReportTool(accept: (report: ResidentReport) => void): ToolSpec {
  return defineTool({
    name: "resident_report",
    description:
      "Only in super-resident learning rounds: hand in the result of this round. Call it once, when the round's work is finished " +
      "(also when nothing worth keeping was found: then with an empty outputs list and the reason in the summary). " +
      "Then end your reply with one short sentence; do not start other work.",
    schema: z.object({
      topic: z.string().min(1).max(200),
      summary: z.string().min(1).max(2000),
      outputs: z.array(z.string().min(1).max(300)).max(30),
    }),
    inputSchema: {
      type: "object",
      properties: {
        topic: { type: "string", description: "What this round was about, a short title in the user's language." },
        summary: { type: "string", description: "What was learned and what was done with it, a few sentences in the user's language." },
        outputs: {
          type: "array",
          items: { type: "string" },
          description: "What the round really left behind, one item each: a saved memory, a skill file's path, a git branch name. Empty if nothing.",
        },
      },
      required: ["topic", "summary", "outputs"],
    },
    permission: "auto",
    parallelSafe: false,
    summarize: (i) => `上报学习结果：${i.topic.slice(0, 30)}`,
    async run({ topic, summary, outputs }) {
      accept({ topic: topic.trim(), summary: summary.trim(), outputs: outputs.map((o) => o.trim()).filter(Boolean) });
      return "Recorded. Finish your reply with one short sentence now.";
    },
  }) as ToolSpec;
}
