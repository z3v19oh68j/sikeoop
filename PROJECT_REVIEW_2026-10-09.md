# sikeoop 当前项目审查清单

审查日期：2026-10-09。主体：`sweet-code-desktop`，package 版本 0.3.0。
基于当前工作区（含未提交、未追踪代码），不是只审查 Git HEAD。
本次没有修改业务源码，没有调用真实模型、连接真实 MCP 或读取用户凭据明文。

## 结论

优先补数据保护、项目隔离和权限执行，而不是继续扩展功能。当前能构建，但类型检查不通过；已有多个可复现的数据丢失及边界问题，不宜把构建成功当作可发布的依据。

P1：应优先修复的数据丢失、权限或隔离问题；P2：稳定性和工程门禁；P3：架构及性能改进。公开分发风险另注明前提。

以下源码路径均相对 `sweet-code-desktop/`。代码行号对应本次读取的工作区。

## P1：优先修复

### 1. 同秒归档失败会删除上一份成功的 ZIP【已复现】
- 位置：`src/main/archive/service.ts:52-72,133-138,184`。
- 文件名精度只有秒；第二次同名归档用 `wx` 打开失败，但 `out` 已赋值。catch 因而删除同名路径，误删上一份完整归档。
- 临时目录中固定时钟、连续归档两次：第二次报 `EEXIST`，第一份 ZIP 随后不存在。
- 修复：只清理由本次调用成功创建的文件；使用唯一临时文件并在成功后提交，最终文件名增加唯一标识。

### 2. 新建文件可沿父目录软链接写到项目外【已复现】
- 位置：`src/main/workspace.ts:31-46`；调用方 `src/main/tools/edit-tools.ts:148-162`。
- 目标文件不存在时，realpath 失败后退回词法检查，没有校验实际父目录。
- 临时项目的 `bridge` 指向临时外部目录，经 `resolveSafe('bridge/new.txt')` 写入成功，文件落在外部目录。
- 修复：解析最近存在的祖先真实路径；创建和写入前重新验证边界，考虑路径替换竞争。

### 3. 原型存储绕开统一文件边界【已复现】
- 位置：`src/main/prototypes/store.ts:54-72,112-125`。
- `insideDir()` 只检查词法路径，`saveCanvas()` 直接拼路径；原型目录或页面文件的软链接未做真实路径检查。
- 将 `prototypes/demo` 链到临时外部目录后，`saveCanvas()` 成功在外部写入 `canvas.json`。
- 修复：普通文件工具、原型 CRUD 和预览协议统一使用真实路径边界策略。

### 4. “全部同意”覆盖 Hook ask 和 humanOnly【两种分支均已复现】
- 位置：`src/main/agent/loop.ts:874-900`；真实高风险调用方 `src/main/tools/resource-tools.ts:80-100`。
- `autoApprove` 先设定 `auto=true`，后续发现 Hook 要求 ask 或操作标记 humanOnly 时没有清零，直接自动批准。
- 模拟验证：`confirm + autoApprove + Hook ask`、`confirm + autoApprove + humanOnly` 均返回 `approved:true`。
- 影响不只文件修改：高风险技能安装本应要求本人确认，也可受此影响。可信 MCP 工具另会在 `plugin-tools.ts:93-107` 跳过 requestApproval，Hook ask 缺少统一执行点。
- 修复：统一在执行入口判定，明确 deny、强制人工、Hook ask、会话批准的优先级，不让各工具自行决定是否执行强制审批。

### 5. 切项目会把旧项目摘要保存到新项目【已复现】
- 位置：`src/main/index.ts:773-783`；`src/main/agent/loop.ts:294-296,440-455`。
- `openProject()` 先更换全局 root，再 `session.reset()`；reset 触发旧会话摘要，而摘要读取的 root 已是新项目。
- 模拟满足离开摘要门槛的 A 会话，按现有顺序先改 root 为 B 再 reset，保存结果为 `{root:'project-B', text:'summary-of-project-A'}`。
- 修复：会话永久绑定所属 root；切换前以旧 root 完成快照及停止流程，不从可变全局变量推导归属。

