/** Left in the extension folder the first time it is opened from the terminal's menu. */
export const EXTENSION_README = `# sikeoop 的 CLI 扩展目录

这里每个 .json 文件描述一个编程 CLI（比如 Cursor CLI、Gemini CLI），sikeoop 的终端就能把它
当成 AI 会话来开：出现在「+」菜单里，能和 Claude Code / Codex 互相发消息，能被主对话派活。

- 改完文件不用重启 sikeoop，下次点「+」就会重新读。
- 文件有错时不会被加载，「+」菜单底部会说哪里不对。
- 只放你信得过的定义：一个定义就是一条会以你的身份运行的命令。

格式、占位符、状态上报协议和完整例子，见 sikeoop 仓库里的 docs/cli-扩展开发文档.md。

最小的例子（把它存成 mycli.json）：

{
  "id": "mycli",
  "name": "My CLI",
  "label": "MyCli",
  "bin": ["mycli"],
  "args": [],
  "turnEnd": "quiet"
}
`;
