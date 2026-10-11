# CLI 扩展开发文档

sikeoop 的终端内置支持 Claude Code 和 Codex。其他编程 CLI（opencode、Cursor CLI、Gemini CLI……）通过**扩展定义**接入：一个 JSON 文件描述一个 CLI，不用改 sikeoop 的代码，也不用重启。

接入后，这个 CLI 可以：

- 出现在终端「+」菜单里，开成一个 AI 会话标签；
- 有自己的会话名（如 `OpenCode-1`），显示在灵动岛和终端标签上；
- 和 Claude Code / Codex 互相发消息（`list_peers` / `send_to`）；
- 被 sikeoop 的调度核心排队派活（忙的时候排队，空了再送）。

sikeoop 自带一个 opencode 的定义，格式和你自己写的完全一样，可以当范例看（见第 8 节）。

---

## 1. 五分钟上手

1. 终端面板点「+」→「添加其他 CLI…」，会打开扩展目录。
2. 在里面新建 `mycli.json`：

   ```json
   {
     "id": "mycli",
     "name": "My CLI",
     "label": "MyCli",
     "bin": ["mycli"],
     "args": [],
     "turnEnd": "quiet"
   }
   ```

3. 再点一次「+」，菜单里就有 My CLI 了。点它，sikeoop 会在项目目录里运行 `mycli`。

这是最低档的接入：能开、能被派活，但 sikeoop 只能靠“终端安静了一会儿”来猜它做完没有。要更准、要能互相发消息，往下看。

扩展目录的位置（以「添加其他 CLI…」打开的为准）：

| 系统 | 路径 |
|---|---|
| macOS | `~/Library/Application Support/sikeoop/cli-agents/` |
| Windows | `%APPDATA%\sikeoop\cli-agents\` |
| Linux | `~/.config/sikeoop/cli-agents/` |

规则：

- 一个 `.json` 文件一个 CLI，文件名随意。
- **每次打开「+」菜单、每次启动会话都会重新读**，改完直接再试。
- 文件有错不会加载，「+」菜单底部会显示“xxx.json 没有加载”，鼠标停上去能看到全部原因。
- 文件的 `id` 和内置定义（目前只有 `opencode`）相同时，你的文件生效，内置的被替换。

---

## 2. 字段

| 字段 | 必填 | 说明 |
|---|---|---|
| `id` | 是 | 2–24 位，小写字母开头，只能有小写字母、数字、`-`。不能是 `claude`、`codex`、`shell`。 |
| `name` | 是 | 菜单里显示的名字，最多 40 字。 |
| `label` | 是 | 会话名前缀，只能有字母和数字，最多 16 位。会话叫 `<label>-1`、`<label>-2`……不能是 `Claude` / `Codex`，也不能和别的定义重复。 |
| `description` | 否 | 菜单里名字下面的一行说明。 |
| `bin` | 是 | 可执行文件名的数组（不带路径），按顺序在 PATH 里找，如 `["agent", "cursor-agent"]`。 |
| `paths` | 否 | PATH 里找不到时再看的绝对路径，可以用 `~`，如 `["~/.opencode/bin/opencode"]`。 |
| `install` | 否 | 安装它的一条 shell 命令。有它，没装时界面会出现「一键安装」，命令会打进一个终端标签让用户看着执行。 |
| `args` | 否 | 启动参数，字符串数组，可以用占位符（第 3 节）。 |
| `env` | 否 | 额外的环境变量。值是字符串，或 `{ "json": … }`（填完占位符后序列化成一行 JSON）。 |
| `envPassthrough` | 否 | 允许 CLI 看到的 sikeoop 自身环境变量：写全名，或以 `*` 结尾的前缀（`"MYCLI_*"`）。见第 6 节。 |
| `files` | 否 | 启动前写进**会话专属目录**的文件：`{ "path": 相对路径, "content": 字符串或 { "json": … } }`。 |
| `turnEnd` | 是 | `"hook"`：CLI 自己上报回合结束（第 4 节）。`"quiet"`：按终端安静时间判断（第 5 节）。 |
| `quietMs` | 否 | `turnEnd` 为 `quiet` 时的安静时长，毫秒，1000–600000，默认 8000。 |
| `notes` | 否 | 显示在终端上方的说明文字，字符串数组。 |

CLI 的工作目录固定是当前打开的项目目录。

---

## 3. 占位符

`args`、`env`、`files` 里的字符串可以用下面这些占位符，启动每个会话时填入：

| 占位符 | 内容 |
|---|---|
| `{root}` | 项目目录的绝对路径 |
| `{name}` | 这个会话的名字，如 `OpenCode-1` |
| `{sessionDir}` | 会话专属目录的绝对路径（`files` 就写在这里） |
| `{sessionDirUrl}` | 同上，`file://` 形式 |
| `{hookUrl}` | 状态上报地址（第 4 节） |
| `{mcpUrl}` | sikeoop MCP 的 HTTP 地址（一般用不到，用下面的桥） |
| `{mcpCommand}` | 启动 MCP 桥的命令，**数组**：`[可执行文件, 参数…]` |
| `{mcpBin}` / `{mcpArgs}` | 上面这个数组拆成第一项 / 其余项 |
| `{mcpEnv}` | MCP 桥需要的环境变量，**对象**（目前是 `{ "ELECTRON_RUN_AS_NODE": "1" }`，必须带上） |
| `{instructions}` | 一段给模型的说明：它叫什么、怎么用 `send_to` 联系别的会话 |

