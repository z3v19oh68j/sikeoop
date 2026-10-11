import type { DisclosureDraft, DisclosureFacts, WritingAction } from "@shared/types";

// The AI-use statement (docs/方案-论文工坊.md §7.3): a paragraph for the methods or acknowledgements
// section saying what generative AI was used for, put together from what this project actually
// did in the workshop and in deep research. No model is involved: the text is assembled here.

const WRITING_ZH: Record<WritingAction, string> = {
  polish_zh: "中文润色", polish_en: "英文润色", proofread: "语法与拼写检查", translate_zh_en: "中译英", translate_en_zh: "英译中",
  shorten: "精简段落", expand: "扩写段落", title_abstract: "草拟标题与摘要",
};
const WRITING_EN: Record<WritingAction, string> = {
  polish_zh: "polishing Chinese text", polish_en: "polishing English text", proofread: "grammar and spelling checks", translate_zh_en: "Chinese-to-English translation",
  translate_en_zh: "English-to-Chinese translation", shorten: "condensing paragraphs", expand: "expanding paragraphs", title_abstract: "drafting the title and abstract",
};
const ORDER = Object.keys(WRITING_ZH) as WritingAction[];

/** The writing buttons that were used, most used first; the same order for both languages. */
function writingUsed(facts: DisclosureFacts): WritingAction[] {
  return ORDER.filter((a) => (facts.writing[a] ?? 0) > 0).sort((a, b) => (facts.writing[b] ?? 0) - (facts.writing[a] ?? 0));
}

export function nothingUsed(f: DisclosureFacts): boolean {
  return !f.translatedPapers && !f.summarizedPapers && !f.evidenceRepositories && !writingUsed(f).length && !f.reviews && !f.ideaRuns && !f.noveltyChecks && !f.researchRuns;
}

const enList = (items: string[]) => (items.length <= 1 ? items.join("") : items.length === 2 ? items.join(" and ") : `${items.slice(0, -1).join(", ")}, and ${items.at(-1)}`);
const times = (n: number) => (n === 1 ? "once" : n === 2 ? "twice" : `${n} times`);
const papers = (n: number) => `${n} paper${n === 1 ? "" : "s"}`;

/** The statement in Chinese and in English. Only what was used is mentioned. */
export function composeDisclosure(facts: DisclosureFacts): DisclosureDraft {
  if (nothingUsed(facts)) {
    return {
      facts,
      zh: "本项目在 sikeoop 的论文工坊和深度科研里还没有使用记录，暂时没有可写的 AI 使用说明。如果在别处用过 AI 工具，请在这里自行说明用途。",
      en: "No use of the paper workshop or deep research has been recorded for this project yet, so there is nothing to disclose from here. If AI tools were used elsewhere, describe that use here.",
    };
  }
  const zh: string[] = [];
  const en: string[] = [];

  const reading = [facts.translatedPapers && ["机器翻译", "machine translation"], facts.summarizedPapers && ["生成结构化摘要", "structured summaries"]].filter(Boolean) as string[][];
  if (reading.length) {
    const n = Math.max(facts.translatedPapers, facts.summarizedPapers);
    zh.push(`文献阅读：对 ${n} 篇文献使用了${reading.map((r) => r[0]).join("和")}，用于快速了解内容，引用前均已核对原文`);
    en.push(`literature reading (${enList(reading.map((r) => r[1]))} of ${papers(n)}, used to get an overview; the original texts were checked before citing)`);
  }
  if (facts.evidenceRepositories) {
    zh.push("证据整理：从文献中抽取论点并标注原文出处，抽取结果经人工逐条审阅");
    en.push("evidence extraction (claims drawn from the literature with their source passages, each reviewed by hand)");
  }
  const writing = writingUsed(facts);
  if (writing.length) {
    zh.push(`写作辅助：${writing.map((a) => WRITING_ZH[a]).join("、")}`);
    en.push(`writing assistance (${enList(writing.map((a) => WRITING_EN[a]))})`);
  }
  if (facts.reviews) {
    zh.push(`模拟审稿：用多个语言模型对稿件做了 ${facts.reviews} 次模拟同行评审，用于发现论证和表述上的问题`);
    en.push(`simulated peer review (the manuscript was reviewed ${times(facts.reviews)} by several language models to find weaknesses in argument and presentation)`);
  }
  if (facts.ideaRuns || facts.noveltyChecks) {
    zh.push(`选题：${facts.ideaRuns ? "由模型提出候选研究点子" : ""}${facts.ideaRuns && facts.noveltyChecks ? "，并" : ""}${facts.noveltyChecks ? "借助文献库检索初步核对其新颖性" : ""}`);
    en.push(`topic exploration (${enList([facts.ideaRuns ? "candidate ideas proposed by a model" : "", facts.noveltyChecks ? "a preliminary novelty check against a literature index" : ""].filter(Boolean))})`);
  }
  if (facts.researchRuns) {
    zh.push(`多模型对抗研判：就研究问题让多个模型相互质询 ${facts.researchRuns} 次，用于梳理共识与争议`);
    en.push(`multi-model adversarial analysis (several models cross-examined each other ${times(facts.researchRuns)} to map points of agreement and dispute)`);
  }

  const models = facts.models.slice(0, 12);
  return {
    facts,
    zh: `本文在研究与撰写过程中使用了生成式人工智能工具作为辅助，具体用途如下：${zh.map((s, i) => `（${i + 1}）${s}`).join("；")}。${models.length ? `记录到的模型包括 ${models.join("、")}。` : ""}所有由 AI 生成的内容均经作者核对、修改后采用；研究设计、数据、分析与结论由作者完成并负责。AI 工具不具备作者资格，未列为作者。`,
    en: `Generative AI tools were used as aids in this work, for the following purposes: ${en.map((s, i) => `(${i + 1}) ${s}`).join("; ")}. ${models.length ? `The models on record include ${enList(models)}. ` : ""}All AI-generated content was checked and revised by the authors before use; the study design, data, analysis and conclusions are the authors' own work and responsibility. AI tools do not qualify for authorship and are not listed as authors.`,
  };
}
