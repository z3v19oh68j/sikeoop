# PV 修复与百宝箱后端汇报

## 结果：完成实现与静态/单测验收

按顺序完成 PV 修复，再实现 AI 搜索百宝箱第一批后端。遵循 ../.claude/LEGION.md；保留已有工作区修改。本会话及 PV 子代理未修改 src/renderer，未联网装依赖，未启动应用，未 git 提交。新增方法保持必选，前端并行补 mock；最终完整 typecheck 已通过。

## 改动文件与负责人

### 第一项 PV（main-engineer，主会话集成复核）
- src/main/pv/ffmpeg.ts：系统 ffmpeg 探测，可注入平台/PATH/假文件系统；macOS/Linux 不下载，missing 返回 hint；Windows 保留下载审批、摘要校验和安装逻辑。
- src/main/pv/protocol.ts（新增）：只读媒体协议、路径校验、GET/HEAD、流式响应、Range 206/416。
- src/main/pv/ipc.ts：新增 previewUrl handler，仍校验当前工作区。
- test/pv/pv.test.ts：系统探测、非 Windows 不下载、协议越界/符号链接/Range 测试；原 Windows 下载测试显式注入 win32。

### 第二项百宝箱（主会话）
- src/main/toolbox/service.ts（新增）：清单读取、站点/偏好验证、URL 拼装、剪贴板依赖注入、userData/toolbox.json 原子写入与保存队列。
- src/main/toolbox/ipc.ts（新增）：四个 toolbox IPC。
- test/toolbox/toolbox.test.ts（新增）：编码和多占位符替换、非法协议/凭据/模板拒绝、自定义站点校验、重复 ID、偏好读写/损坏兜底/并发保存、剪贴板、IPC。
- resources/ai-search/sites.json：本次创建仅 perplexity/metaso/bing 的占位清单；创建时不存在才写入，没有覆盖既有清单。三个站点均无 query，待清单会话实测替换。
- package.json：仅追加 ai-search 的 extraResources，from resources/ai-search → to ai-search。

### 共享集成（第一项结束后交接主会话）
- src/main/index.ts：PV privileged 协议注册及 ready 后 handler；toolbox 初始化、IPC 接线、Electron clipboard 注入。
- src/shared/types.ts：只新增 PvFfmpegState.hint?、必选 pvPreviewUrl、AiSiteCategory/AiSite/AiToolboxPrefs 和四个必选 toolbox API。
- src/preload/index.ts：只新增 PV 播放 URL 和四个 toolbox 方法。

### 全量验收所需最小既有后端修复（主会话）
- src/main/papers/host.ts：原 watcher 用例在基线已失败；增加 250ms、unref 的单文件轮询兜底，共享 stamp 避免 native/poll 重复通知，停止时释放轮询。
- src/main/papers/typeset.ts：全量验收暴露 endedAt 在异步输出校验前发布，可能读到 running + endedAt；改为输出校验及终态确定后才标 endedAt，不修改或跳过既有测试。

## 新增接口

```ts
PvFfmpegState.hint?: string;
pvPreviewUrl(root: string, id: string, file: string): Promise<string>;
toolboxSites(): Promise<AiSite[]>;
toolboxPrefs(): Promise<AiToolboxPrefs>;
toolboxSavePrefs(p: AiToolboxPrefs): Promise<void>;
toolboxOpenUrl(siteId: string, q?: string): Promise<{ url: string; copied: boolean }>;
```

IPC：pv:previewUrl、toolbox:sites、toolbox:prefs、toolbox:savePrefs、toolbox:openUrl。
既有 pvRenderPreview(root,id): Promise<string> 签名和绝对路径返回值不变。

## 给前端的用法

### PV

1. pvFfmpeg()/pvFfmpegDownload() 在 macOS/Linux 都只探测 PATH、/opt/homebrew/bin、/usr/local/bin、/usr/bin；检查普通文件与可执行权限。ready 带 path；missing 带 hint（macOS brew install ffmpeg、Linux 发行版包管理器）。不要在这些平台显示自动下载流程。
2. await pvRenderPreview(root,id) 得到原绝对路径。使用该路径中最后一个 `/out/` 之后的相对媒体文件名调用 pvPreviewUrl；Windows 先把反斜线转换为斜线。设置 video.src 为返回值，不再使用 file://。

```ts
const absolute = await api.pvRenderPreview(root, id);
const normalized = absolute.replace(/\\/g, "/");
const marker = normalized.lastIndexOf("/out/");
if (marker < 0) throw new Error("预览输出路径无效");
video.src = await api.pvPreviewUrl(root, id, normalized.slice(marker + 5));
```

