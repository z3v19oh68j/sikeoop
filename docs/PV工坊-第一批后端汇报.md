# PV 工坊第一批后端汇报

## 结果：部分完成 / 验收受阻

实现了共享接口、preload、主进程 IPC 接线、项目存取、前三步模型任务、compose 编程模型生成组件、Remotion 工程模板、render 调度和 ffmpeg 转码/封面/SRT、经验包与技能安装，以及 11 项 PV 单测。
未修改 renderer；未启动应用；未联网安装依赖；未提交 git。原有工作区改动保留。

指定的 ../docs/PV工坊-第一批后端汇报.md 在当前沙箱可写根之外，也与 LEGION 项目外不写的约束冲突；没有越界写入。本文件为仓库内交接副本，需指挥官移动到指定位置。

## 改动文件

- src/shared/types.ts
- src/preload/index.ts
- src/main/index.ts
- package.json
- src/main/pv/ffmpeg.ts
- src/main/pv/host.ts
- src/main/pv/ipc.ts
- src/main/pv/packs.ts
- src/main/pv/service.ts
- src/main/pv/skills.ts
- src/main/pv/store.ts
- src/main/pv/template.ts
- resources/pv-packs/common/captions.json
- resources/pv-packs/common/delivery.json
- resources/pv-packs/common/language.json
- resources/pv-packs/common/rhythm.json
- resources/pv-packs/promo/minimal.json
- resources/skills/ffmpeg-recipes/SKILL.md
- resources/skills/pv-storyboard/SKILL.md
- resources/skills/remotion-pv/SKILL.md
- test/pv/pv.test.ts

- shared/types / preload：只新增 PV 类型和方法。
- main/index：仅新增 PV 初始化、IPC 注册、启动技能安装接线。
- package.json：仅追加 pv-packs 和 skills 的 extraResources，不新增应用依赖。
- src/main/pv：store / packs / ffmpeg / template / service / ipc / skills / host。
- test/pv：Node 原生类型剥离；运行时相对 import 带 .ts，无构造函数参数属性。
- 经验包与三个 SKILL.md：自主撰写中文，未复制外部内容。

## 新增接口

类型：PvKind、PvStep、PvShot、PvProject、PvStoryboard、PvPack、PvFfmpegState，按任务书名称与字段原样添加。

SweetApi：
pvList、pvCreate、pvGet、pvRunStep、pvCancel、pvReadFile、pvWriteFile、pvStoryboard、pvSaveStoryboard、pvPacks、pvFfmpeg、pvFfmpegDownload、pvRenderPreview。
IPC 为 pv:list / create / get / runStep / cancel / readFile / writeFile / storyboard / saveStoryboard / packs / ffmpeg / ffmpegDownload / renderPreview。
新增 onPvProgress 订阅 pv:progress，返回取消订阅函数。

root 必须是真实路径解析后等于当前工作区；主进程拒绝打包版调用。项目文件相对路径拒绝绝对路径、..、反斜线、符号链接，文本限 4 MB。project.json 不允许通过通用写接口改写。分镜支持 JSON 围栏、文字包围、直接数组兜底，同时校验镜头字段、时长、唯一 ID 和来源。

每步一个 dispatch 任务；同项目排他，后续步骤挂到首个任务树。beats/assets 明确返回“第二批”。compose 先写模板，再让现有模型完成编程代理工作，仅接受 src/ 下完整 TS/TSX/CSS 文件。renderPreview 等待同一调度任务结果，不额外启动非调度渲染。

ffmpeg 下载复用论文工坊网络白名单、SHA-256、受限解包；在现有审批 UI 批准后才下载，校验失败删除暂存，不执行不发布。安装目标 userData/tools/ffmpeg/，重启后校验已安装二进制。技能通过 SkillStore.syncBuiltin 安装，已有目录不覆盖，尊重用户删除记录。

## 验证：最终命令输出末尾

### npm run typecheck（exit 0）

```text
> sikeoop@4.1.58 typecheck
> node node_modules/typescript/bin/tsc --noEmit -p tsconfig.node.json && node node_modules/typescript/bin/tsc --noEmit -p tsconfig.web.json
```

### npm test（exit 1）

```text
✖ on this machine: saving a watched file is noticed, other files in the folder are not (2420.996959ms)
ℹ tests 322
ℹ suites 0
ℹ pass 321
ℹ fail 1
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 3551.240791
✖ failing tests:
✖ on this machine: saving a watched file is noticed, other files in the folder are not (2420.996959ms)
```

322 项中 321 通过、1 失败；PV 新增 11 项全部通过。
失败原始位置：test/papers/typeset.test.ts:316，assert.ok(changes > 0)。
失败名称：on this machine: saving a watched file is noticed, other files in the folder are not。
这是现有论文工坊文件监听用例，未修改其测试或实现，不扩大范围去修。未达到“npm test 全过”的验收条件。

完整原始日志：/tmp/pv-typecheck.log、/tmp/pv-test.log。

## 存疑点 / 遗留工作

1. **阻断：macOS/Linux ffmpeg 自动下载未完成。** 默认源使用 BtbN Windows x64 LGPL ZIP，需 GitHub asset.digest 提供 SHA-256；无摘要则拒绝。macOS 无已配置 LGPL 源；Linux 的 tar.xz 当前复用解包器不支持，显式拒绝而非误当 gzip。需要指挥官确定可信、带摘要的 LGPL macOS 构建及 Linux xz 解包策略。未实际联网验证发布资产可用性，Windows 下载也只有假网络测试，不声称真实下载成功。
2. **阻断：全量测试有上述既有 watcher 失败。** 需该模块负责人或可运行文件监听的环境复核；本任务未修改 papers。
3. 未运行应用、真实模型、Remotion CLI 或真实 ffmpeg。typecheck 和单测不等于端到端出片成功。依赖仅写进用户 PV 工程，不自动安装；首次 render 提示用户在工程内安装依赖。
4. compose 使用现有模型的编程代理职责，不接用户终端 Claude Code/Codex 会话；生成源码尚未进行真实模型运行验证。Remotion 模板是可编辑基线，不代表美术成片。
5. render 采用 LGPL 可用的 mpeg4 转码，封面 JPG 与独立 SRT。未做音乐、AI 素材、卡点或外部经验包导入。项目依赖 Remotion 版本固定，未安装验证兼容性。
6. 任务树与排他记录目前仅当前进程保存；应用重启不恢复 PV 树，不自动恢复 running 状态。
7. 文件路径逐级拒绝符号链接、读文件 O_NOFOLLOW、写文件临时文件后 rename；仍未覆盖恶意进程并发替换父目录的 TOCTOU，不能声称消除此类竞态。
8. 新增 onPvProgress 是任务书事件的 preload 订阅封装；前端应使用该方法监听单对象事件。原约定所有 pv* 方法名称未改变。
9. 指定汇报位置因写权限边界未写入；请将此副本交给指挥官归档。

已停止；不继续改动无关模块或启动应用。
