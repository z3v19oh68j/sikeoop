// The resource library: skills worth installing, picked and described by hand. Each card is
// one GitHub repo; `pick` names the skills in it that fit this app (the rest of a large repo,
// like iOS or Swift skills, is left out unless the user asks for it).
// Stars are a snapshot (main refreshes them from the GitHub API when online).

export type ResourceCategory = "web-motion" | "motion-principles" | "video";

export interface ResourceCard {
  id: string;
  title: string;
  author: string;
  repo: string;
  /** GitHub stars when the list was made. */
  stars: number;
  category: ResourceCategory;
  /** What it does for a beginner, in one or two sentences. */
  summary: string;
  /** Why it's in this list. */
  why: string;
  /** Skill names to install; empty = every skill in the repo. */
  pick: string[];
  /** Skills in the repo that are left out by default, for the card's "也包含" line. */
  more?: number;
  /** Extra setup the skills need beyond the app. */
  needs?: string;
  /** One of the top picks, installed by "一键全装". */
  starter?: boolean;
}

export const RESOURCE_CATEGORIES: Record<ResourceCategory, { title: string; hint: string }> = {
  "web-motion": { title: "网页动效", hint: "让 AI 给页面加上好看、不廉价的动画" },
  "motion-principles": { title: "动效原则", hint: "不绑定任何库的节奏、缓动和编排" },
  video: { title: "动效视频", hint: "用代码做产品演示、宣传视频" },
};

export const RESOURCES: ResourceCard[] = [
  {
    id: "emil",
    title: "Emil Kowalski 动效品味",
    author: "emilkowalski",
    repo: "https://github.com/emilkowalski/skills",
    stars: 44003,
    category: "web-motion",
    summary: "教 AI 判断该不该动、用什么缓动、动多久、怎么退场，并能检查和改进已有的动画。",
    why: "作者做过 Vercel、Linear 的界面，写过 Sonner、Vaul。GitHub 上最火的动效技能。",
    pick: ["animate", "improve-animations", "review-animations", "find-animation-opportunities", "animation-vocabulary", "emil-design-eng"],
    more: 8,
    starter: true,
  },
  {
    id: "gsap",
    title: "GSAP 官方技能",
    author: "greensock",
    repo: "https://github.com/greensock/gsap-skills",
    stars: 16001,
    category: "web-motion",
    summary: "GSAP 官方出品：时间轴、滚动触发（ScrollTrigger）、React 写法和性能优化，让 AI 正确地用 GSAP。",
    why: "做复杂动画、滚动动效的首选库，官方维护，写法不会过时。",
    pick: [],
    starter: true,
  },
  {
    id: "lottie",
    title: "LottieFiles 动效设计原则",
    author: "LottieFiles",
    repo: "https://github.com/lottiefiles/motion-design-skill",
    stars: 1947,
    category: "motion-principles",
    summary: "让 AI 像动效导演一样思考：先定节奏、缓动、编排和情绪，再写代码。CSS、Motion、GSAP 都适用。",
    why: "LottieFiles 官方，把迪士尼动画原则改写成了界面用的规则。",
    pick: [],
    starter: true,
  },
  {
    id: "motion-dev",
    title: "Motion（原 Framer Motion）",
    author: "199-biotechnologies",
    repo: "https://github.com/199-biotechnologies/motion-dev-animations-skill",
    stars: 104,
    category: "web-motion",
    summary: "React 项目里用 Motion 做弹簧动画、滚动动效和手势交互，自带无障碍和性能注意事项。",
    why: "React 项目最常用的动画库，写法比 GSAP 更贴近 React。",
    pick: [],
  },
  {
    id: "ui-animation",
    title: "去 AI 味 · 界面动画",
    author: "mblode",
    repo: "https://github.com/mblode/agent-skills",
    stars: 142,
    category: "web-motion",
    summary: "专门挑 AI 做界面时的“廉价感”毛病：动画、排版和设计细节。",
    why: "口号是 “Nobody ships AI slop on purpose”，和 Emil 的技能互补。",
    pick: ["ui-animation", "ui-design", "typography-audit"],
    more: 25,
  },
  {
    id: "web-motion-libs",
    title: "网页动效库大全",
    author: "freshtechbro",
    repo: "https://github.com/freshtechbro/claudedesignskills",
    stars: 989,
    category: "web-motion",
    summary: "Motion、anime.js、Lottie、React Spring、滚动显现库等常见动效库的用法，一次装好。",
    why: "覆盖面最广，遇到冷门的动画库也有现成的写法。",
    pick: ["motion-framer", "animejs", "lottie-animations", "react-spring-physics", "scroll-reveal-libraries", "animated-component-libraries"],
    more: 17,
  },
  {
    id: "remotion",
    title: "Remotion 官方技能",
    author: "remotion-dev",
    repo: "https://github.com/remotion-dev/skills",
    stars: 4872,
    category: "video",
    summary: "用 React 写视频：字幕、转场、渲染导出。适合做产品演示和短视频。",
    why: "Remotion 官方维护，用代码做视频最成熟的方案。",
    pick: ["remotion-best-practices", "remotion-create", "remotion-captions", "remotion-render"],
    more: 8,
    needs: "项目里需要装 Remotion（AI 会帮你装）",
  },
  {
    id: "hyperframes",
    title: "HyperFrames 动效视频",
    author: "heygen-com",
    repo: "https://github.com/heygen-com/hyperframes",
    stars: 58179,
    category: "video",
    summary: "HeyGen 出品：写 HTML 就能渲染成视频，带动态图形、产品发布视频、字幕等现成玩法。",
    why: "GitHub 上星最多的动效视频项目，专门为 AI 设计。",
    pick: ["hyperframes", "hyperframes-animation", "motion-graphics", "product-launch-video"],
    more: 36,
    needs: "需要 HyperFrames 的命令行工具（AI 会帮你装）",
  },
  {
    id: "lemo-opuscar",
    title: "Lemo-Opuscar 纯代码短片",
    author: "lemomo-ai",
    repo: "https://github.com/lemomo-ai/lemo-opuscar",
    stars: 1323,
    category: "video",
    summary: "43 种影片风格（油画、水墨、浮世绘、皮影、白板讲解……）。说一句「用水墨风做一支 30 秒的片子，讲……」，AI 自己写剧本、画画面、配乐配音，做出成片。",
    why: "不用视频生成模型，画面、音乐、剪辑全是代码做的；招牌作品是 6 分半的《OPUSCAR 98》。",
    pick: ["lemo-opuscar"],
    needs: "要有 Node 20+、ffmpeg、Python 3.11+；第一次用会下载约 100MB 的风格库到 ~/lemo-opuscar。一支片子要做 30–60 分钟，很费 token，作者按 Claude Opus 5.5 调的风格",
  },
];
