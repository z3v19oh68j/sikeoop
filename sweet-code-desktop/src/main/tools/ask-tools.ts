import { z } from "zod";
import type { AskQuestion } from "@shared/types";
import { defineTool, type ToolSpec } from "./registry";

// ask_user: before a new project or a new feature, the agent asks the few questions only the
// user can answer (what it's for, which of two reasonable technologies) as a card of clickable
// options, with its recommendation marked, and waits. "都按推荐来" answers everything with the
// recommendations, for the user who doesn't want to choose.

const optionSchema = z.object({
  label: z.string().min(1).max(60),
  description: z.string().max(300).optional(),
  recommended: z.boolean().optional(),
});

const questionSchema = z.object({
  question: z.string().min(1).max(300),
  header: z.string().max(12).optional(),
  options: z.array(optionSchema).min(2).max(5),
  multi: z.boolean().optional(),
});

export const ASK_TOOLS: ToolSpec[] = [
  defineTool({
    name: "ask_user",
    description:
      "Ask the user 1-4 multiple-choice questions and wait for the answers. Use it before starting a new project or a substantial new " +
      "feature, for the decisions only the user can make: what it is for and for whom, must-have features, platform, and technology " +
      "choices where there are reasonable alternatives (after you have researched them). Each question has 2-5 options; mark the one " +
      "you recommend with recommended: true and put it first, and use `description` to explain each option's trade-off in plain words " +
      "for a beginner. The user can also type their own answer, or pick 'use the recommendations' for everything. " +
      "Don't ask what the request or the project already answers, don't ask about small fixes, and ask once per task, not one question at a time.",
    schema: z.object({
      intro: z.string().max(400).optional(),
      questions: z.array(questionSchema).min(1).max(4),
    }),
    inputSchema: {
      type: "object",
      properties: {
        intro: { type: "string", description: "One or two sentences shown above the questions: what you're about to build and why you ask." },
        questions: {
          type: "array",
          description: "1-4 questions.",
          items: {
            type: "object",
            properties: {
              question: { type: "string", description: "The full question, ending with a question mark." },
              header: { type: "string", description: "A 2-6 character label, e.g. 用途 / 框架 / 数据存储." },
              options: {
                type: "array",
                description: "2-5 options, the recommended one first.",
                items: {
                  type: "object",
                  properties: {
                    label: { type: "string", description: "Short option name, e.g. 'React + Vite'." },
                    description: { type: "string", description: "What choosing it means, the trade-off, in plain words." },
                    recommended: { type: "boolean" },
                  },
                  required: ["label"],
                },
              },
              multi: { type: "boolean", description: "Allow several choices (e.g. which features to include)." },
            },
            required: ["question", "options"],
          },
        },
      },
      required: ["questions"],
    },
    permission: "auto",
    parallelSafe: false,
    summarize: (i) => `问你 ${i.questions.length} 个问题`,
    async run({ intro, questions }, ctx) {
      const qs: AskQuestion[] = questions.map((q, i) => {
        // At most one recommendation, and it goes first.
        let seen = false;
        const options = q.options.map((o) => {
          const recommended = !!o.recommended && !seen;
          if (recommended) seen = true;
          return { label: o.label, ...(o.description ? { description: o.description } : {}), ...(recommended ? { recommended } : {}) };
        });
        options.sort((a, b) => Number(!!b.recommended) - Number(!!a.recommended));
        return { id: `q${i + 1}`, question: q.question, ...(q.header ? { header: q.header } : {}), options, ...(q.multi ? { multi: true } : {}) };
      });
      const { answers, usedDefaults } = await ctx.askUser(intro, qs);
      const lines = qs.map((q) => {
        const a = answers.find((x) => x.id === q.id);
        const picked = a?.choices.length ? a.choices.join("、") : "";
        const other = a?.other?.trim();
        const rec = q.options.find((o) => o.recommended)?.label;
        const answer = [picked, other ? `自己写的：${other}` : ""].filter(Boolean).join("；") || (rec ? `（没选，按你推荐的：${rec}）` : "（没回答）");
        return `- ${q.question} → ${answer}`;
      });
      return [
        usedDefaults ? "The user chose 'use the recommendations' for all questions:" : "The user's answers:",
        ...lines,
        "",
        "Go ahead on this basis: write a short plan with update_plan, then build it. Don't ask the same things again.",
      ].join("\n");
    },
  }),
];
