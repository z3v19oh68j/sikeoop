# PV 工坊 · 第二批任务书

指挥官：Claude-1　日期：2026-10-12　路径相对 `sweet-code-desktop/`
必读：`../.claude/LEGION.md`、`../docs/方案-PV工坊.md`（第 1、2、5、6 节）、`../docs/PV工坊-第一批任务书.md`、两份第一批汇报、`../docs/PV修复与百宝箱后端汇报.md`

范围（方案第 6 节的第二批）：第 4 步卡点、第 5 步素材（导入现成的图片、视频、录屏文件和音乐）、出片带配乐、音乐 PV 经验包接入。
不做：应用内录屏、AI 视频 / 图片模型、配音合成（TTS）、导入外部经验包。这些留到后面，等用户决定。

## 0. 共同约束

- 只在开发版显示（`SHOW_UNFINISHED`）。
- 不打包 ffmpeg、Remotion；不新增应用依赖；节拍检测自己写（纯 JS），不引第三方库。
- 不改审批、模型路由、调度核心本身、更新、发布。不启动应用、不联网装依赖、不 git 提交。
- 工作区里有别的会话在改别的模块：共享文件（`src/shared/types.ts`、`src/preload/index.ts`、`src/main/index.ts`、`src/renderer/src/dev-mock.ts`、`App.tsx`）只新增自己那几行，不整理、不格式化别人的代码。
- 验收：`npm run typecheck` 退出码 0；`node --test test/pv/` 全过。跑完就停，不做反复测试循环。
- 汇报格式按 LEGION 第六章。

## 1. 接口约定（后端先落 `src/shared/types.ts` 和 preload，只新增；前端按此写 mock）

```ts
export interface PvAsset { file: string; kind: "image" | "video" | "audio"; bytes: number; seconds?: number }
export interface PvBeats { file: string; bpm: number; offset: number; beatsPerBar: number; duration: number; beats: number[]; bars: number[]; confidence: number }
// PvProject 新增可选字段
music?: string; // assets/ 下的音频文件名
```

- `file` 一律是 `assets/` 下的相对文件名，不带 `assets/` 前缀。
- `offset` 是第一拍离音频开头的秒数；`beats`、`bars` 是秒，升序；`confidence` 是 0–1。

SweetApi（IPC 前缀 `pv:`）：
- `pvAssets(root, id)` → `PvAsset[]`
- `pvImportAssets(root, id)` → `PvAsset[]`（主进程弹系统选文件框，复制进 `pv/<id>/assets/`，返回新导入的；渲染层不传任意路径）
- `pvRemoveAsset(root, id, file)` → `void`
- `pvAssetUrl(root, id, file)` → `string`（给缩略图和试听用）
- `pvSetMusic(root, id, file | null)` → `PvProject`
- `pvBeats(root, id)` → `PvBeats | null`
- `pvSetBeatGrid(root, id, { bpm, offset, beatsPerBar })` → `PvBeats`（用户手调后重算 `beats`、`bars` 并保存）
- `pvSnapStoryboard(root, id, unit: "bar" | "beat")` → `PvStoryboard`（只返回吸附后的分镜，不保存；保存仍走 `pvSaveStoryboard`）
- `pvRunStep(root, id, "beats")`：分析 `project.music`，写 `beats.json`
- `pvRunStep(root, id, "assets")`：检查每个来源是 `file` / `screen` 的镜头都填了存在的素材，缺的在错误信息里列出镜头 id

文件布局新增：`pv/<id>/assets/`、`pv/<id>/beats.json`。

## 2. 后端（Codex-1）

归属：`src/main/pv/**`、`test/pv/**`、`src/shared/types.ts` 和 `src/preload/index.ts` 的 PV 新增行、`src/main/index.ts` 里 PV 的接线行。

- 素材：导入只接受常见图片 / 视频 / 音频扩展名，单个文件有大小上限，文件名清洗、重名改名；路径校验沿用 `store.ts` 的 `safePath`（拒绝越界和符号链接）。`pvAssetUrl` 复用 `protocol.ts` 的只读媒体协议，把可读范围从 `out/` 扩到 `assets/`，其余限制不放松。
- 卡点：用就绪的 ffmpeg 把音乐解成单声道低采样率 PCM，纯 JS 做起音检测和自相关，得到 BPM、起拍偏移、可信度；处理“速度翻倍 / 减半”的歧义。`beats`、`bars` 由 `bpm`、`offset`、`beatsPerBar`、`duration` 算出。ffmpeg 没就绪时报清楚的错。
- 吸附：`pvSnapStoryboard` 把每个镜头时长取整到最近的整数个小节（或拍），至少一个单位，并说明总时长变化由前端展示。
- 合成与出片：compose 把分镜引用到的素材和 `project.music` 复制进 `remotion/public/`，模板支持图片、视频镜头和配乐；render 的成片要带音轨。没有音乐时行为和第一批一样。
- 经验包：`packs.ts` 的 `loadPacks` 加上 `music` 目录（已有 `resources/pv-packs/music/structure.json`）；`test/pv/pv.test.ts:39` 的经验包数量相应改掉。经验包正文不要改，那是指挥官写的。
- 单测：节拍检测（用代码生成的已知 BPM 节拍音）、吸附取整、素材路径越界 / 符号链接 / 扩展名拒绝、`assets` 步缺素材时报错、协议读 `assets/`。
- 汇报写到 `docs/PV工坊-第二批后端汇报.md`（如果写不到项目根的 `docs/`，在回复里贴全文）。

## 3. 前端（ui-engineer）

归属：`src/renderer/src/components/pv/**`、`src/renderer/src/styles/pv.css`、`src/renderer/src/dev-mock.ts` 的 pv 部分。

- 七步里的「卡点」「素材」去掉“第二批”灰态，变成可用的步骤。
- 素材步：素材列表（缩略图 / 时长 / 大小），「导入」「删除」，把某个音频「设为配乐」；分镜表里来源是文件 / 录屏的镜头可以从已导入素材里选。
- 卡点步：没有配乐时提示先去素材步设配乐；有配乐时「分析节拍」，显示 BPM、起拍偏移、可信度；BPM 和起拍偏移可以手改（走 `pvSetBeatGrid`）；能试听；「吸附到小节 / 拍」先展示每个镜头吸附前后的时长和总时长变化，用户点确认才保存。
- 界面上写一句：节拍是估算的，定稿前请自己听一遍切点。
- `dev-mock.ts` 补全新增的 `pv*` mock（120 BPM 的样例）。
- 汇报写到 `../docs/PV工坊-第二批前端汇报.md`。

## 4. 指挥官留的口子（本批不做，汇报里可以提意见）

- 另一条合成路线：页面按时间渲染 + Electron 逐帧截图 + ffmpeg（`../sikeoop-PV/4.1.58/` 的 `capture.cjs`、`mix.mjs` 就是这么出的两部成片），不需要用户装 Remotion。要不要做成 compose / render 的第二个引擎，等用户决定。
- 配音（旁白 TTS）和音效时间点。