三条替换规则：

1. **占位符夹在字符串里**：按文本替换。数组和对象会变成 JSON 文本。
   `"--cd={root}"` → `"--cd=/Users/me/app"`
2. **整个字符串就是一个占位符**：换成值本身，保留类型。
   `"command": "{mcpCommand}"` → `"command": ["/…/sikeoop", "/…/bridge.cjs", "http://…"]`
   在 `args` 里，数组会展开成多个参数。
3. **`{json:名字}`**：换成 JSON 编码后的值，带引号和转义。往代码或配置文本里塞字符串时用它。
   `"const HOOK = {json:hookUrl};"` → `const HOOK = "http://127.0.0.1:…";`

不认识的花括号原样保留，所以 `files` 里可以直接放 JavaScript。注意别让你的代码里出现和占位符同名的 `{root}`、`{name}` 这类写法。

`files` 的限制：路径必须是相对路径，不能有 `..`，只能落在会话专属目录里。扩展**不能**往项目目录或用户主目录写文件。如果某个 CLI 只认项目里的配置文件（比如 `.cursor/mcp.json`），目前接不了它的那部分功能，见第 9 节。

---

## 4. 状态上报协议（`turnEnd: "hook"`）

sikeoop 需要知道会话在干什么，最要紧的是**“这一轮做完了”**：调度核心靠它判断会话空闲，才会送下一个任务，并把最后的回复交回给派活的一方。

做法：让 CLI（通过它自己的插件、hook 脚本或通知命令）往 `{hookUrl}` 发 HTTP POST，内容是 JSON：

| 事件 | 请求体 | 含义 |
|---|---|---|
| 就绪 | `{ "event": "ready" }` | 启动完成，可以接任务。CLI 连上 sikeoop 的 MCP 时会自动就绪，一般不用发。 |
| 开始 | `{ "event": "turn-start" }` | 开始处理一条输入。 |
| **结束** | `{ "event": "turn-end", "text": "最后一条回复" }` | 这一轮做完了。`text` 会作为任务结果交回去，尽量带上。 |
| 等用户 | `{ "event": "waiting", "text": "原因" }` | 卡在需要用户操作的地方（比如权限确认）。灵动岛会提醒。 |
| 用工具前 | `{ "event": "tool", "tool": "edit", "write": true, "file": "src/a.ts", "cwd": "/abs" }` | 可选。见下。 |

除 `tool` 外，响应体都是 `{ "decision": "allow" }`，可以不看。

**`tool` 事件**（可选，CLI 支持“工具调用前拦截”才用得上）：

- `write: true` 且带 `file`（相对路径按 `cwd` 解析）时，sikeoop 会做两件事：检查这个文件是否正被别的 AI 改（全局文件锁），以及当前任务有没有文件归属限制。
- 响应是 `{ "decision": "allow" }` 或 `{ "decision": "deny", "reason": "…" }`。**收到 deny 时你的插件要负责真的拦下这次调用**，并把 `reason` 给模型看。
- 其他工具（`write` 不为 true）只用来在界面上显示“它在干什么”，总是 allow。带 `command` 字段会显示命令内容。

没有这个事件也能用，只是这个 CLI 的写文件不受文件锁保护（和 Codex 同一档）。

**最简单的接法**：如果 CLI 能配置“回合结束时运行一条命令”，一行 curl 就够。地址也在环境变量里：

```bash
curl -s -m 5 -X POST -H 'Content-Type: application/json' \
  -d '{"event":"turn-end"}' "$SIKEOOP_HOOK_URL"
```

sikeoop 给扩展 CLI 的进程设了两个环境变量：`SIKEOOP_HOOK_URL`（同 `{hookUrl}`）和 `SIKEOOP_SESSION`（同 `{name}`）。

地址只在本机（`127.0.0.1`）有效，每个会话不同，会话结束就失效。

---

## 5. 按安静时间判断（`turnEnd: "quiet"`）

CLI 没有任何办法上报时用这个。规则：

