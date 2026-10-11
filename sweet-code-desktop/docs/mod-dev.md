# sikeoop Mod 开发指南

Mod 是给 sikeoop 写的扩展：给 AI 加工具、在对话各环节插手、调用模型、在灵动岛上发通知。用户在「插件中心 → Mod」里安装。

> Mod 的 JS 跑在 sikeoop 主进程里，和 sikeoop 本身权限一样。`permissions` 是你对用户的声明：
> 通过 `api` 做的事会按它检查，但 Node 自带的 `fs`、`child_process` 等管不住。请如实声明，用户会在安装前看到。

## 最小的 mod

```
my-mod/
  mod.json
  index.js
```

`mod.json`：

```json
{
  "id": "my-mod",
  "name": "我的 Mod",
  "version": "1.0.0",
  "description": "一句话说明它做什么",
  "author": "你的名字",
  "main": "index.js",
  "permissions": ["tools"],
  "minAppVersion": "0.3.0"
}
```

`index.js`（CommonJS）：

```js
exports.activate = (api) => {
  api.tools.register({
    name: "hello",
    description: "Say hello to someone.",
    inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
    permission: "auto",
    run: (input) => `你好，${input.name}！`,
  });
};
```

完整示例见 `examples/mods/word-count/`。类型定义见 `docs/sikeoop-mod.d.ts`：复制到你的 mod 里，再在 JS 里加 `/** @param {import("./sikeoop-mod").SikeoopModApi} api */`，就有自动补全。

## mod.json 字段

| 字段 | 必填 | 说明 |
|---|---|---|
| `id` | 是 | 小写字母、数字、`-`，2–41 个字符，全局唯一 |
| `name` | 是 | 显示名 |
| `version` | 是 | `x.y.z` |
| `description` | | 一句话介绍 |
| `author` / `homepage` | | 作者和主页 |
| `main` | | 入口文件，默认 `index.js` |
| `permissions` | 是 | 见下表，没有就写 `[]` |
| `minAppVersion` | | 最低 sikeoop 版本 |

## 权限

| 权限 | 解锁的 API | 用户看到的说明 |
|---|---|---|
| `tools` | `api.tools.register` | 给 AI 添加工具 |
| `hooks` | `api.hooks.on` | 在对话各环节插手 ⚠ |
| `model` | `api.model.complete` | 用你的模型和 Key 调用 AI |
| `notify` | `api.notify` | 在灵动岛上显示通知 |
| `network` | （声明用） | 访问网络 ⚠ |
| `fs` | （声明用） | 读写你电脑上的文件 ⚠ |
| `shell` | （声明用） | 在你电脑上运行命令 ⚠ |

调用没声明的 API 会抛错。`network` / `fs` / `shell` 没有对应 API，用 Node 自带模块实现，但必须声明。

## API

- `api.tools.register(tool)`：AI 看到的工具名是 `mod__<id>__<name>`。`permission: "confirm"`（默认）会先给用户看参数，用户同意了才运行；只有只读工具才用 `"auto"`。`run` 返回字符串，会作为结果交给 AI，超过 10 万字会被截断。
- `api.hooks.on(event, handler)`：事件有 `SessionStart`、`UserPromptSubmit`、`PreToolUse`、`PostToolUse`、`Stop`。handler 可以返回：
  - `context`：给 AI 的补充信息
  - `notice`：在对话里给用户看的一行字
  - `permission`（只用于 `PreToolUse`）：`allow` / `ask` / `deny`
  - `block`：拦下这条消息（UserPromptSubmit），或让 AI 接着干（Stop）
- `api.model.complete(system, user, { maxTokens })`：用用户当前的模型调用一次，最多 8000 tokens。
- `api.notify(text, detail)`：在灵动岛上发一条通知。
- `api.storage.get(key)` / `await api.storage.set(key, value)`：这个 mod 自己的 JSON 存储，删除 mod 时一起删除。
- `api.workspace.root()`：当前打开的项目文件夹，没打开时是 `""`。
- `api.log(...)`：输出到 sikeoop 的主进程日志，带 `[mod <id>]` 前缀。
- `api.onDispose(fn)`：mod 关闭、重载或删除时调用，用来清理定时器、连接等。也可以导出 `deactivate()`。

## 开发流程

1. 插件中心 → Mod → **开发者：链接文件夹**，选你的 mod 目录。文件不复制，直接从原位置加载。
2. 改完代码，点这个 mod 的 ↻ 按钮重新加载。工具的增减从下一个新对话开始生效，hook 立即生效。
3. 报错会显示在这个 mod 下面。完整日志在启动 sikeoop 的终端里（`npm run dev`）。

## 发布

把 mod 文件夹打成 zip，外面套一层文件夹也可以。用户用「从压缩包安装」安装。

安装时 sikeoop 会记下所有文件的指纹。之后文件如果被改动，这个 mod 就不再加载，直到用户重新确认。所以要升级，就发新的 zip，让用户重新安装。

## 兼容性

`api.apiVersion` 目前是 `1`。版本号不变，就只会新增接口，不会删除或修改已有接口。
