# 方案：PV 工坊 · 截帧引擎（第二个 compose/render 引擎）

日期：2026-10-12　状态：方案稿，等用户拍板才实现　依据：`sikeoop-PV/4.1.58/` 两部成片实证 + `docs/方案-PV工坊.md` + 第二批任务书 §4

## 0. 结论和要你决定的事（先看这里）

- 结论：路线可行。`capture.cjs`（离屏窗口逐帧截图→ffmpeg）+ `mix.mjs`（配乐/旁白/音效混音）的逻辑可以直接搬进主进程，零新增依赖（Electron、ffmpeg 现成），第二批的 `beats.json` / `project.music` 直接复用。
- 要你决定：
  1. 做不做？（第二批任务书 §4 的口子）
  2. 双引擎长期并存，还是跑通一部片后把 Remotion 降为备选、默认切截帧？**我建议后者**：两套 compose/render 分支维护成本高，Remotion 还要求用户装依赖、有授权门槛（3 人以上公司收费），且至今没真正出过片。
  3. 先做 A 批（无声视频链）验证速度再定 B 批？**我建议是**：150 秒×30fps=4500 帧，每帧含截图+PNG 编码+pipe，单机可能 10–30 分钟，接近现有 30 分钟任务超时，实测后再投混音。
  4. 旁白本批只支持“用户导入配音文件”，TTS 合成不在本方案（第二批已明确不做）。

## 1. 工程长什么样（`pv/<id>/` 新增）

- `page/index.html`：页面必须满足三约定——`window.renderAt(t)` 为全局时间 t 的纯函数；`window.PV={total,scenes:[{id,start,dur,vo,title}],cues:[{t,file,gain,len}]}`；`window.boot()` 就绪后置 `window.PV.ready=true`（4.1.58 做法：等字体加载完）。
- `page/assets/`：SVG（id 加前缀防串）、字体（放进工程，不依赖本机）、图片。**零外链**，见 §3。
- `timeline.json`：渲染时由页面导出，混音唯一真相源（画面和声音不各抄一份数字）。
- `vo/<sceneId>.wav`：按场景 id 命名的旁白文件（用户导入，见 §5）。
- 复用：`beats.json`、`project.music`、`assets/`（音效/配乐）、`out/`（成片+srt+封面）。`remotion/` 目录不动。

## 2. 主进程怎么渲染

- 新 `src/main/pv/capture.ts`：`BrowserWindow({show:false,offscreen:true,useContentSize,backgroundThrottling:false})` → `loadFile(page/index.html)` → 注入后 `boot()` → 轮询 `PV.ready`（上限 30s）→ 逐帧 `renderAt(t)` + 钉住 CSS 动画（`getAnimations().forEach(pause+currentTime)`）+ 双 rAF → `capturePage()` → PNG 直接 pipe 进 ffmpeg（`image2pipe`→libx264、crf 18、yuv420p），ffmpeg 用 `ffmpeg.ts` 就绪的那个。
- 调度复用：仍走 `runStep(root,id,"render")` 的 dispatcher 通道（lane `pv:<key>`、active 互斥、30 分钟超时）；取消 = destroy 窗口 + 杀 ffmpeg（`host.ts` 的 `runPvProcess` 已支持 abort）。
- 进度复用 `onPvProgress` 的 `message` 字段发 `frame i/n`（节流每 60 帧），**不新增 IPC**。抽帧（stills）复用同一窗口，给关键帧拼图验收用。

## 3. 安全边界（页面 = 模型写的不可信代码）

- 隔离：专用 `session`（partition 与应用隔离）；`webPreferences: {nodeIntegration:false, contextIsolation:true, sandbox:true}`，无 preload。
- 禁网：`webRequest.onBeforeRequest` 拦截一切 http/https，只放 `file:`/`data:`；字体素材全本地，页面有外链直接判 compose 不合格。
- 文件：只 `loadFile` 工程内 `page/index.html`；`executeJavaScript` 只发固定模板（时间数字 + 取 `window.PV` JSON），**不拼接任何模型文本**；读写全走 `safePath`（禁符号链接、禁越界，沿用 `store.ts`）。
- 上限：ready 轮询 30s、单帧 10s 超时、capture 连续失败 N 次中止、总时长复用 `project.seconds≤3600`；渲染完即 destroy 窗口。
- **挡不住的风险**：Chromium 沙箱 0day（只能跟随 Electron 更新）；大页面 CPU/内存峰值（先做 A 批实测）；页面可探测本机字体（低风险，接受）。

## 4. 接口改动（只新增，老项目行为不变）

- `PvProject` 加 `engine?: "remotion" | "frame"`（缺省 remotion）。
- 新增 `pvSetEngine(root,id,engine)`；compose/render 内按 engine 分支；其余 `pv*` 不变。compose 对 frame 引擎：模型写 `page/index.html`（只做静态约定检查：renderAt/PV/boot 存在，不执行页面）。

## 5. 音频（衔接第二批）

- 配乐：复用 `project.music` + `beats.json`（offset 裁前奏、压到约四成、片尾淡出 4 秒），`mix.mjs` 的 filter_complex 搬进 service。
- 旁白：按 `timeline.scenes[].vo` 做 adelay+apad 混入（90Hz 高通、轻压缩、略提音量）。文件来自用户导入，TTS 以后再说。
- 音效：`timeline.cues[]` + assets 内 sfx，按 t/gain/len 混入；收尾 `loudnorm I=-14:TP=-1.5:LRA=11`、AAC 192k（`field-notes.json` mix 条）。
- 衔接点：`snapStoryboard` 吸到小节的结果就是场景时长来源；`offset`/`bars` 直接用，不重算。

## 6. 文件归属、分批、验收

| 文件 | 负责人 |
|---|---|
| `src/main/pv/capture.ts`（新）、`service.ts`（compose/render 分支+混音）、`test/pv/**`（约定检查、混音构造 mock、越界用例） | 后端 Codex |
| `src/shared/types.ts`（engine+pvSetEngine）、`src/preload/index.ts`（新增行） | 指挥官先落地，后端接 |
| 引擎选择 UI、进度条（复用 message）、`dev-mock.ts` 新增行 | 前端 Claude |
| `page-frame` 技能（怎么写 renderAt 页面，复用 field-notes deterministic/motion-helpers/captions-split/single-timeline 条） | 文案终端 |
| A 批：无声链（capture→silent mp4 + timeline.json + stills）→ B 批：混音（music/vo/sfx+loudnorm）→ C 批：前端切换+技能 | 分批 |

- 验收：A：fixture 页面渲出固定帧数 mp4 + timeline.json（含场景/旁白点/音效点）；B：带音轨 mp4，响度 -14±1 LUFS + 关键帧拼图；C：typecheck + 走通一遍。统一 `npm run typecheck` + `node --test test/pv/`。
- 顺序约束：Codex-1 正在做第二批后端，实现必须等第二批合并后（或 worktree 隔离），由指挥官定。

## 7. 和 Remotion 的取舍 + 我不同意的地方

- Remotion 好在 React 生态/动效库/Studio 预览；差在用户装依赖失败率高、有授权门槛、至今没出过片。
- 截帧好在零新增依赖、两部成片实证、任意 t 可抽帧调试；差在页面靠模型手写（质量波动）、无动效库、长片渲染慢。
- 不同意三点：① 不接受长期双引擎并存，跑通后默认切 frame；② 进度别加新 IPC，message 字符串够用；③ 不同意一次做到混音，先 A 批测速——超时的话先降帧率/分辨率策略，而不是硬上。