- 送进去一条输入之后，终端**有过输出**，然后连续 `quietMs` 毫秒没有新输出，就算这一轮结束。
- 启动后的第一次安静算“就绪”。
- 任务结果取终端最后一段输出的纯文本（去掉颜色和光标控制，最多约 1200 字）。

它是兜底，不准的情况你要心里有数：

- 一个长时间没有输出的工具调用，会被当成“做完了”，下一个任务可能被送进一个还在忙的会话。
- 一直转圈的动画会让它永远不结束。
- 结果是屏幕文本，不是模型的回复原文。

能用 `hook` 就用 `hook`。调 `quietMs` 时宁可大一点。

---

## 6. 环境变量

扩展 CLI 拿到的不是 sikeoop 的完整环境，而是收窄过的：

- 一定有：`PATH`、`HOME`、语言区域、临时目录、代理设置（`HTTP_PROXY` 等）、`TERM` 这类系统变量。
- `envPassthrough` 里列出的会放行，如 `["MYCLI_*", "OPENAI_API_KEY"]`。
- `env` 里写的会加上（同名时覆盖）。
- `SIKEOOP_HOOK_URL`、`SIKEOOP_SESSION` 由 sikeoop 设置。

如果你的 CLI 启动后说找不到 API key，多半是这个 key 在环境变量里而没有放行。

---

## 7. 让它能互相发消息（MCP）

sikeoop 提供一个 MCP 服务，有两个工具：`list_peers`（看有哪些会话）和 `send_to`（给另一个会话发消息）。CLI 通过一个 stdio 桥连上它，桥的启动命令就是 `{mcpCommand}`，必须带上 `{mcpEnv}` 里的环境变量。

怎么把它配给 CLI，取决于 CLI 自己怎么收 MCP 配置。常见的三种：

- **环境变量里收内联配置**（opencode）：放在 `env` 里，用 `{ "json": … }`。
- **命令行参数收 JSON**（Claude Code 的 `--mcp-config`）：放在 `args` 里。
- **指定一个配置文件**：用 `files` 写到 `{sessionDir}`，再用参数或环境变量指过去。

同时把 `{instructions}` 交给模型（系统提示、指令文件，看 CLI 支持哪种），否则模型不知道自己叫什么，也不知道“给 Claude 发消息”是指用 `send_to`。

CLI 连上 MCP 的那一刻，sikeoop 就把会话标成“就绪”。没接 MCP 的 CLI 需要自己发 `ready`，或者用 `quiet` 模式。

---

## 8. 完整例子：opencode（内置定义）

这就是 sikeoop 自带的 opencode 定义（插件代码略有删节，完整版在 `src/main/cli-agents/bundled.ts`）：

```json
{
  "id": "opencode",
  "name": "opencode",
  "label": "OpenCode",
  "description": "开源的终端编程助手；改文件和运行命令前会先问你",
  "bin": ["opencode"],
  "paths": ["~/.opencode/bin/opencode"],
  "install": "curl -fsSL https://opencode.ai/install | bash",
  "args": ["{root}"],
  "env": {
    "OPENCODE_CONFIG_CONTENT": {
      "json": {
        "mcp": { "sikeoop": { "type": "local", "command": "{mcpCommand}", "environment": "{mcpEnv}", "enabled": true } },
        "instructions": ["{sessionDir}/sikeoop.md"],
        "plugin": ["{sessionDirUrl}/sikeoop-plugin.js"],
        "permission": { "edit": "ask", "bash": "ask" }
      }
    }
  },
  "envPassthrough": ["OPENCODE_*", "ANTHROPIC_*", "OPENAI_*", "GEMINI_*", "GOOGLE_*", "OPENROUTER_*", "AWS_*", "AZURE_*"],
  "files": [
    { "path": "sikeoop.md", "content": "{instructions}\n" },
    { "path": "sikeoop-plugin.js", "content": "…见下…" }
  ],
  "turnEnd": "hook"
}
```

它用到的手法：

- `OPENCODE_CONFIG_CONTENT` 是 opencode 的“内联配置”环境变量，会**合并**到用户自己的配置上，只对这一次启动生效，不改用户的任何文件。
- `"command": "{mcpCommand}"` 整串是一个占位符，所以变成数组——opencode 的 MCP 配置正好要数组。
- 指令和插件都写在 `{sessionDir}`，再在配置里指过去。
- 插件（`sikeoop-plugin.js`）负责上报，核心部分：

```js
const HOOK = {json:hookUrl};
const post = (body) =>
  fetch(HOOK, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
    .then((r) => r.json()).catch(() => ({}));

export const Sikeoop = async ({ directory }) => ({
  event: async ({ event }) => {
    if (event.type === "session.idle") await post({ event: "turn-end", text: last });
    if (event.type === "permission.asked") await post({ event: "waiting", text: "等你在终端里批准" });
  },
  "tool.execute.before": async (input, output) => {
    const file = output.args.filePath;
    const answer = await post({ event: "tool", tool: input.tool, write: WRITES.has(input.tool), file, cwd: directory });
    if (answer.decision === "deny") throw new Error(answer.reason);
  },
});
```

