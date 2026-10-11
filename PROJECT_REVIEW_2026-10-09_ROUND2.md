# 第一批修复复审

日期：2026-10-09。审查方：Codex-2；修复交接方：Claude-2。
范围：第一批修复涉及的归档、路径、原型、审批、未保存内容、保存状态、浏览器 mock。
只新增本报告，未修改业务源码。没有运行桌面应用或真实模型/MCP，没有新增仓库测试。

## 结论

**部分修复有效，但本批不能整体关闭。** 存在四项优先阻塞问题，以及若干剩余边界和状态问题。

本次独立运行 `npm run typecheck`，退出码 0。
模块验证使用 esbuild 内存打包当前源码；竞态用临时目录和可控故障注入重现；UI 问题使用 TypeScript AST 提取当前真实处理函数验证，不是桌面 E2E。
以下源码路径均相对 `sweet-code-desktop/`。

## P1：仍需修复

### R1. 原型临时文件仍可经软链接覆盖项目外文件【已复现】

- 位置：`src/main/prototypes/store.ts:133-139`。
- 最终 `canvas.json` 经 insideDir 检查，但实际首先写入的是未经检查的 `${file}.${process.pid}.tmp`，且 writeFile 没有独占创建。
- 复现：正常的项目内 `prototypes/demo`，预先建立 `canvas.json.<pid>.tmp` 软链接指向临时外部文件；调用 saveCanvas 成功，外部文件被改写。随后 rename 移动的是这个软链接本身。
- 无需竞争，仅有固定临时文件软链接即能触发；“最终目标路径已检查”不足以保护临时文件。
- 建议：随机唯一临时文件并独占创建，拒绝跟随已存在链接，使用成功创建的文件句柄写入；失败只清理本次拥有的临时文件。

### R2. 归档不支持硬链接时的 fallback 仍会覆盖竞争者文件【故障注入已复现】

- 位置：`src/main/archive/service.ts:159-173`。
- `fs.access(name)` 与 `fs.rename(part,name)` 之间没有互斥。不存在检查后，另一个写入方创建同名文件，rename 会替换它。
- 注入方式：令 fs.link 返回 ENOTSUP；在实际 rename 前创建同名标记文件，再执行真实 rename；结果该文件被 ZIP 替换。
- 这验证的是 fallback 算法的竞争，不是已在 FAT/exFAT 实盘跑过。
- 同时 fallback 对除 EEXIST 外的所有 link 错误生效，没有区分不支持硬链接与权限/I/O 等错误。
- 建议：保留原子不覆盖提交语义；无法做到时应报错而非悄悄采用覆盖式 rename，或使用明确的独占创建方案并说明非原子可见性的限制；严格限定可降级错误。

### R3. MCP 从不可信改为可信后，Hook ask 仍被跳过【已复现】

- 位置：`src/main/agent/loop.ts:985-999`；`src/main/tools/plugin-tools.ts:80-107`。
- registry 创建时 MCP 不可信，tool.permission 固定为 confirm；之后用户把服务设为可信，工具执行时 `mcp.isTrusted()` 返回 true，就不再调用内层 requestApproval。
- 新增通用审批只处理 `permission === 'auto'`，因此这个 confirm 工具的 Hook ask 两边都没有执行。
- 模拟 MCP 的 registry 快照 trusted=false、执行时 isTrusted=true，Hook 返回 ask：工具实际执行，approval_request 数量为 0。
- 建议：Hook ask 在调度层对所有工具统一强制执行，不能依赖注册时 permission 猜测工具是否会自行弹卡；使用一次性、绑定本次调用的批准状态协调内层审批。

### R4. “保存后关闭”仍丢失保存期间新增编辑【真实处理函数模拟已复现】

- 位置：`src/renderer/src/App.tsx:375-397`；项目切换入口 `191-203,209-213`。
- settleUnsaved 捕获调用时 files/dirty，逐个 await 写入后直接返回 true；等待期间没有锁定编辑，也不重新校验最新内容版本。
- 复现：调用 closeFile，选择保存，暂停 writeFile；模拟新一次渲染将内容更新为 version-2；释放保存后，磁盘为 version-1，标签已移除，version-2 丢失。
- 此处不是“点击时一定拿到长期旧闭包”：普通 JSX 回调每次渲染更新。问题是异步操作开始后持有旧快照并无条件允许关闭/切换。
- 建议：关闭/切换期间冻结相关编辑，或保存后对 filesRef/文档版本重新校验；有新编辑则继续保存或中止关闭。工作区切换请求也需串行化。

## P2：剩余问题

### R5. 写入前重验发生在 mkdir 后，拒绝前已产生项目外副作用【已复现】

- 位置：`src/main/tools/edit-tools.ts:44-57`。
- 审批期间把原有父目录替换为项目外软链接；写入虽被后续 resolveSafe 拒绝，但先执行的 recursive mkdir 已在外部创建目录。
- 临时复现：创建 pending/nested/new.txt 的审批期间，将 pending 替换为外部链接；工具报越界错误，外部 nested 目录已存在。
- 建议：读取和 mkdir 等文件操作前先重新验证，而不是只保护最后 writeFile。重新验证后仍有 TOCTOU 窗口，不能宣称已实现抗并发路径替换的完整文件系统隔离。

