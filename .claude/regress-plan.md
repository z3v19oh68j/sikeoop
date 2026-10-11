# 测试与回归基线面板：定稿方案（已经用户确认）

项目：sweet-code-desktop。接口已冻结：
- `src/shared/types.ts`：搜索 `RegressItem` 到 `RegressView`，以及 SweetApi 里的 `regress*` 方法
- `src/preload/index.ts`：搜索 `regress:` 通道

接口改动只能由指挥官（Claude-1）做，如有需要请提出。

## 存储（项目根目录 `getRoot()` 下的 `.sikeoop/regress/`）

| 文件 | 内容与写法 |
|---|---|
| `items.json` | `RegressItem[]`，原子写入（先写 tmp 再 rename） |
| `runs.jsonl` | 只追加，每行一个 `RegressRun`；改判时追加同 id 的新行，读取时同 id 以最后一行为准；坏行跳过 |
| `baselines/<id>.json` | 写入后不再修改 |
| `replies/<runId>.txt` | AI 原文，截断到 64KB |
| `settings.json` | `RegressSettings` |

`RegressSettings` 默认值与取值范围（越界时截到边界）：

| 字段 | 默认 | 范围 |
|---|---|---|
| `runTimeoutSec` | 300 | 30–3600 |
| `generateTimeoutSec` | 600 | 60–3600 |
| `maxPerBatch` | 50 | 1–200 |
| `maxCandidates` | 30 | 1–100 |

## IPC（全部 `ipcMain.handle`；失败返回 `{error: 中文原因}`，不抛异常）

| 通道 | 行为 |
|---|---|
| `regress:view` | 返回 `RegressView` |
| `regress:generate(session, focus?)` | 等 AI 回复完再返回 |
| `regress:addItems` / `regress:updateItem` / `regress:deleteItem` | 删除条目时，它的运行记录保留 |
| `regress:run(itemIds, session)` | 立即返回 `runIds`，后台串行执行；`itemIds` 超过 `maxPerBatch` 时报错 |
| `regress:cancel(runId?)` | 用 `AbortController` 停止等待，记为 `cancelled`；不打断会话本身 |
| `regress:override` | 写入 `verdict`，并置 `overridden=true` |
| `regress:snapshot(name)` | 取每个条目、每个 CLI 的最新结论，`pending` 也存 |
| `regress:diff` | 对每个条目、每个 CLI 比较基线和最新结论，同一个 CLI 才对比 |
| `regress:deleteBaseline` | 删除一个基线 |
| `regress:reply` | 返回运行记录对应的 AI 原文 |
| `regress:setSettings` | 修改设置 |
| 推送 `regress:changed` | 任何状态变化都推 `RegressView` 给所有窗口 |

`regress:diff` 返回的 `kind` 判定：

| kind | 条件 |
|---|---|
| `regressed` | 基线是 pass，现在是 fail |
| `fixed` | 基线是 fail，现在是 pass |
| `same` | 两边结论相同 |
| `new` | 基线里没有这一条 |
| `missing` | 现在没有这一条 |
| — | 其余情况算 `same` |

`conflicts`：同一条目最新的 Claude 结论和最新的 Codex 结论都不是 `pending`，并且两者不同。

## 派发（复用 `src/main/peers.ts` 的 `hostSend`:207、`waitTurn`:221、`hostFind`）

1. **先调 `waitTurn` 注册监听，再调 `hostSend`。** 顺序反过来，会话回得快时会漏掉这一轮。
2. **派发前检查会话状态：**

   | 会话状态 | 处理 |
   |---|---|
   | 不存在 | 拒绝，提示找不到会话 |
   | `starting` | 拒绝，提示"还在启动" |
   | `working` / `waiting` | 拒绝，提示"会话正忙" |

3. **会话锁：** 每个会话同一时间只跑一个任务（生成或执行）。同一会话内串行，不同会话之间并行。每个项目同一时间只能有一个生成任务。
4. **结束状态：**

   | 情况 | 状态 |
   |---|---|
   | 超时 | `timeout` |
   | `waitTurn` 返回 null 且会话已消失 | `gone` |

5. **超时：** 用 `settings` 里的值，每个任务开始时读取，所以改设置能立即生效。

## 提示模板与解析（`parse.ts`，纯函数）

### 生成条目

```
请阅读本项目代码（重点：{focus|全项目}），列出值得做回归验证的功能点，最多 {maxCandidates} 条。
不要修改任何文件，不要运行会改动环境的命令。
在回复最后按下面格式输出，块外不要放条目：
<<<REGRESS_ITEMS
[{"title":"≤60字","detail":"≤500字，怎么验证","owner":"frontend|backend|both","criteria":"≤300字，可判定的通过标准"}]
REGRESS_ITEMS>>>
```

解析规则：

- 只看回复的最后 128KB，先去掉 ANSI 转义。
- 取最后一个 `<<<REGRESS_ITEMS ... REGRESS_ITEMS>>>` 块，`JSON.parse` 后必须是数组。
- 逐个元素校验：字段必须是字符串；`owner` 不在枚举里时按 `both` 处理；超长的截断；`title` 为空的丢弃。
- 按 `title` 去重，同时跳过和已有条目同名的；最多保留 `maxCandidates` 条。
- 解析失败时返回 `{error:"未找到条目块", rawExcerpt}`，`rawExcerpt` 取原文末尾 2KB。

### 执行条目

```
请验证下面这一条，只读代码/运行只读命令，不要修改文件：
标题：{title}
说明：{detail}
通过标准：{criteria}
最后一行必须是且只能是以下之一：
RESULT: PASS — 一句理由
RESULT: FAIL — 一句理由
```

判定规则：

- 去掉 ANSI 转义后，在最后 5 个非空行里自下而上匹配：
  `/^\s*\**RESULT:\s*(PASS|FAIL)\b\**\s*[—:-]?\s*(.*)$/i`
- 取第一个命中的行。
- 同一行里 PASS 和 FAIL 都出现，或者没有命中，都判为 `pending`。
- `reason` 截到 500 字，`excerpt` 取原文末尾 2KB。

## 安全

- **根目录：** 只用 `getRoot()`，渲染层不传任何路径。`hasRoot()` 为 false 时返回 `{error:"未打开项目"}`。
- **路径检查：** 对 root 和 `.sikeoop/regress` 都做 realpath，确认后者在前者之内；用 `lstat` 检查 `.sikeoop`、`regress` 和目标文件，任何一个是符号链接就拒绝。
- **id：** 由主进程生成，格式 `/^[a-z0-9-]{8,40}$/`；外部传进来的 id 也按这个格式校验。
- **入参校验：** 每个 handler 都手写运行时校验：类型、枚举值、长度（`name` 最多 80 字，字段长度同上）。
- **写入：** 所有写操作排队串行执行。
- **不扩大权限：** 不新增通用文件读写 API。

## 文件归属

- **Codex 军团：** 新增 `src/main/regress/{store,parse,runner,ipc}.ts`；在 `src/main/index.ts` 的 `term:agents` handler（约 :1056）附近注册，需要用到的 `agentBus` 依赖靠注入传入。
- **Claude 军团：**
  - 新增 `src/renderer/src/components/RegressConsole.tsx`
  - 修改 `App.tsx`：`:86` 的 screen 类型、`:603-611` 的侧栏入口、`:681` 的挂载
  - 修改 `src/renderer/src/dev-mock.ts`
  - 修改 `src/shared/manual.ts`
- **不要碰对方的文件。**
