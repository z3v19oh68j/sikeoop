## 结果：完成
「卡点」「素材」两步已去掉灰态并可用，已改用 @shared/types 正式类型（无临时类型）。没启动应用看过实际效果。

## 改动文件（相对 sweet-code-desktop/）
- src/renderer/src/components/pv/PvScreen.tsx：去掉“第二批”灰态；顶部按钮对卡点显示“分析节拍”（没配乐时禁用）、素材显示“检查素材”（pvRunStep "assets"）；Workbench 统一加载素材列表；分镜里来源是文件/录屏的镜头多一个“用哪个素材”下拉。
- src/renderer/src/components/pv/AssetsStep.tsx（新）：素材列表（缩略图/类型/大小/时长，地址走 pvAssetUrl）、导入、删除、设为/取消配乐。
- src/renderer/src/components/pv/BeatsStep.tsx（新）：无配乐提示去素材步；试听；BPM/起拍偏移/可信度；手改 BPM、起拍、每小节拍数（pvSetBeatGrid）；吸附到小节/拍先预览每镜头前后时长和总时长变化，确认后才 pvSaveStoryboard；界面写明“节拍是估算的，定稿前请自己听一遍切点”。
- src/renderer/src/components/pv/types.ts：去掉 later 标记，导出 PvAsset、PvBeats，加 fmtBytes/fmtSecs。
- src/renderer/src/styles/pv.css：末尾追加素材/卡点样式，沿用现有变量。
- src/renderer/src/dev-mock.ts：createPvMock 补全 8 个新方法（120 BPM 样例，素材含视频/图片/音频），import 加 PvAsset、PvBeats；pvRunStep "beats" 在有配乐时生成 120 BPM 数据。

## 验证
`npm run typecheck`（sweet-code-desktop/）退出码 0，输出末尾：
> sikeoop@4.1.68 typecheck
> node node_modules/typescript/bin/tsc --noEmit -p tsconfig.node.json && node node_modules/typescript/bin/tsc --noEmit -p tsconfig.web.json
未启动应用，未做界面实测，未跑 node --test。

## 遗留问题 / 需要指挥官决定的事
- shared/types.ts 里 `PvProject` 被声明了两次（2829 行和 2830 行 `interface PvProject { music?: string }`），靠接口合并能过编译，建议后端合并成一处。
- 接口签名与任务书第 1 节一致，没有出入。
- 缩略图地址在 AssetsStep 渲染期间触发加载（异步 setState），能用但不够规整；后端 pvAssetUrl 若失败则缩略图留空。可以后续改成 useEffect。
- 假定 pvRunStep "beats" 通过 onPvProgress 报完成，完成后卡点页按 steps.beats 变化重读 pvBeats；若后端同步返回但不发进度事件，页面不会自动刷新，需要切换步骤。
- 配乐被设置后 mock 会清掉旧节拍；真后端是否清 beats.json 请后端确认。

---

# 复核与打磨（Claude-2，2026-10-12）

## 结果：完成
对照任务书第 3 节复核了素材步和卡点步，五项要求都已改完。没启动应用，界面效果没有实际看过。

## 改动文件（相对 sweet-code-desktop/）
- src/renderer/src/components/pv/AssetsStep.tsx — 缩略图地址改到 useEffect 里取；`pvAssetUrl` 失败或图片 / 视频本身加载失败时显示「图片 / 视频 · 没预览」占位；补了读取中、列表读不出来（带「再读一次」）、没选配乐、配乐文件找不到这几种提示；导入、删除、设配乐失败各有一句说明。
- src/renderer/src/components/pv/BeatsStep.tsx — 补了这些状态：配乐文件不在素材里、试听加载不了、ffmpeg 没装好（可跳到出片步）、分析中、分析失败（带后端给的原因）、存着的节拍属于另一首歌。吸附预览拆成 `SnapPreview`：按镜头 id 对照前后时长；总时长和目标对不上、比配乐还长、没有分镜、本来就对齐，各有一句提示；没有变化时「确认并保存分镜」禁用。手改节拍后输入框跟着后端返回值更新，填的数不合规时说明范围。
- src/renderer/src/components/pv/PackPanel.tsx（新）— 经验包按包分组、可折叠。有当前步骤条目的包默认展开，包里其他步骤的条目收在「其他步骤的 N 条」里；没有当前步骤条目的包默认折叠。片子类型自己的包排在通用包前面，音乐 PV 能看到 music 包；读不到本类型的包时有一句提示。
- src/renderer/src/components/pv/PvScreen.tsx — 用 `PackPanel` 换掉原来平铺的列表；记下进度事件里的出错原因并显示在对应步骤上（原来被丢掉了）；素材列表区分「还在读」和「读失败」；切换步骤时清掉上一步的报错；`run()` 改成先标「进行中」再调用，调用失败再还原。
- src/renderer/src/styles/pv.css — 加了经验包分组和缩略图占位的样式；删掉已经没人用的 `.pv-step.later`、`.pv-later`。
- src/renderer/src/dev-mock.ts（只动 `createPvMock`）— 多一个音乐 PV 样例片子（已设 120 BPM 配乐）、「实战经验」和「音乐 PV」两个样例包；「检查素材」会按分镜真的检查，缺素材时报错并带镜头 id；进度事件可以带 `message`。

