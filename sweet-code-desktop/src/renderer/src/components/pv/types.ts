import type { PvStep } from "@shared/types";

export type { PvAsset, PvBeats, PvFfmpegState, PvKind, PvPack, PvProject, PvShot, PvStep, PvStoryboard } from "@shared/types";

/** The PV API on window.sweet (kept as a helper so components read the same as before). */
export const pv = () => window.sweet;

export const STEPS: { id: PvStep; label: string }[] = [
  { id: "brief", label: "需求" },
  { id: "script", label: "脚本" },
  { id: "storyboard", label: "分镜" },
  { id: "beats", label: "卡点" },
  { id: "assets", label: "素材" },
  { id: "compose", label: "合成" },
  { id: "render", label: "出片" },
];

/** Small display helpers shared by the assets and beats steps. */
export const fmtBytes = (n: number) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
export const fmtSecs = (n: number) => `${Math.round(n * 100) / 100} 秒`;