### 6. 未保存文件关闭或切项目直接丢失【静态确认】
- 位置：`src/renderer/src/App.tsx:206-210,367-373`。
- 关闭标签直接 disposeModel 并移除状态；进入新项目直接清空 files，没有保存、放弃、取消流程。
- 修复：关闭标签、切项目和真正退出共用 dirty 检查；增加可恢复草稿。关闭标签后已 dispose 的模型不能靠“按撤销”恢复。

### 7. 子代理的 readOnly 不是实际只读权限【静态确认】
- 位置：`src/main/index.ts:587-622,649-653`；`src/main/tools/command-tools.ts:75-97`。
- 只过滤 `EDIT_TOOLS`，仍保留任意 shell 和 MCP，并以 `lazy:true` 运行。角色仍可通过命令或写入型 MCP 改文件，且 shell 修改不进入编辑工具的撤销检查点。
- 修复：用能力白名单定义只读角色，删除通用执行及写入型 MCP 权限；确实要运行测试时，应明确允许的副作用范围及执行隔离。单靠角色提示词或命令正则不构成只读保证。

### 8. 客户端携带共享服务商 Key【公开分发前需处理】
- 位置：`src/main/providers/builtin-key.ts:3-35`。
- 密文、派生材料和解密代码都在客户端内；代码注释也明确承认可恢复。加密只能避免直接文本搜索，无法提供服务端凭据保密边界。
- 本次未解密、输出或测试该 Key，也未验证其是否有效；这是分发架构风险，不是已发生的盗用事件。
- 修复：改为服务端代理、用户身份和配额控制，或要求用户自带 Key；若已分发有效共享 Key，迁移后轮换。

## P2：稳定性与工程门禁

### 9. reset 没有等待旧回合退出，旧状态会回流【已复现】
- 位置：`src/main/agent/loop.ts:294-318,377-389,423-431`；项目切换 `src/main/index.ts:773-777`。
- reset 仅 abort 后立即清空共享字段；旧 send 的 rollback/finally 仍修改同一实例。
- 模拟进行中的回合：reset 返回时 busy 仍为 true；旧回合结束后，原 notes 与 snapshotSent 再次回到新会话对象。
- 自动化 stop 同样只发 abort（`src/main/automation/service.ts:150-153`），切项目没有等待任务清理。
- 修复：异步 cancel-and-drain；会话 generation 校验；事件、文件上下文和持久化绑定固定 root/sessionId。
- 边界：已复现状态污染；本次没有复现实际跨项目业务文件覆盖。

### 10. 摘要服务失败仍清空模型历史【已复现】
- 位置：`src/main/agent/loop.ts:483-523`；`src/main/agent/compactor.ts:117-123`。
- compress 失败后使用非常有限的 fallback，仍执行 adapter.restart。fallback 主要是助手最后一段回复，加上任务、计划、文件名，不能保留完整要求和关键过程。
- 模拟摘要服务异常：历史被清空，先前用户约束标记未进入替代摘要。
- 修复：有效摘要成功后才提交历史替换；失败时保留可恢复快照并显式提示，重试或让用户选择降级。
- 丢失的是模型可续聊上下文，不等于 UI transcript 立即删除。

### 11. 保存完成回调会把保存期间新输入的内容误标为已保存【静态确认】
- 位置：`src/renderer/src/App.tsx:376-381`。
- 写盘使用调用时的 `f.content`；await 返回后却把此时最新的 `x.content` 赋给 savedContent。如果保存过程中继续输入，磁盘是旧内容，界面却显示无未保存修改。
- 修复：捕获写入内容/版本，完成后只把该快照设为 savedContent；需要时按文件串行保存。
- 同文件中的 saveAllDirty 已保留写入快照，可统一实现。

### 12. 自动化与聊天互斥只有单向检查【静态确认】
- 位置：`src/main/automation/service.ts:141-147,246-248`；`src/main/index.ts:863-867`。
- 自动化启动检查 chatBusy，但聊天发送不检查自动化是否运行。先启动自动化，再发聊天消息，可形成两个会话同时操作同一工作区。
- 影响：命令副作用、文件检查点和编辑缓冲区更容易互相冲突；各会话自己的 busy 不能提供项目级互斥。
- 修复：主聊天和自动化共用项目执行锁/队列；如果产品有意允许并行，需实现明确的文件写入协调和冲突界面。