## 验证
`npm run typecheck`（sweet-code-desktop/）退出码 0，node 和 web 两半都没有报错，输出末尾：
> sikeoop@4.1.68 typecheck
> node node_modules/typescript/bin/tsc --noEmit -p tsconfig.node.json && node node_modules/typescript/bin/tsc --noEmit -p tsconfig.web.json

没启动应用、没做界面实测、没跑 `node --test`。

## 遗留问题 / 需要指挥官决定的事
- **music 包后端还没加载**：`src/main/pv/packs.ts:7` 的 `loadPacks` 目前只读 `common`、`promo`。后端补上 `music` 之前，音乐 PV 在真应用里只会看到通用包和「还没读到音乐 PV 专用的经验包」的提示。
- **经验包实际是 25 条**（common 16、promo 5、music 4），不是 20 条；界面按实际数量显示，不受影响。
- **出错原因只在本次运行里有**：原因来自 `onPvProgress` 的 `message`，没有存进 `project.json`。重开页面后步骤还是「出错」，但只能显示通用提示。要不要让后端把最后一次错误存下来，请指挥官定。
- **换配乐后旧节拍**：界面按 `beats.file` 和当前配乐是否一致来判断，不一致就提示重新分析，不依赖后端清不清 `beats.json`。
- **分析失败后不能手填节拍**：手改表单只在已有节拍数据时出现，因为不确定 `pvSetBeatGrid` 在没有 `beats.json` 时能不能用，请后端确认。
- **删除素材没有二次确认**，也不会提示哪些镜头正在用它（靠「检查素材」发现）。任务书没要求，没加。
- 前一份汇报里提到的 `PvProject` 在 `shared/types.ts` 声明了两次（2829、2830 行），现在仍是这样，没动。

---

# 出片页 ffmpeg 提示修正（Claude-2，2026-10-12）

## 结果：完成
没启动应用，界面效果没有实际看过。

## 改动文件（相对 sweet-code-desktop/）
- src/renderer/src/components/pv/PvScreen.tsx — ffmpeg 状态是 `missing` 且带 `hint` 时，直接显示 hint 的内容（有 `error` 也一并显示），不再出现下载说明和「下载 ffmpeg」按钮，改给「我装好了，重新检查」按钮（再调一次 `pvFfmpeg`，还是没找到时有一句说明）。没有 hint 时仍走原来的下载流程。取预览相对路径改成先把反斜线换成斜线，再按最后一个 `/out/` 截取；路径里没有 `/out/` 时报「预览输出路径无效」。
- src/renderer/src/styles/pv.css — 加了 hint 文本的样式（等宽、可选中复制）。

## 验证
`npm run typecheck`（sweet-code-desktop/）退出码 0，node 和 web 两半都没有报错，输出末尾：
> sikeoop@4.1.68 typecheck
> node node_modules/typescript/bin/tsc --noEmit -p tsconfig.node.json && node node_modules/typescript/bin/tsc --noEmit -p tsconfig.web.json

没启动应用、没做界面实测。

## 遗留问题 / 需要指挥官决定的事
- **dev-mock 没补样例**：这次的文件范围只写了 `components/pv/**` 和 `pv.css`，所以没动 `dev-mock.ts`。mock 里的 `missing` 不带 hint，开发预览里看到的仍是下载流程，新分支在 mock 里看不到。需要的话说一声，我加一个带 hint 的样例。
- 卡点步里「分析节拍要用 ffmpeg，去出片步装一下」的提示没改，跳过去后看到的就是上面这套新提示。
