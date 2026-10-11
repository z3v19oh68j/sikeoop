# 方案：PV 工坊

日期：2026-10-11　状态：方案稿，等用户确认后拆任务
范围：动画 / 音乐 PV 和产品宣传片两类，共用一条流程。画面用代码合成（Remotion + ffmpeg），镜头可选调 AI 视频 / 图片模型。只在开发版显示（`SHOW_UNFINISHED`）。

---

## 1. 一条工作流，七步

每一步的产物都存成项目里的文件（`pv/<片名>/`），可以手改后从任意一步接着往下走。每一步是调度核心的一个任务，整片一棵任务树，可取消。

| 步 | 做什么 | 产物 | 谁来做 |
|---|---|---|---|
| 1 立项 | 问最多 4 个问题：类型、时长、比例（16:9 / 9:16）、风格、有没有现成音乐 | `brief.md` | 模型 |
| 2 剧本 | 写分段剧本 / 歌词段落 / 产品卖点顺序 | `script.md` | 模型 |
| 3 分镜 | 拆成镜头：时长、景别、运镜、画面描述、字幕、转场 | `storyboard.json`（结构化，界面里画成分镜表） | 模型 |
| 4 卡点 | 读音乐，找节拍和段落，把镜头切点吸到节拍上 | `beats.json` | 本地分析（ffmpeg 解码 + 纯 JS 起音检测） |
| 5 素材 | 每个镜头选来源：代码动画 / 现成图片视频 / 录屏 / AI 生成 | `assets/`、`shots.json` | 用户 + 模型；AI 生成走审批 |
| 6 合成 | 生成 Remotion 工程，按分镜和卡点排时间线；字幕、标题动效、转场 | `remotion/` 工程 | 编程代理（Claude Code / Codex / 内置） |
| 7 出片 | 本地渲染预览 → 定稿出 mp4，附封面、字幕文件 | `out/*.mp4`、`*.srt` | ffmpeg / Remotion CLI |

界面：新页签「PV 工坊」，左边七步进度条，中间当前步的编辑器（分镜表可拖动排序、改时长），右边预览播放器。

## 2. 经验包

经验包是一组随应用内置的知识文件（Markdown + JSON），流程每一步会把相关条目塞进提示词。用户可以复制一份改成自己的。

**通用包**
- 镜头语言速查：景别、运镜、转场各自适合什么情绪
- 节奏规则：每分钟镜头数参考、副歌加快、静默留白
- 字幕规范：每行字数、停留时长、安全区
- 出片规格：各平台（B 站、抖音、YouTube）的分辨率、码率、时长上限

**动画 / 音乐 PV 包**
- 结构模板：前奏建氛围 → 主歌叙事 → 副歌高潮快切 → 尾奏回扣
- 常用手法：歌词动效（逐字、打字机、抖动）、色彩分段、闪白卡点、标题定格
- 风格预设：赛璐璐、像素、EVA 式大字排版、清新日系（只写风格描述，不放他人作品）

**产品宣传片包**
- 结构模板：痛点 → 演示 → 卖点三连 → 行动号召
- 录屏规范：放大关键区域、鼠标高亮、去掉隐私信息
- 文案公式：一句话卖点、数字化表达

## 3. 技能（Agent Skills 格式）

内置在 `resources/skills/`，首次启动装进 `<userData>/skills/`，沿用现有技能系统（`src/main/plugins/skills.ts`），用户在插件中心能看、能关。

| 技能 | 用途 |
|---|---|
| `pv-storyboard` | 剧本 → 分镜 JSON 的格式要求和自检清单 |
| `remotion-pv` | 怎么按 `storyboard.json` + `beats.json` 写 Remotion 组件；常用动效写法 |
| `ffmpeg-recipes` | 常用命令：裁剪、拼接、加字幕、转码、抽帧、音频响度标准化 |
| `ai-shot-prompt` | 把分镜画面描述改写成各家视频模型的提示词 |

这样第 6 步交给 Claude Code / Codex 时，它们也能读到同一套技能。

## 4. AI 视频 / 图片模型

- 先接两三家有公开 API 的（候选：可灵、即梦、Runway），用户自填 Key，和现有服务商设置放一起。
- 每次生成都弹审批卡，写清预计费用和张数；失败自动重试一次。
- 生成的镜头存进 `assets/`，记录模型、提示词、种子，方便重来。
- 第一批只做“文字 / 图片 → 视频片段”，不做对口型、换脸。

## 5. 依赖与许可

| 依赖 | 处理 |
|---|---|
| ffmpeg | **按需下载**（同 Quarto），首次出片时问一次；选 LGPL 版本，不打包 |
| Remotion | **不打包**，装在用户的 PV 项目里（`npm i remotion`）。它对个人和 3 人以下公司免费，更大的公司要买授权——界面首次使用时说明一句 |
| 节拍检测 | 自己写（纯 JS），不引第三方库 |
| 经验包、技能 | 全部自己写，不搬别人的教程原文 |

