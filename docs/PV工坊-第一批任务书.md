# PV 工坊 · 第一批任务书

指挥官：Claude 主会话　日期：2026-10-11　路径相对 `sweet-code-desktop/`
必读：`../.claude/LEGION.md`、`../docs/方案-PV工坊.md`（第 1、2、3、5、6 节）

默认决定（用户未另行指定）：示例片用“产品宣传片（拿 sikeoop 自己做）”；AI 视频模型留到第三批；暂不支持导入外部经验包。

## 0. 共同约束

- 只在开发版显示（`SHOW_UNFINISHED`）。
- 不打包 ffmpeg、Remotion；ffmpeg 按需下载（照 `src/main/papers/` 里 Quarto 按需下载的做法），Remotion 只写进用户 PV 项目的 package.json。
- 经验包、技能文本全部自己写，不照搬任何外部仓库原文（方案第 9 节那些仓库只能看思路）。
- 不改审批、模型路由、调度核心本身、更新、发布。不启动应用、不联网装依赖、不 git 提交。
- 测试：`npm run typecheck` 0；`npm test` 全过（现 311）。

## 1. 接口约定（后端先在 `src/shared/types.ts` / preload 只新增，前端按此写 mock）

```ts
export type PvKind = "promo" | "music";
export type PvStep = "brief" | "script" | "storyboard" | "beats" | "assets" | "compose" | "render";
export interface PvShot { id: string; seconds: number; framing: string; camera: string; visual: string; caption?: string; transition?: string; source: "code" | "file" | "screen" | "ai"; asset?: string }
export interface PvProject { id: string; name: string; kind: PvKind; ratio: "16:9" | "9:16" | "1:1"; seconds: number; dir: string; steps: Record<PvStep, "todo" | "running" | "done" | "error">; updatedAt: number }
export interface PvStoryboard { shots: PvShot[] }
export interface PvPack { id: string; name: string; kind: PvKind | "common"; entries: { id: string; title: string; body: string; steps: PvStep[] }[] }
export interface PvFfmpegState { status: "missing" | "downloading" | "ready" | "error"; progress?: number; path?: string; error?: string }
```

SweetApi（IPC 前缀 `pv:`）：
- `pvList(root)` / `pvCreate(root, {name, kind, ratio, seconds})` / `pvGet(root, id)`
- `pvRunStep(root, id, step, note?)` → dispatch jobId（每步一个调度任务，整片一棵树）；`pvCancel(root, id)`
- `pvReadFile(root, id, file)` / `pvWriteFile(root, id, file, text)`（只限 `pv/<id>/` 内）
- `pvStoryboard(root, id)` / `pvSaveStoryboard(root, id, sb)`
- `pvPacks()`（内置经验包列表）
- `pvFfmpeg()` / `pvFfmpegDownload()`（首次下载前前端弹说明，走现有审批）
- `pvRenderPreview(root, id)` → 输出文件路径；事件 `pv:progress {id, step, status, message?}`

文件布局：`pv/<id>/{project.json, brief.md, script.md, storyboard.json, remotion/, out/}`。

## 2. 后端（Codex 军团）

- `src/main/pv/**`：项目存取、七步中的 brief / script / storyboard（模型任务，提示词里注入经验包对应 `steps` 的条目）、compose（生成 Remotion 工程模板 + 交给编程代理按分镜写组件）、render（Remotion CLI / ffmpeg）。beats、assets 第一批只留占位返回“第二批”。
- ffmpeg 按需下载 + 校验 sha256 + 放 `userData/tools/ffmpeg/`。
- 经验包：`resources/pv-packs/common/*.md|json`（通用包：镜头语言、节奏、字幕、平台规格），加 `promo` 包一个最小版。
- 内置技能：`resources/skills/{pv-storyboard,remotion-pv,ffmpeg-recipes}/SKILL.md`，首次启动装进 `userData/skills/`（复用 `src/main/plugins/skills.ts`，已存在就不覆盖），并加进 package.json `extraResources`。
- 单测 `test/pv/**`：分镜 JSON 解析兜底、路径越界拒绝、经验包按步筛选、ffmpeg 下载校验失败处理。
- 汇报 `docs/PV工坊-第一批后端汇报.md`。

## 3. 前端（ui-engineer）

- 新页签「PV 工坊」（只开发版）：左侧七步进度条（第 4、5 步显示“第二批”），中间当前步编辑器（brief / script 用 Markdown 编辑；分镜表：可拖动排序、改时长、改字段，总时长实时显示），右侧预览播放器（播 `out/` 最新文件）。
- 新建弹窗：片名、类型、比例、时长。ffmpeg 未就绪时出片按钮旁给下载说明。
- 经验包侧栏：按当前步列出条目，只读。
- `dev-mock.ts` 补全 `pv*` mock（自编样例：sikeoop 30 秒宣传片，6 个镜头）。
- 汇报 `docs/PV工坊-第一批前端汇报.md`。
