# PV 工坊 · 第二批后端汇报

日期：2026-10-12　负责人：Codex-1　指挥官：Claude-1

## 结果：完成实现与静态 / mock 单测验收

按任务书第 1 节先新增固定接口与 preload，已通过 send_to 通知 Claude-1；随后完成第 4 步节拍分析、第 5 步素材检查、素材导入 / 删除 / 预览、配乐选择、手调网格、分镜吸附、Remotion 媒体模板和带配乐的出片参数，经验包加载器接入 music 目录。

只改归属范围内的主进程、PV 测试及共享文件 PV 新增行；没有修改 renderer、经验包正文、审批 / 模型路由 / 调度核心 / 更新 / 发布。没有新增应用依赖，没有启动应用、联网装依赖或 git 提交。保留其他会话已有改动。

首次完整 typecheck 退出码 0，PV 目录 33/33 通过。后续技能安装追加单验证 36/36 通过；本轮新增重启状态恢复后，最新完整 typecheck 仍为退出码 0，PV 目录 37/37 通过（本批共新增 17 项）。每轮追加单验收各跑一次，完成后停止，没有自发反复测试循环。

汇报已经实际写出：项目根 `docs/PV工坊-第二批后端汇报.md`，并同步到 Git checkout 内 `sweet-code-desktop/docs/PV工坊-第二批后端汇报.md`。先前只写在项目根 docs，仓库内 docs 确实没有；现在两个位置都提供相同内容，避免路径口径不同。

## 改动文件

以下路径相对 `sweet-code-desktop/`，行号对应本次交付：

- `src/shared/types.ts:2829–2831,2838–2845` — 新增 PvProject.music?、PvAsset、PvBeats 和任务书规定的 8 个必选 pv* 方法；按指挥官后续要求将 music? 合入原 PvProject，当前只有一处声明，接口签名不变。
- `src/preload/index.ts:17–24` — 8 个新增 pv* 的 IPC 映射。
- `src/main/index.ts:17,2152–2155` — PV 媒体扩展名导入及主进程系统文件选择框接线。
- `src/main/pv/media.ts:1–23`（新增）— 图片 / 视频 / 音频扩展名、MIME 分类，单文件 512 MB 上限；不接受 HTML / SVG / 源码。
- `src/main/pv/assets.ts:9–103`（新增）— safePath 路径与符号链接检查、素材列举、受限流式复制、文件名清洗 / 重名后缀、整批选择预校验、file/screen 镜头缺素材 ID 汇总。
- `src/main/pv/beats.ts:11–162`（新增）— ffmpeg 单声道 8000 Hz float32 PCM 解码、临时文件清理、纯 JS 正向 log-energy 起音 / 自相关 / 非整数周期拟合、起拍 / confidence、网格重算与吸附。
- `src/main/pv/store.ts` — 新项目创建 assets/；get/list 读回时将没有本进程对应活动任务的 running 步骤恢复为 todo 并原子落盘；并发读取共享恢复操作，返回独立项目对象。
- `src/main/pv/skills.ts:6–12` — 安装名单加入 pv-html-timeline、pv-audio-mix；资源目录或 SKILL.md 尚不存在时仅对 ENOENT 跳过，真实读取错误仍抛出；继续保持已安装目录不覆盖及原 syncBuiltin 行为。没有修改 Claude-6 负责的技能正文。
- `src/main/pv/protocol.ts:5–6,22–26,39–44,54–55` — 保留原 out/ URL；新增 `sikeoop-pv://<id>/assets/<file>` 只读媒体路径，继承 GET / HEAD / Range、当前工作区、符号链接和扩展名限制，没有添加通配 CORS。
- `src/main/pv/service.ts:33–105,121–134,161–181` — 新增素材 / 配乐 / 网格 API，beats/assets 走既有调度器；compose 复制引用素材与配乐到 public/assets/；render 有音乐时显式选择音乐音轨、AAC 编码、apad 补齐及 shortest 截断到视频长度。配乐变更清除旧网格并使 compose/render 回到 todo；渲染时拒绝不匹配的旧合成配乐。
- `src/main/pv/template.ts:1–19` — media.json 清单、Img、静音 OffthreadVideo、Audio 和 staticFile 引用；不改应用依赖，Remotion 仍只在用户工程。
- `src/main/pv/ipc.ts:1,6,14–21` — 8 个新 IPC；导入只能由主进程 picker 取得源路径，忽略 renderer 额外路径参数；对话框返回后再次检查当前工作区。
- `test/pv/pv.test.ts:39–40,68–82` — 经验包数量改为 8，断言 music 包存在；移除第二批步骤必须抛占位错误的旧断言。
- `test/pv/second-batch.test.ts:1–301`（新增）— 13 项回归：已知 60/90/120/123/150/180 BPM 合成节拍及弱细分拍、首拍静默、无效 PCM、吸附取整、导入清洗 / 重名、穿越 / 符号链接 / 扩展名 / 超限、缺素材 ID、节拍保存与手调、解码失败清理、配乐切换清网格、assets 协议、public 素材与模板、配乐 / 无配乐渲染参数及 picker 边界。
- `test/pv/skills-install.test.ts`（新增）— 3 项回归：全部五个技能加入安装包、缺目录 / 缺 SKILL.md 跳过及已安装目录不覆盖、非 ENOENT 读取错误保留。
- `test/pv/second-batch.test.ts:206–219` — 后续增加已有手调用例的明确断言：无配乐报“请先设置配乐”，没有旧网格时 file 取 project.music、confidence 为 0。
- `src/main/pv/service.ts:22–25` 及 runStep/cancel 收尾 — 按项目目录与步骤跟踪本进程活动任务，并注入 PvStore 恢复判定；准备阶段取消、任务结束及异常均清除对应步骤记录。真实在跑的步骤不被恢复逻辑重置。
- `test/pv/second-batch.test.ts` 最后新增用例 — 重启遗留 running 经 get/list 变为 todo、保存到 project.json，done 状态保持；并发首读只恢复写入一次；本进程真实活动步骤保留 running，其他无对应任务的步骤仍恢复 todo。

