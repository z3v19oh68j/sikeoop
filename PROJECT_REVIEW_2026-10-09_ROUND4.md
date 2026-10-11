# 第四轮复审

日期：2026-10-09。仅审查，不修改业务源码；新增本报告。
没有启动应用、真实模型或真实 MCP。验证为当前源码模块测试、AST 提取的真实 UI 处理函数/reducer 测试及文件系统故障注入，非桌面 E2E。
以下源码路径均相对 `sweet-code-desktop/`。

## 结论

**第三轮三项原始复现均通过回归；保存范围与审批 ID 两项可按本轮范围关闭。归档普通 rename 失败清理已修，但另有两项剩余故障/并发边界，不能称整个失败路径已完全安全。**

## 已通过的三项

### 1. 保存后关闭范围检查

- 位置：`src/renderer/src/App.tsx:375-390,706-711`。
- 当前 settleUnsaved 从 filesRef 取初始 dirty，保存后检查整个 inScope 范围。
- 再运行 `/private/tmp/sikeoop-round3-ui.cjs`，三种保存期间修改均返回 `allowed=false`：
  1. 同一 dirty A 再次修改。
  2. 原本干净的 B 被改脏。
  3. 新增未保存标签 C。
- 静态确认 Monaco onChange 先同步更新 filesRef，再 setFiles，修正了仅等待下一次 render 更新 ref 的输入路径。
- 本结论不等于已经实现项目级关闭事务：真正退出保护、并发项目切换以及其他非 onChange 更新来源的全部时序未做桌面 E2E。

### 2. Hook 与 humanOnly 卡片不再互相改状态

- 位置：`src/main/agent/loop.ts:870-938,995-1006`。
- 用实际 fetch_page 工具触发 Hook 卡与 humanOnly 网页卡，批准前者、拒绝后者；用当前 ChatPanel.applyEvent 处理真实事件结果：
  - `same-id:hook` / Hook：approved。
  - `same-id` / 网页：rejected。
- 两张卡状态正确分离，未发生网络访问；humanOnly 的第二次确认保留正确。
- MCP 注册时不可信、执行时可信的 Hook ask 回归仍通过：拒绝 Hook 卡后工具未执行。
- hookPermission/hookApproved 在测试完成后均清空。
- 这里验证的是当前“一次 Hook 卡 + 一次内层卡”的流程，不宣称任意多次内层 requestApproval 已有全局唯一审批 ID 机制。

### 3. 常规 rename 失败不再留下正式空 ZIP

- 位置：`src/main/archive/service.ts:180-185`。
- 注入 fs.link=ENOTSUP、fs.rename=EIO；返回 EIO，目录为空，part 与本次占位文件均清理。
- fallback 成功路径、独占创建前同名竞争、正常硬链接路径同秒重复归档仍通过；竞争者文件保留，第二份归档改用 `_2.zip`。

## 归档剩余问题

### A. P2：占位句柄 close 失败仍遗留空 ZIP【故障注入已复现】

- 位置：`src/main/archive/service.ts:174-179`。
- open(name, wx) 成功后立即 await close；若 close 拒绝，直接在该 catch 中抛出，尚未进入下方 rename 的清理块。
- 注入：实际创建并关闭占位文件后，由 close 包装返回 EIO。结果归档失败、busy=false，但仍留下正式名的空 ZIP。
- 这不是进程崩溃，也不是本轮已修复的 rename 失败，是占位资源生命周期中的另一个正常异常分支。
- 建议：将成功创建后的 close 与 rename 放在同一所有权管理/清理范围内，不能只在 rename 的 catch 清理。

### B. P2：清理按路径无条件删除，未验证占位文件仍属于本次【并发替换故障注入已复现】

- 位置：`src/main/archive/service.ts:182-184`。
- 注释认为文件“仍为空且是本次创建的”，实际没有检查；exclusive open 只保证创建那一刻取得文件名，不保证之后路径指向的文件不变。
- 注入：本次独占占位创建后，模拟另一个写入方删除该占位并创建同名、有内容的新文件，然后让 rename 抛 EIO；catch 的 rm 删除了这个新文件。
- 条件明确：需要并发方主动替换/重写已占用的路径。普通另一个也使用 wx、仅尝试创建同名文件的竞争，本轮已经通过，不能混为一谈。
- 建议：保留占位身份并在清理时验证，至少拒绝删除已变化的对象；若要求完全抗路径替换竞争，仅 stat 后 rm 也不是原子保证，应选原子 no-replace 提交或不支持时失败关闭。
- 这是完整“仅删除自己文件”保证的剩余边界，不是宣称日常归档必然误删，也不是说新增 catch 又会无条件删除任意旧 ZIP。

## Approver 类型错误单独核实

- 交接消息称当时 `src/main/index.ts:299` 的 new Approver 缺参数。
- **本轮实际读取时，调用已在 index.ts:301-317 提供模型回调和人工升级回调两个参数。**
- 本轮完整 `npm run typecheck` 实测退出码 0，node/web 均通过，未再出现该错误。
- 所以记录为“交接时报告过、当前工作区已不复现”，不列为当前缺陷；不据此推断是谁修改，也不归因于 Claude-2。
- 新 Approver 模块功能不在本轮范围，没有因类型检查通过就认定它运行安全或已完成集成验收。

## 其他回归与未覆盖范围

- 当前 pid-时间戳原型临时文件预置外部链接：拒绝且外部文件不变。
- 父目录外部/悬空链接：拒绝；审批期间替换父目录：没有产生项目外 mkdir 副作用。
- 归档 opts.dir 拒绝后 busy=false。
- ENOTDIR 解析语义、崩溃残留恢复、应用退出保护、抗任意目录替换竞争，以及原始清单其余未纳入本批的事项，没有因此关闭。

## 复现资料

- 已复跑：`/private/tmp/sikeoop-round3-ui.cjs`、`/private/tmp/sikeoop-round3-focus.cjs`、`/private/tmp/sikeoop-recheck-round3-regression.cjs`。
- 本轮重点测试目录：`/private/tmp/sikeoop-round3-gwVaNT`、`/private/tmp/sikeoop-recheck-zWXOkX`。
- 新增临时故障脚本：`/private/tmp/sikeoop-round4-archive-errors.cjs`。
- 新增故障目录：`/private/tmp/sikeoop-round4-errors-OZMYr9`。
- 脚本从 sweet-code-desktop 运行，只使用临时目录/内存模拟；未新增仓库测试，未修改业务代码。
