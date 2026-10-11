import type { PvStep } from "@shared/types";

export type { PvFfmpegState, PvKind, PvPack, PvProject, PvShot, PvStep, PvStoryboard } from "@shared/types";

/** The PV API on window.sweet (kept as a helper so components read the same as before). */
export const pv = () => window.sweet;

export const STEPS: { id: PvStep; label: string; later?: boolean }[] = [
  { id: "brief", label: "需求" },
  { id: "script", label: "脚本" },
  { id: "storyboard", label: "分镜" },
  { id: "beats", label: "卡点", later: true },
  { id: "assets", label: "素材", later: true },
  { id: "compose", label: "合成" },
  { id: "render", label: "出片" },
];