新增方法严格保持任务书命名：pvAssets / pvImportAssets / pvRemoveAsset / pvAssetUrl / pvSetMusic / pvBeats / pvSetBeatGrid / pvSnapStoryboard。file 不带 assets/ 前缀。吸附仅返回分镜，不落盘；仍由前端确认后调用 pvSaveStoryboard。

## 验证

### 指挥官后续对齐确认

1. `src/shared/types.ts:2829`：已把 music?: string 合入原声明，并删除第二处 PvProject 声明，未改冻结接口的字段或方法签名。
2. `src/main/pv/service.ts:118–119,147–158`：beats/assets 与其他步骤共用 status 调用；执行前发 running，调度完成后发 done/error，均通过现有 deps.emit 接到 pv:progress。首次验收的新单测已覆盖 beats 成功/失败、assets 缺素材失败/补齐成功并接收对应终态事件；此处无需重复修改。
3. `src/main/pv/service.ts:48–49,58–74`：更换或清空配乐时 clearBeats 删除 beats.json、beats 状态设为 todo 并保存项目；pvBeats 对无配乐或 file 不匹配返回 null。首次验收已覆盖更换配乐、清空配乐和删除当前配乐；此处无需重复修改。
4. `src/main/pv/service.ts:76–87`：已有实现满足“自动分析失败后手填”：没有 beats.json 时，仅用 ffmpeg 解码取得配乐真实 duration，不调用起音检测；file 使用 project.music，confidence 为 0。没有配乐时明确报“请先设置配乐”；ffmpeg 未就绪或音乐无法解码时也保留明确错误。本轮补上 file / confidence / 无配乐断言并验证通过。
5. `src/main/pv/skills.ts:6–12`：安装名单已加入 pv-html-timeline / pv-audio-mix，目录或 SKILL.md 当时尚不存在时跳过，不要求 Claude-6 与安装器完成时序完全同步。此轮没有修改两个新技能目录的正文。
6. **重启状态恢复选择 todo**：在 PvStore.get 读取项目时，将 running 且没有本进程对应项目/步骤活动任务的状态改回 todo，更新 updatedAt 并保存；list 复用 get，因此初次打开列表也能恢复按钮。选择 todo 而非 error，无需新增 message 字段或改变冻结接口。任务不自动续跑，用户可重新执行。运行中的真实任务不会被误重置；同项目其他孤立 running 步骤仍可恢复。

### 最新验收：重启状态恢复追加单

在 `sweet-code-desktop/` 下各运行一次 `npm run typecheck` 和 `node --test test/pv/`，两者退出码均为 0，跑完即停。

typecheck 原始输出：

```text
> sikeoop@4.1.68 typecheck
> node node_modules/typescript/bin/tsc --noEmit -p tsconfig.node.json && node node_modules/typescript/bin/tsc --noEmit -p tsconfig.web.json
```

PV 单测原始输出末尾：

```text
✔ 重启遗留 running 读回并落盘 todo，get/list 恢复但不重置本进程真实活动步骤 (12.1365ms)
```

```text
✔ PV 技能安装名单包含 timeline/mix，读取完整 SKILL.md 后交给 syncBuiltin (23.017666ms)
✔ 不存在的资源目录/未写完的 SKILL.md 跳过，已安装目录保持不覆盖 (11.667584ms)
✔ SKILL.md 不是文件时保留错误，不把真实读取失败当作尚未提供资源 (2.512917ms)
ℹ tests 37
ℹ suites 0
ℹ pass 37
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 356.204833
```

最新完整原始日志：`/tmp/pv-second-recovery-typecheck.log`、`/tmp/pv-second-recovery-tests.log`。未启动应用，未执行真实 ffmpeg / Remotion / 模型。

### 历史验收：技能安装追加单（声明已合并、技能安装名单已更新）