### 13. 当前类型检查失败，但构建仍通过【实测】
- 位置：`src/renderer/src/dev-mock.ts:289`；`package.json:9-15`。
- `npm run typecheck` 返回 TS2740：浏览器 mock 不满足 SweetApi，缺 arktsStatus、arktsOpen、arktsChange、arktsClose 等共 8 项。
- `electron-vite build` 则通过，说明现有 build 不能替代类型门禁；dist:win 也未串联 typecheck。
- 修复：补齐 mock 与接口契约，在打包发布前强制执行 typecheck 和测试。

### 14. 没有可执行的仓库回归集【静态确认】
- 位置：`package.json` scripts；`test/fixtures/jev/`。
- 当前 test 目录只有两份 JSON fixture，未发现项目自己的测试用例/测试 runner 脚本或 CI 工作流。fixture 不能自动捕获本次这些回归。
- 修复：先把本次路径、审批、归档、切项目、压缩失败复现固化为测试，再补编辑器保存与生命周期 UI 测试。

## P3：结构与性能

### 15. 主进程入口承担过多模块和生命周期职责【架构判断】
- 位置：`src/main/index.ts`，本次 1237 行；另有 `agent/loop.ts` 1023 行、`renderer/src/App.tsx` 850 行。
- index 集中实例化服务、注册大量 IPC、维护模型/项目选择、启动子代理和管理窗口。真正的问题是这些服务共享可变 root 与不统一的取消语义，不单是行数多。
- 建议：引入固定归属的 WorkspaceSession/ExecutionContext；按工作区、AI、终端、媒体等拆服务和 IPC 模块，统一 dispose、cancel、drain 契约及入口校验。

### 16. 主 renderer 包偏大，需建立启动性能预算【构建测量，非运行性能结论】
- 位置：`electron.vite.config.ts`、渲染层入口及组件依赖。
- 本次主 renderer JS 约 11.24 MB，构建目录磁盘占用约 44 MiB；已有 PDF、图谱等独立 chunk，不应描述成完全没有代码拆分。
- 建议：检查首屏静态依赖，将编辑器及重型视图按需加载，实际测量冷启动、首屏可交互时间和内存，再设预算。
- 本次没有测得冷启动耗时，不能单凭体积声称界面已经卡顿。

## 本次验证记录

| 验证 | 结果 |
|---|---|
| npm run typecheck | 失败，renderer dev-mock 的 SweetApi 缺 8 项 |
| electron-vite build --outDir 临时目录 | 成功，未覆盖项目 out/ |
| 不存在文件经过父目录软链接写入 | 已复现越界 |
| 原型目录软链接保存 canvas | 已复现越界 |
| approve_all + Hook ask | 自动批准，已复现 |
| approve_all + humanOnly | 自动批准，已复现 |
| 更换 root 后 reset 的离开摘要 | 写到新项目，已复现 |
| reset 后结束旧回合 | notes、snapshotSent 回流，已复现 |
| 压缩服务失败 | 模型历史清空且原约束丢失，已复现 |
| 同秒连续 ZIP 归档 | 第二次 EEXIST，第一份被删，已复现 |

验证使用 esbuild 将当前源文件打包在内存中加载；生命周期与审批使用模拟对象/依赖，文件验证只操作临时目录。没有把模块复现描述为完整桌面端 E2E。

临时验证目录：`/private/tmp/sikeoop-audit-IRuRS5`；另建独立归档验证临时目录。
构建输出：`/private/tmp/sikeoop-build-audit.btkXmM`。

## 建议修复顺序

1. 归档误删、未保存编辑与保存竞争：先保障用户数据不丢。
2. 统一路径与审批边界，落实只读子代理能力限制。
3. 固定工作区归属，完成 cancel-and-drain 和双向执行互斥。
4. 摘要失败保全、类型检查、回归测试与发布门禁。
5. 公开分发前移除共享凭据；再推进模块拆分和性能优化。