### R6. Hook 通用卡和内层卡复用同一 ID【已复现】

- 位置：`src/main/agent/loop.ts:987-1000`；`src/main/tools/web-tools.ts:255-268`；`src/renderer/src/components/ChatPanel.tsx:629-640,664-665`。
- 实际 fetch_page 工具，URL 不在搜索结果，PreToolUse 返回 ask：先产生 Hook 卡，批准后又产生网页 humanOnly 卡，两张卡的 id 都是同一个 call.id。
- 本次批准第一张、拒绝第二张，未发生网络访问；两次审批并不等于权限越过。但 renderer 的 approval_result 会更新所有同 ID 卡，把前一张的已批准状态也改成拒绝。
- 建议：区分 toolCallId 与 approvalId；保留 humanOnly 的独立语义，明确哪些确认可以合并。不要只删除 Hook 决策后让内层自行猜测。

### R7. 异常路径没有清除 hookPermission【已复现，既有缺口仍在】

- 位置：`src/main/agent/loop.ts:985-1009`。
- 工具抛错，或通用审批等待时取消，跳过 success 路径上的 delete；没有 finally 清理。reset 也没有清除此 Map。
- 模拟 Hook allow 后工具抛错，调用完成后对应 ID 仍在 Map 中。
- 建议：每个 runOne 在 finally 无条件删除本次 call.id 的 Hook 权限，reset 时也清空。当前确认的是残留状态；未把它夸大成正常唯一 ID 情况下必然越权。

### R8. 原型 list() 仍不受真实路径边界约束【静态确认，未完整关闭原报告 #3】

- 位置：`src/main/prototypes/store.ts:46-59`。
- list() 不仅计算目录项，而是 stat/readFile/JSON.parse 整个 canvas.json。prototypes 根链接到项目外，或某个 canvas.json 是外部链接，仍会读项目外文件。
- 目前返回的是名称、页数、时间，不是任意原文；但“只统计页数”不能作为跳过文件边界的依据，而且读取没有大小上限。
- 建议：列表枚举、canvas 读取也走同一检查，并在读取前限制大小。

## 附带发现：归档初始化失败会卡住 busy【已复现，非本批新引入】

- 位置：`src/main/archive/service.ts:49-58,144-145`。
- running 置位后，await opts.dir() 在 try/finally 外；该依赖抛错则 busy 永远保持 true。
- 模拟 opts.dir 拒绝后，busy=true。实际应用的当前 archiveDir 已捕获部分文件读取错误，本项是剩余的初始化异常契约，不是宣称常规归档都会卡死。
- 建议：所有 running 置位后的可失败初始化纳入 try/finally。

## 已验证有效 / 可以局部接受的修改

| 修改 | 本次结果 |
|---|---|
| 同秒连续归档，正常硬链接路径 | 两份 ZIP 均保留，第二份命名 `_2.zip`；原误删已修 |
| 不存在文件的外部父目录软链接 | resolveSafe 拒绝 |
| 悬空软链接及其下方不存在路径 | resolveSafe 拒绝 |
| 普通多级不存在路径 | 正常解析为项目内路径 |
| 原型目录直接指向项目外 | saveCanvas 拒绝 |
| approve_all + Hook ask | 进入人工卡，拒绝后返回 approved=false |
| approve_all + humanOnly | 进入人工卡，拒绝后返回 approved=false |
| saveFile 使用 written 快照 | 静态确认修正了原 #11 的错误已保存标记；未验证完整 UI 并发保存 |
| npm run typecheck | 通过，退出码 0 |

### realpathOfNew 的 ENOTDIR 结论

普通文件 regular 下的 regular/child 被解析函数当成可构造路径返回，实际写入仍会得到 ENOTDIR。没有发现此例直接产生越界。建议 ENOTDIR 直接失败，或要求存在的祖先在追加路径时必须是目录，以免“安全解析成功”掩盖无效结构；优先级低于 R1/R5。

### settleUnsaved 的其他边界

- 保存成功没有同步 savedContent：后续取消选择目录时，原标签仍显示 dirty，重复提醒保存。属于 UX/状态一致性问题。
- 应用真正退出保护本批明确未实现，不应把原 #6 整项标记完成。
- saveFile 的单次快照修复不能替代按文件串行保存，以及工作区 generation 校验；这些未在本轮完整验证。

## 复现实物与限制

- 临时复现脚本：`/private/tmp/sikeoop-recheck.cjs`（在 sweet-code-desktop 目录执行；只操作新建临时目录，包含归档故障注入）。
- 该脚本本轮运行目录：`/private/tmp/sikeoop-recheck-4xyAZM`。
- UI 处理函数与 MCP 信任变化用独立内存脚本验证，未访问外部网络、未运行真实 MCP。
- 本轮未重新构建或运行完整应用。此前构建通过不能代替这一轮的运行验证。