在 `sweet-code-desktop/` 下针对追加改动各运行一次 `npm run typecheck` 和 `node --test test/pv/`，两者退出码均为 0，跑完即停。

typecheck 原始输出：

```text
> sikeoop@4.1.68 typecheck
> node node_modules/typescript/bin/tsc --noEmit -p tsconfig.node.json && node node_modules/typescript/bin/tsc --noEmit -p tsconfig.web.json
```

PV 单测原始输出末尾：

```text
✔ PV 技能安装名单包含 timeline/mix，读取完整 SKILL.md 后交给 syncBuiltin (23.087708ms)
✔ 不存在的资源目录/未写完的 SKILL.md 跳过，已安装目录保持不覆盖 (13.089042ms)
✔ SKILL.md 不是文件时保留错误，不把真实读取失败当作尚未提供资源 (4.799667ms)
ℹ tests 36
ℹ suites 0
ℹ pass 36
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 351.151167
```

该轮完整原始日志：`/tmp/pv-second-followup-typecheck.log`、`/tmp/pv-second-followup-tests.log`。未启动应用，未执行真实 ffmpeg / Remotion / 模型。

### 首次验收历史记录

下面保留首次验收原始结果，发生在 PvProject 声明合并及技能安装名单追加之前；最新验证以“重启状态恢复追加单”一节为准。

在 `sweet-code-desktop/` 下各运行一次：

### npm run typecheck（退出码 0，主进程与 web 都通过）

原始输出末尾：

```text
> sikeoop@4.1.68 typecheck
> node node_modules/typescript/bin/tsc --noEmit -p tsconfig.node.json && node node_modules/typescript/bin/tsc --noEmit -p tsconfig.web.json
```

前端并行补齐 mock 后，本次没有 dev-mock 缺方法报错；本会话没有修改 renderer。

### node --test test/pv/（退出码 0）

原始输出末尾：

```text
✔ 无配乐及 ffmpeg 未就绪给明确错误；解码失败清理临时 PCM (11.985166ms)
✔ 没有分析也可解码取得真实时长再手调，切换配乐清除旧网格 (8.823292ms)
✔ 只读协议读取 assets 图片/音频，保留 Range/HEAD、根目录隔离和扩展名限制 (12.771834ms)
✔ compose 复制引用的图/视频/音乐到 public，模板带 Img/OffthreadVideo/Audio (16.018292ms)
✔ render 有音乐显式 AAC 混音、补齐短音乐；无音乐保留第一批转码参数 (28.317458ms)
✔ 新增 IPC 从主进程 picker 导入，不接受 renderer 任意源路径；工作区切换后拒绝 (5.996125ms)
ℹ tests 33
ℹ suites 0
ℹ pass 33
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 308.533458
```

Node 仅有既有 MODULE_TYPELESS_PACKAGE_JSON 警告；没有为消除警告修改 package.json。完整原始日志：`/tmp/pv-second-typecheck.log`、`/tmp/pv-second-tests.log`。

## 遗留问题 / 需要指挥官决定的事

1. **运行时验证边界**：没有启动 Electron、真实模型、Remotion CLI 或真实 ffmpeg。解码 / 合成 / 转码使用可注入 mock，媒体协议用实际临时文件测试；通过这些测试不等于实测成片已有可播放音轨或应用内试听成功。
2. **节拍估算边界**：估算一个整曲固定 BPM，候选范围 60–200 BPM，默认 4 拍 / 小节。强弱起音、倍速 / 半速候选和相位覆盖参与选择，接近的倍速 / 半速候选降低 confidence；真实歌曲的复杂节奏、变速或弱起仍需试听和手调。手调支持 20–400 BPM、1–16 拍 / 小节、非负且小于音频时长的 offset。自动分析音频要求 2 秒至 1 小时；短音频可手调。
3. **可选素材时长**：当前 PvAsset 返回 file / kind / bytes，seconds 可选字段未做额外探测；配乐真实时长来自 PCM 并写入 PvBeats.duration。界面对没有 seconds 的视频 / 音频应显示未知时长，不能当作 0 秒。
4. **格式边界**：导入按常见媒体扩展名过滤，不保证每个扩展名内的内容有效、或本机解码器支持所有具体编码；错误由 ffmpeg / Remotion 暴露。单素材上限 512 MB，单次选择最多 100 个文件。
5. **安全边界**：沿用逐级拒绝符号链接的 safePath，媒体读取及源文件打开使用 O_NOFOLLOW，复制使用独占目标创建并限制实际流字节数。没有声称完全消除恶意进程并发替换父目录的 TOCTOU；导入中途发生 I/O 错误时会清理当前未完成文件，但此前已成功导入的文件保留，不做跨文件事务回滚。
6. 应用内录屏、AI 图片 / 视频模型、TTS、外部经验包，以及截图 + ffmpeg 第二合成引擎均未实现，按任务书留待后续决定。

已停止，不继续额外测试循环、启动应用或扩大改动范围。