验证情况（opencode 1.18.30，2026-10-11）：

- `OPENCODE_CONFIG_CONTENT` 里的 `mcp`、`instructions`、`plugin`、`permission` 会合并进最终配置（`opencode debug config` 核实）。
- 插件在 `opencode run` 里用免费模型实际跑过：`turn-start`、`tool`（带 `write` 和文件路径）、`turn-end`（带最后一条回复）三种上报都收到了；会话目录路径里带空格也正常。
- 没有在 sikeoop 窗口里的交互界面（TUI）下逐项核对过，`permission.asked` 的上报也没触发过。

---

## 9. 例子：Cursor CLI（草稿，未验证）

下面是按 Cursor 官方文档写的起点，**没有在装了 Cursor CLI 的机器上试过**：

```json
{
  "id": "cursor",
  "name": "Cursor CLI",
  "label": "Cursor",
  "description": "Cursor 的命令行 Agent",
  "bin": ["agent", "cursor-agent"],
  "install": "curl https://cursor.com/install -fsS | bash",
  "args": ["--workspace", "{root}"],
  "envPassthrough": ["CURSOR_*"],
  "turnEnd": "quiet",
  "quietMs": 12000,
  "notes": ["Cursor CLI 目前只能接收任务，不能主动给别的会话发消息。"]
}
```

已知的坎：

- Cursor 的 MCP 和 hook 配置只从项目的 `.cursor/` 或用户的 `~/.cursor/` 读，而扩展不能往这两处写文件，所以上面用的是 `quiet` 模式，也没有接 `send_to`。
- 想接完整，可以自己在 `~/.cursor/hooks.json` 里配一个 `stop` hook，内容是第 4 节那条 curl（用 `$SIKEOOP_HOOK_URL`，不在 sikeoop 里运行时这个变量为空，curl 会直接失败，不影响平时使用），然后把定义改成 `"turnEnd": "hook"`。

---

## 10. 排查

| 现象 | 先看什么 |
|---|---|
| 灵动岛上看不到它，别的 AI 也找不到它 | 它是不是从「+」菜单开的。**在普通终端标签里直接敲 `opencode` 不算**：那只是你自己运行了一个程序，sikeoop 没有机会给它接上 MCP 和状态上报。 |
| 「+」菜单里没有 | 菜单底部有没有“xxx.json 没有加载”；鼠标停上去看原因。 |
| 显示“还没有安装” | `bin` 里的名字在终端里能不能直接运行；装在特殊位置就加 `paths`。 |
| 一直“启动中” | CLI 没连上 MCP，也没发 `ready`。看 CLI 自己的 MCP 状态；或先改成 `quiet` 确认其他部分没问题。 |
| 一直“在干活”，任务不结束 | `turn-end` 没发出来。在终端里手动跑第 4 节的 curl（把地址换成会话目录里文件中的实际地址），会话应该立刻变空闲——能变，说明问题在 CLI 那一侧的 hook / 插件。 |
| 找不到 API key | 第 6 节，`envPassthrough`。 |
| 想看最终生成了什么 | 会话专属目录：`<sikeoop 数据目录>/workspace-mode/cli-agents/<id>/<会话 id>/`，`files` 写的东西都在里面。 |

---

## 11. 安全须知

- **一个定义就是一条以你的身份运行的命令。** 只用自己写的、或信得过来源的定义文件。
- sikeoop 只从扩展目录读定义，**不会**从项目目录读——打开别人的仓库不会让它得到运行命令的机会。
- 对扩展 CLI，sikeoop **不加沙盒，也不加权限规则**（内置的 Claude Code / Codex 有）。它能读写什么、运行命令要不要先问，全看它自己的配置和你在 `args` / `env` 里给的设置。建议像内置的 opencode 定义那样，把“改文件、运行命令前先问”配上。
- 状态上报地址只监听本机，每个会话一个随机令牌。

---

## 12. 目前的限制

- 扩展 CLI 只能开在普通终端标签里。**跨项目 session 的“拉入 AI”只有 Claude Code 和 Codex。**
- sikeoop 主对话的 `start_agent` 工具只会新开 Claude Code / Codex。已经开着的扩展会话可以用 `send_to_agent` 派活。
- `files` 只能写会话专属目录（第 3 节）。
- Windows 上 npm 装的 CLI 通常是 `.cmd` 垫片，带复杂参数（JSON）时可能被 cmd 重新解析出错；遇到时在 `paths` 里直接指向真正的可执行文件。
- 回归面板按 Claude / Codex 两家对比结果，不包含扩展 CLI。