file 不含 out/ 前缀；可直接传已知相对文件名。返回 sikeoop-pv://<projectId>/<file>。协议只读当前打开工作区 pv/<id>/out/ 媒体，拒绝绝对路径、..、反斜线、符号链接和非媒体文件。没有项目时拒绝，新请求切换项目时复核 root。支持 GET/HEAD、单段 bytes Range（含后缀），不满足返回 416。显式 CSP 的 media-src/img-src 如有限制，应允许 sikeoop-pv:。

### 百宝箱

```ts
const sites = await api.toolboxSites();
const prefs = await api.toolboxPrefs();
await api.toolboxSavePrefs({ ...prefs, favorites: ["perplexity", "metaso", "bing"] });
const { url, copied } = await api.toolboxOpenUrl(siteId, question);
// 将 url 交给现有 BrowserPane 或对比栏 webview，partition="persist:sikeoop-browser"。
// copied === true 时提示“问题已复制，粘贴即可”。
```

toolboxOpenUrl 只返回经过校验的地址、必要时写剪贴板，不另起窗口，不请求站点、不抓取页面、不代登录、不保存 Key。URL 模板的全部 {q} 均使用 encodeURIComponent 替换；无模板且问题非空时复制问题并返回首页；空问题仅返回首页。模板不允许占位符改变协议或目标域名；URL 只允许无凭据的 http/https。

偏好保存为完整对象（不是 patch），groups/favorites/order/hidden 保留前端意图；custom 分类归一为 custom，ID 不得与内置站点或其他自定义站点重复。损坏/缺失偏好回退空偏好；清单缺失或损坏回退空内置清单，个别非法条目跳过，不调用网络补全。savePrefs 等待原子 rename 完成后返回，队列按调用顺序保存。运行时图标由前端 favicon 处理，本后端不打包商标图片。

## 验证：最终输出末尾

### npm run typecheck（exit 0，node 与 web 均通过）

```text
> sikeoop@4.1.58 typecheck
> node node_modules/typescript/bin/tsc --noEmit -p tsconfig.node.json && node node_modules/typescript/bin/tsc --noEmit -p tsconfig.web.json
```

### npm test（exit 0）

```text
✔ template replaces every placeholder and encodes questions without adding parameters (0.827334ms)
✔ rejects unsafe protocols, credentials, malformed templates and destination placeholders (0.197125ms)
✔ custom sites validate, force custom category, reject duplicate IDs and invalid prefs (0.252583ms)
✔ manifest loading, prefs atomic writes/fallback, clipboard and IPC (10.298375ms)
ℹ tests 328
ℹ suites 0
ℹ pass 328
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 2042.735708
```

Node 原生类型剥离；新增运行时相对 import 带 .ts，无构造函数参数属性。PV 定向测试先通过 13/13；最后全量包含 toolbox 4 项测试，全部通过。
完整最终日志：/tmp/pv-toolbox-typecheck.log、/tmp/pv-toolbox-test.log。基线日志 /tmp/pv-toolbox-baseline-test.log 记录原 watcher 失败。中间曾发现并修复 toolbox 保存队列在异步验证后入队导致乱序，及上述 typeset 终态发布竞态；没有跳过用例。PV 阶段 web mock 曾缺 pvPreviewUrl，最终前端并行接入后已无缺失报错，本会话未改 renderer。

## 存疑点 / 未验证边界

- 未启动 Electron，未实测应用媒体播放/CSP、真实模型/Remotion/ffmpeg 出片、Windows 在线下载；静态和单测通过不等于这些端到端链路已验证。
- 三站点为占位文件，无已实测查询模板；清单由另一个会话负责验证。当前走复制粘贴，不声称站点模板生效。
- PV 路径检查拒绝符号链接并使用 O_NOFOLLOW 打开最终文件；恶意进程并发替换父目录的 TOCTOU 仍未完全消除。已打开的媒体流不会在切换/关闭项目时主动取消；后续请求会拒绝或仅服务新当前工作区。
- 协议有 Access-Control-Allow-Origin: *，仅提供受限 out/ 媒体，不提供源码/HTML；不属于登录页面或其他站点抓取通道。
- 百宝箱偏好写队列仅约束本应用服务实例，不提供跨进程编辑合并。损坏偏好回退但不自动覆写原文件。
- 第二批 AI 汇总未做；favicon、BrowserPane/对比栏和 dev-mock 属前端会话。

已停止，不继续测试循环或做额外功能。
