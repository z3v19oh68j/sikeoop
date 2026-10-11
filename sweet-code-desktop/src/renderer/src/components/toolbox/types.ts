import type { AiSiteCategory } from "@shared/types";

export type { AiSite, AiSiteCategory, AiToolboxPrefs } from "@shared/types";

/** The toolbox API on window.sweet. */
export const toolbox = () => window.sweet;

export const CATEGORIES: { id: AiSiteCategory; label: string; hint: string }[] = [
  { id: "cn-search", label: "国内 AI 搜索", hint: "直接能用，搜中文资料快" },
  { id: "cn-assistant", label: "国内 AI 助手", hint: "聊天、写作、读文件" },
  { id: "global", label: "海外", hint: "部分需要能访问海外网站" },
  { id: "academic", label: "学术", hint: "论文、文献" },
  { id: "dev", label: "编程", hint: "查代码、查文档" },
  { id: "custom", label: "我加的", hint: "你自己添加的站点" },
];
