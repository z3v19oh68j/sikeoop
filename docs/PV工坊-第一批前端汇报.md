# PV 工坊 · 第一批前端汇报

## 结果：完成（待验收）

## 改动文件
- `src/renderer/src/components/pv/PvScreen.tsx` — 新页面：左七步进度，中间当前步编辑器 + 经验包，右预览；新建弹窗；ffmpeg 下载说明。
- `src/renderer/src/components/pv/types.ts` — 从 `@shared/types` 转出 Pv* 类型，七步的中文名，`pv()` 取 `window.sweet`。
- `src/renderer/src/styles/pv.css` — 页面样式（沿用深度科研的卡片和输入框）。
- `src/renderer/src/components/Sidebar.tsx` — 「项目」堆里加「PV 工坊」（play 图标），只开发版。
- `src/renderer/src/App.tsx` — 页面类型加 `"pv"`、挂载（只开发版，传入 `root`）、命令面板「PV 工坊」（只开发版）、侧栏入口。
- `src/renderer/src/dev-mock.ts` — 只加了 pv 部分：`createPvMock()`（sikeoop 30 秒宣传片，6 个镜头），在 api 对象开头展开。

## 页面
- **七步**：需求、脚本、分镜、卡点、素材、合成、出片。每步显示状态（未开始 / 进行中 / 完成 / 出错），状态来自 `onPvProgress`；卡点和素材标「第二批」并变灰。有步骤在跑时显示「取消正在跑的步骤」（`pvCancel`）。
- **需求 / 脚本**：Markdown 文本框，`pvReadFile` 读，「保存」走 `pvWriteFile`；右上角「让 AI 写 / 让 AI 重写」走 `pvRunStep`，完成后自动重新读文件。
- **分镜表**：每个镜头可改秒数、景别、运镜、来源、画面、字幕、转场；可以拖动排序（HTML5 拖放），也可以用上移 / 下移按钮；能加、删镜头。顶部实时显示「总时长 / 目标时长」，对上是绿色，对不上是警告色。「保存分镜」走 `pvSaveStoryboard`。
- **合成**：说明文字 +「让 AI 写 Remotion 组件」（`pvRunStep("compose")`），并提示进度可以在调度台看到。
- **出片**：ffmpeg 就绪时显示「出预览片」（`pvRenderPreview`）。没就绪时按钮置灰，旁边有「怎么装？」：点开后说明会从官方镜像下载到本机工具文件夹、会校验 sha256、点同意才开始；点「下载 ffmpeg」后显示下载进度条（`pvFfmpegDownload`）。
- **经验包**：编辑器下方的折叠区，只读。按当前步骤筛选通用包和当前片子类型的包，显示标题、所属包名和正文。
- **预览**：右侧用 `<video src="file://…">` 播放 `pvRenderPreview` 返回的文件，按片子比例显示外框；还没出片时显示「还没出片」。
- **新建弹窗**：片名、类型（产品宣传片 / 音乐 PV）、比例（16:9 / 9:16 / 1:1）、时长（秒，默认 30）。
- 页面顶部有片子下拉框，可以在多个片子之间切换；没打开项目时提示先打开项目。

## 验证
```
> sikeoop@4.1.58 typecheck
> node node_modules/typescript/bin/tsc --noEmit -p tsconfig.node.json && node node_modules/typescript/bin/tsc --noEmit -p tsconfig.web.json

EXIT=0
ℹ tests 311
ℹ pass 311
ℹ fail 0
```
没有启动应用，也没截图。

## 需要指挥官决定的事
1. **类型来源**：开工时 types.ts 里还没有 Pv*，我先在本地写了临时类型。写的过程中后端已经落地了 Pv* 类型和 pv* 方法（含 `onPvProgress`），已全部换成 `@shared/types`，本地类型已删掉。
2. **预览播放器的地址**：现在用 `file://` 绝对路径播放。如果开发服务器是 http 来源，或主进程限制了 file 协议，可能播不出来，需要后端提供一个本地协议地址，或者返回可播放的 URL。
3. **「这一步还在跑」的提示**：第一批只靠 `onPvProgress` 更新状态。`pvRunStep` 返回的调度任务 id 现在没有用到，以后可以加一个「在调度台查看」的跳转。