## 6. 分批

- **第一批**：工作流骨架 + 第 1–3 步 + 第 6–7 步（纯代码动画、无音乐也能出片）+ 通用包 + `pv-storyboard` / `remotion-pv` / `ffmpeg-recipes` + ffmpeg 按需下载。
- **第二批**：第 4 步卡点、音乐 PV 包、产品宣传片包、录屏素材。
- **第三批**：AI 视频 / 图片模型接入 + `ai-shot-prompt`。

## 7. 派活建议

- 后端（流程任务、文件存取、ffmpeg 下载与调用、技能内置、节拍检测）→ Codex 军团
- 界面（PV 工坊页签、分镜表、预览播放器）→ ui-engineer
- 经验包和技能文本 → 空闲的终端 Claude Code

## 8. 要你决定

1. 第一批先做哪类：动画 PV 还是产品宣传片的示例？（我建议产品宣传片：拿 sikeoop 自己做示例，素材现成）
2. AI 视频模型先接哪家？
3. 经验包要不要开放“导入别人的经验包”（要走技能审核）？

## 9. 外部技能（调研 2026-10-11）

不打包，在插件中心做成“推荐安装”，用户点了再走现有的 GitHub 安装 + 技能审核。我们内置的四个技能自己写，不抄这些仓库的原文。星数来自第三方统计，可能有延迟。

### 9.1 Remotion 代码动画（PV 合成主力）

| 链接 | 内容 | 热度 / 许可 | 建议 |
|---|---|---|---|
| [remotion-dev/skills](https://github.com/remotion-dev/skills) | 官方 12 个技能：建工程、渲染、字幕、Studio 预览、查文档 | 约 5k 星 / 未见 | **首推** |
| [myceldigital/remotion-claude-skill](https://github.com/myceldigital/remotion-claude-skill) | 弹簧参数、动画十二法则、音频驱动 | — / 待核 | 思路参考 |
| [haidrrrry/claude-remotion-skill](https://github.com/haidrrrry/claude-remotion-skill) | 渲染 → 检查 → 修改 → 重渲染循环；B-roll、字幕、音效 | — / 待核 | 可推荐 |
| [composio opencode-skills · remotion-animation-rules](https://github.com/composio-community/opencode-skills/blob/master/skills/remotion-animation-rules/SKILL.md) | `useCurrentFrame()`、弹簧动效规则 | — / 待核 | 思路参考 |
| [affaan-m/ECC · remotion-video-creation](https://github.com/affaan-m/everything-claude-code/blob/main/skills/remotion-video-creation/SKILL.md) | Lottie 嵌入、文字动画、插值曲线 | — / 待核 | 思路参考 |
| [inematds/remotion-skills](https://github.com/inematds/remotion-skills) | 28 篇最佳实践 + 宣传片生成器（葡萄牙语） | — / 待核 | 宣传片参考 |

### 9.2 动效设计 / 短动效（片头片尾、转场）

| 链接 | 内容 | 热度 / 许可 | 建议 |
|---|---|---|---|
| [heygen-com/hyperframes · motion-graphics](https://claudemarketplaces.com/skills/heygen-com/hyperframes/motion-graphics) | 10 秒内设计感短动效 | 仓库约 3.5 万星 / 待核 | 推荐 |
| [iart-ai/motion-skills](https://github.com/iart-ai/motion-skills) | 约 50 个动效 / 视频技能 | 约 260 星 / MIT | 推荐 |
| [lottiefiles/motion-design-skill](https://claudemarketplaces.com/skills/lottiefiles/motion-design-skill/motion-design) | Lottie 动效设计 | 170 星 / 待核 | 可推荐 |
| [dylantarre/animation-principles](https://claudemarketplaces.com/skills/dylantarre/animation-principles/video-motion-graphics) | 动画原理通用参考 | — / 待核 | 经验包参考 |

### 9.3 讲解类动画

| 链接 | 内容 | 热度 / 许可 | 建议 |
|---|---|---|---|
| [rohitg00/manim-video-generator](https://skillselion.com/skills/rohitg00/manim-video-generator) | Manim 数学讲解动画 | 约 1.2k 星 / 待核 | 可选 |

### 9.4 教程与索引

- [Remotion + Claude Code 分步教程（gist）](https://gist.github.com/BillDhawal/7678fe5a240b1304902eca87f63d5149)
- [open-design · remotion 技能页](https://open-design.ai/skills/remotion/)
- [awesome.ecosyste.ms · motion-skills](https://awesome.ecosyste.ms/projects/github.com%2Fiart-ai%2Fmotion-skills)
- [claudemarketplaces 技能目录](https://claudemarketplaces.com/)
