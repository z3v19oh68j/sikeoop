# 第三轮复审

日期：2026-10-09。Codex-2 复审 Claude-2 第二批修改。
只新增报告，未修改业务源码；没有运行桌面应用、真实模型或真实 MCP。
本次独立 `npm run typecheck` 通过，退出码 0。
源码路径均相对 `sweet-code-desktop/`。

## 结论

**上一轮主要路径与权限修复已取得实效，但仍有 3 项未关闭：1 项保存范围遗漏、1 项审批 UI 状态串扰、1 项归档失败残留。**
以下模块测试、处理函数测试不等同桌面 E2E。未在 FAT/exFAT 实盘执行归档降级测试。

## 1. P1：切项目时漏检保存期间变脏的其他文件【已复现】

- 位置：`src/renderer/src/App.tsx:375-389`；切换后清空标签：`209-213`。
- 新增检查仅检查 `written.has(f.path)` 的文件，即开始时已经 dirty、被这轮保存的文件。
- 开始时 A 未保存、B 干净；保存 A 的等待期间编辑 B；即使 filesRef 已准确反映 B 的新内容，检查也跳过 B，返回 true，切项目会丢掉 B。
- 保存期间新打开并编辑的 C 同样漏检。
- 从当前源码 AST 提取真实 settleUnsaved，模拟写入延迟并显式刷新 filesRef，结果：
  - 保存中继续编辑 A：`allowed=false`，正确阻止。
  - 保存中将原本干净的 B 改脏：`allowed=true`，B 仍未保存。
  - 保存中新增未保存标签 C：`allowed=true`，C 仍未保存。
- 建议：按关闭目标范围检查最新全部文档，而不是只检查 written 的键；切项目时范围是全部打开的文档。对本轮已写文件比较写入快照，其他文件比较真实 savedContent，并阻止新输入穿过切换事务。

### 对 filesRef 更新时间的回答

- 当前同文件修改只要已经渲染进 filesRef，确实会被拦下，本轮回归通过。
- 紧接 setFiles 后读取 filesRef，不会因为这次 savedContent 尚未渲染就必然漏判：判断比较的是 content 与 written，不依赖这次 savedContent 更新。
- 但 filesRef 在 render 中刷新（`App.tsx:110-111`），onChange 仅 setFiles（`705`）；它不是同步更新的 Monaco 文档版本。因此尚不能证明“编辑已发生、React 尚未提交”窗口绝对安全。本轮未在实际 React/Electron 调度中复现此更窄竞态，不作为另一项已确认故障。
- 推荐以同步文档版本/受控编辑锁串起保存与关闭，最终 UI 验证覆盖待提交输入及项目切换窗口。

## 2. P2：humanOnly 仍产生两张同 ID 卡片，状态互相覆盖【已复现】

- 位置：`src/main/agent/loop.ts:876-880,993-1005`；`src/renderer/src/components/ChatPanel.tsx:629-640,664-665`。
- hookApproved 只跳过非 humanOnly 的内层审批。fetch_page 的非搜索结果网址是 humanOnly，因此仍会先出 Hook 卡，再出网页确认卡。
- 主进程事件与当前真实 applyEvent reducer 联合验证：批准 Hook 卡、拒绝网页卡后，两张卡都显示 `rejected`，因为它们共享同一个 call.id。
- 保留 humanOnly 的第二次显式确认是正确的权限边界；问题不是“所有情况必须只有一张卡”，而是把工具 ID 同时当成审批 ID。
- 建议：每次审批生成独立 approvalId，另保留 toolCallId 关联命令输出、diff 与工具完成状态；pendingApprovals、用户回应和 UI 状态均按 approvalId 匹配。
- 本次未发生网络访问，未将状态串扰描述为已复现的 humanOnly 越权。

## 3. P2：归档 fallback 的 rename 失败会遗留零字节正式 ZIP【故障注入已复现】

- 位置：`src/main/archive/service.ts:174-181`；外层清理 `138-143`。
- 独占创建正式名后，rename 抛错时没有清理本次占位文件。外层只删 part，最终目录遗留名字正常但内容为 0 字节的 ZIP。
- 注入 link=ENOTSUP、rename=EIO：归档返回错误，目录残留一个 `project_....zip`，大小为 0；part 已清理。
- 建议：追踪占位文件所有权，将 close/rename 失败纳入局部清理；不能误删已被别人替换的文件。还需明确崩溃时留下占位文件的恢复策略，或避免用正式扩展名暴露未提交占位。
- 相比上一轮：普通“不存在检查后创建同名文件”的覆盖竞争已修复。现在的测试在 exclusive open 前创建竞争文件，竞争文件保留，新归档选择 `_2.zip`。

## 本轮已验证通过

| 项目 | 结果 |
|---|---|
| 当前 pid-时间戳 tmp 名预置外部软链接 | saveCanvas 拒绝，外部文件不变 |
| 外部父目录链接与悬空链接 | resolveSafe 拒绝 |
| 审批期间替换父目录后 mkdir | 工具拒绝，项目外未创建 nested 目录 |
| 正常硬链接路径同秒连续归档 | 两份 ZIP 均保留，第二份 `_2.zip` |
| fallback 正常路径 | 成功生成非零 ZIP |
| fallback 独占创建前同名竞争 | 竞争文件保留，新归档改名 |
| opts.dir 初始化失败 | busy=false，不再卡住 |
| MCP 从不可信变可信 + Hook ask | 产生 1 张 Hook 卡，拒绝后工具未执行 |
| tool.run 抛错后的 hookPermission | 不再残留 |
| humanOnly 流程结束后两套 Hook 状态 | hookPermission/hookApproved 均为空 |
| 保存期间同一 dirty 文件继续编辑 | filesRef 最新时正确阻止关闭 |
| 原型 list 路径检查 | 静态确认 canvas 读取已走 realDir/insideDir |
| npm run typecheck | 通过 |

未将已知剩余内容提升为通过：应用退出保护、完整抗目录替换竞争、原型文件大小上限、真实磁盘错误/实际桌面 UI 测试，以及原始清单中未纳入本批的其他问题。

## 复现资料

- `/private/tmp/sikeoop-recheck-round3-regression.cjs`：上一轮脚本适配当前占位文件行为后回归；目录 `/private/tmp/sikeoop-recheck-PTVXGD`。
- `/private/tmp/sikeoop-round3-focus.cjs`：当前 tmp 名、fallback 成功/同名竞争/rename 失败、真实审批 reducer、MCP 信任变化验证；目录 `/private/tmp/sikeoop-round3-jQgkhr`。
- `/private/tmp/sikeoop-round3-ui.cjs`：从当前 App.tsx 提取 settleUnsaved，验证同文件、原干净文件、新标签三个保存时序。
- 都从 sweet-code-desktop 目录运行，仅操作新建临时目录或内存模拟；未修改仓库测试和业务文件。
