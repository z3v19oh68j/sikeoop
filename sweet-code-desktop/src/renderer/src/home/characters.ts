// One partner per model provider. A partner with an illustration in ./art (named after the
// provider id, e.g. art/qwen.webp) gets a full-art card; the others are 3D chibis built from
// simple shapes in chibi.ts, so they are just data: colors, a hairstyle and one accessory.

export type HairStyle = "long" | "short" | "bob" | "twin" | "fluffy";
export type Accessory = "star" | "headphones" | "whale" | "moon" | "glasses" | "cap" | "llama" | "question" | "none";

export interface CharacterDef {
  providerId: string;
  name: string;
  /** Role in the cast, shown under the name. */
  title: string;
  /** What she says when you pick her card. */
  tagline: string;
  hair: string;
  eye: string;
  /** Ribbon, accessory and UI highlight color. */
  accent: string;
  outfit: string;
  /** Card window gradient, top to bottom. */
  card: [string, string];
  style: HairStyle;
  accessory: Accessory;
  /** URL of a full-art card illustration (2:3 portrait), if one exists in ./art. */
  art?: string;
}

// Every image in ./art becomes the card of the provider it is named after.
const ART = import.meta.glob("./art/*.{webp,png,jpg,jpeg}", { eager: true, query: "?url", import: "default" }) as Record<
  string,
  string
>;
const artFor = (providerId: string) =>
  Object.entries(ART).find(([file]) => file.replace(/^.*\/|\.\w+$/g, "") === providerId)?.[1];

export const CHARACTERS: CharacterDef[] = [
  {
    providerId: "anthropic",
    name: "克劳迪娅",
    title: "文艺 · 温暖 · 细腻",
    tagline: "心事和灵感，我都认真听。",
    hair: "#9a4a2e",
    eye: "#a0602e",
    accent: "#d9773a",
    outfit: "#fdf3ea",
    card: ["#fbeadc", "#efc3a2"],
    style: "long",
    accessory: "star",
  },
  {
    providerId: "openai",
    name: "欧小糖",
    title: "温柔 · 聪明 · 陪伴",
    tagline: "无论你说什么，我都在。",
    hair: "#6b4a3a",
    eye: "#7a5a48",
    accent: "#f0a3b6",
    outfit: "#fff6f3",
    card: ["#fbeee9", "#f1cfd3"],
    style: "short",
    accessory: "headphones",
  },
  {
    providerId: "gemini",
    name: "星语",
    title: "灵动 · 好奇 · 探索",
    tagline: "和你一起，看见更大的世界。",
    hair: "#5b5aa8",
    eye: "#6a5fb0",
    accent: "#6c63d9",
    outfit: "#f4f2fb",
    card: ["#eeebfa", "#c3bbec"],
    style: "long",
    accessory: "star",
  },
  {
    providerId: "deepseek",
    name: "深深",
    title: "深度思考 · 专注 · 可靠",
    tagline: "向更深处，寻找答案。",
    hair: "#4f63b8",
    eye: "#5b6fae",
    accent: "#3b5bdb",
    outfit: "#f4f6ff",
    card: ["#e7edff", "#b7c6f2"],
    style: "bob",
    accessory: "whale",
  },
  {
    providerId: "qwen",
    name: "千问",
    title: "通达 · 雅致 · 好奇",
    tagline: "从一个问题，走向万千可能。",
    hair: "#5a3a78",
    eye: "#6a4a8c",
    accent: "#9b7fd1",
    outfit: "#f6f2fb",
    card: ["#f1ebfa", "#cfbfe8"],
    style: "twin",
    accessory: "none",
  },
  {
    providerId: "moonshot",
    name: "月见",
    title: "夜猫子诗人 · 长文高手",
    tagline: "夜深了也没关系，再长的代码我都读得完。",
    hair: "#2b2d42",
    eye: "#d9a21b",
    accent: "#f2c14e",
    outfit: "#eceef8",
    card: ["#dfe2f5", "#9aa3cf"],
    style: "long",
    accessory: "moon",
  },
  {
    providerId: "zhipu",
    name: "智智",
    title: "知性 · 理性 · 开放",
    tagline: "更开放的智能，更懂你的世界。",
    hair: "#5a4a8c",
    eye: "#4a3f5c",
    accent: "#6d5bd0",
    outfit: "#f2f0f6",
    card: ["#e6e3f2", "#b9b2d8"],
    style: "bob",
    accessory: "glasses",
  },
  {
    providerId: "doubao",
    name: "小豆包",
    title: "元气 · 亲切 · 陪伴",
    tagline: "今天的小事，也想和你分享。",
    hair: "#7a5236",
    eye: "#6b4a34",
    accent: "#7d9ad6",
    outfit: "#f6f8fd",
    card: ["#f3f6fc", "#c9d6f0"],
    style: "bob",
    accessory: "none",
  },
  {
    providerId: "mimo",
    name: "米朵",
    title: "元气 · 包月 · 不心疼",
    tagline: "包月的额度，放心让我多跑几遍！",
    hair: "#3a2a24",
    eye: "#5a3a2c",
    accent: "#ff6900",
    outfit: "#fff6ef",
    card: ["#fff1e6", "#ffc9a3"],
    style: "twin",
    accessory: "headphones",
  },
  {
    providerId: "minimax",
    name: "麦麦",
    title: "灵感 · 活力 · 创造",
    tagline: "把灵感，变成有声有色的世界。",
    hair: "#3a2626",
    eye: "#5a3a34",
    accent: "#e0403a",
    outfit: "#fbf4f2",
    card: ["#fbeeea", "#f0c2bb"],
    style: "long",
    accessory: "headphones",
  },
  {
    providerId: "openrouter",
    name: "路路",
    title: "导游少女 · 带你逛遍所有模型",
    tagline: "想试哪个模型？跟紧我，我来带路～",
    hair: "#ff8a3d",
    eye: "#b45309",
    accent: "#ff5d73",
    outfit: "#fff3e8",
    card: ["#ffe6d1", "#ffbf8f"],
    style: "short",
    accessory: "cap",
  },
  {
    providerId: "ollama",
    name: "羊驼咩",
    title: "本地小羊驼 · 断网也能陪你",
    tagline: "不联网也没关系，我就住在你的电脑里。",
    hair: "#f3e3c3",
    eye: "#6d4c2f",
    accent: "#ff9db5",
    outfit: "#fffaf0",
    card: ["#fbf1dc", "#e9d3a8"],
    style: "fluffy",
    accessory: "llama",
  },
  {
    providerId: "custom",
    name: "神秘嘉宾",
    title: "自定义 · 等你来介绍",
    tagline: "你想让谁来陪你？告诉我接口地址吧。",
    hair: "#8d8a9b",
    eye: "#4a4757",
    accent: "#ff8fc7",
    outfit: "#f3f2f7",
    card: ["#ecebf3", "#c9c6d9"],
    style: "short",
    accessory: "question",
  },
];

for (const c of CHARACTERS) c.art = artFor(c.providerId);

export const characterFor = (providerId: string) => CHARACTERS.find((c) => c.providerId === providerId);
