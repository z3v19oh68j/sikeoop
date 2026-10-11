import { fromAnthropic, fromOpenAI, reportUsage } from "../usage/ledger";
import { withAutoFailover } from "./model-routing.ts";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import type { ImageInput } from "@shared/types";
import { anthropicClient } from "./index";
import type { ResolvedProvider } from "./store";
import { toStepUsage } from "./openai-responses";

// Images are read by a dedicated vision model (DeepSeek's by default), whatever model the
// conversation runs on. Its written analysis is what the agent sees, so even text-only
// models can work from screenshots, error dialogs and design mockups.

const MAX_TOKENS = 4000;

const SYSTEM = `你是一个帮编程新手看图的助手。你的描述会交给另一个写代码的 AI，它看不到图片，只能靠你的文字。
请按这个顺序写：
1. 一句话说这是什么图（网页截图、报错弹窗、终端、设计稿、照片……）。
2. 图里所有的文字，尤其是代码、报错信息、文件名、按钮文字，逐字照抄，代码放进代码块，不要改写或省略。
3. 界面和布局：有哪些元素、在什么位置、颜色和大小，看起来哪里不对劲。
4. 最后回答用户关于这张图的问题。
看不清的地方直接说看不清，不要猜。用简体中文回答。`;

async function analyzeImagesRequest(
  p: ResolvedProvider,
  images: ImageInput[],
  question: string,
  signal: AbortSignal,
): Promise<string> {
  if (!p.model) throw new Error("还没有设置识图模型。打开设置，在「识图模型」里填一个。");
  if (p.authMode !== "login" && p.preset.needsKey && !p.apiKey) {
    throw new Error(`识图要用 ${p.preset.name} 的 API Key，先在设置里填好。`);
  }
  const ask = question.trim() || "这张图里有什么？";
  {
    if (p.preset.kind === "anthropic") {
      const res = await anthropicClient(p).messages.create(
        {
          model: p.model,
          max_tokens: MAX_TOKENS,
          system: SYSTEM,
          messages: [
            {
              role: "user",
              content: [
                ...images.map((i) => ({
                  type: "image" as const,
                  source: { type: "base64" as const, media_type: i.mime as "image/png", data: i.data },
                })),
                { type: "text" as const, text: ask },
              ],
            },
          ],
        },
        { signal },
      );
      reportUsage({ providerId: p.preset.id, providerName: p.preset.name, model: p.model }, fromAnthropic(res.usage));
      return res.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n").trim();
    }
    const client = new OpenAI({ apiKey: p.apiKey || "not-needed", baseURL: p.baseURL });
    if (p.openaiApi === "responses") {
      const res = await client.responses.create(
        {
          model: p.model,
          max_output_tokens: MAX_TOKENS,
          instructions: SYSTEM,
          store: false,
          input: [
            {
              role: "user",
              content: [
                ...images.map((i) => ({ type: "input_image" as const, detail: "auto" as const, image_url: `data:${i.mime};base64,${i.data}` })),
                { type: "input_text" as const, text: ask },
              ],
            },
          ],
        },
        { signal },
      );
      reportUsage({ providerId: p.preset.id, providerName: p.preset.name, model: p.model }, toStepUsage(res.usage));
      const text = res.output_text.trim();
      if (!text) throw new Error("识图模型没有返回内容");
      return text;
    }
    const res = await client.chat.completions.create(
      {
        model: p.model,
        max_tokens: MAX_TOKENS,
        messages: [
          { role: "system", content: SYSTEM },
          {
            role: "user",
            content: [
              ...images.map((i) => ({ type: "image_url" as const, image_url: { url: `data:${i.mime};base64,${i.data}` } })),
              { type: "text" as const, text: ask },
            ],
          },
        ],
      },
      { signal },
    );
    reportUsage({ providerId: p.preset.id, providerName: p.preset.name, model: p.model }, fromOpenAI(res.usage as unknown as Record<string, unknown>));
    const text = res.choices[0]?.message?.content?.trim();
    if (!text) throw new Error("识图模型没有返回内容");
    return text;
  }
}

export async function analyzeImages(p: ResolvedProvider, images: ImageInput[], question: string, signal: AbortSignal): Promise<string> {
  try {
    return await withAutoFailover(p, "chat", signal, resolved => analyzeImagesRequest(resolved, images, question, signal));
  } catch (err) { throw new Error(describe(err, p)); }
}

function describe(err: unknown, p: ResolvedProvider): string {
  const who = `${p.preset.name} 的识图模型「${p.model}」`;
  if (err instanceof OpenAI.AuthenticationError || err instanceof Anthropic.AuthenticationError) return `${p.preset.name} 的 API Key 不对，识图失败。`;
  if (err instanceof OpenAI.NotFoundError || err instanceof Anthropic.NotFoundError) return `找不到${who}，在设置里换一个识图模型试试。`;
  if (err instanceof OpenAI.BadRequestError || err instanceof Anthropic.BadRequestError) {
    return `${who}没接受这张图（${(err as Error).message}）。可能这个模型不支持看图，或者图片格式不支持。`;
  }
  if (err instanceof OpenAI.RateLimitError || err instanceof Anthropic.RateLimitError) return `${p.preset.name} 说请求太频繁或余额不足，识图失败。`;
  if (err instanceof OpenAI.APIConnectionError || err instanceof Anthropic.APIConnectionError) return `连不上 ${p.preset.name}，识图失败。检查一下网络。`;
  if (err instanceof OpenAI.APIUserAbortError || err instanceof Anthropic.APIUserAbortError) return "识图被取消了";
  return err instanceof Error ? err.message : String(err);
}
