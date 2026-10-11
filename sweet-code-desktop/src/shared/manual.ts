// The beginner's manual: what sikeoop can do, where to find it, and the touches made for Chinese
// users. One source for the in-app help panel (HelpCenter.tsx) and the website's manual page.
// Written for someone who has never programmed: plain words, the place to click, one example.

/** Where "带我去" goes: a screen, a panel, or a tour chapter. */
export type ManualGo =
  | "start"
  | "work"
  | "studio"
  | "wiki"
  | "graph"
  | "group"
  | "automation"
  | "cluster"
  | "usage"
  | "partners"
  | "resources"
  | "plugins"
  | "android"
  | "context"
  | "settings"
  | "tour-start"
  | "tour-work";

export interface ManualItem {
  id: string;
  title: string;
  body: string;
  /** Where it is in the app, in words. */
  where?: string;
  /** An example: something to type or try. */
  try?: string;
  go?: ManualGo;
  /** Extra words for the search box. */
  keys?: string;
}

export interface ManualSection {
  id: string;
  title: string;
  intro: string;
  items: ManualItem[];
}

export const MANUAL: ManualSection[] = [
  {
    id: "begin",
    title: "第一步",
    intro: "装好以后，三分钟就能让 AI 帮你写出第一个页面。",
    items: [
      {
        id: "project",
        title: "打开或新建一个项目",
        body: "项目就是电脑上的一个文件夹，你的代码都放在里面。已经有代码就「打开项目」；从零开始就「新建项目」，选一个空文件夹。AI 只能读写这个文件夹里的东西。",
        where: "首页 → 打开项目 / 新建项目",
        go: "start",
        keys: "文件夹 新建 打开",
      },
      {
        id: "partner",
        title: "选一位伙伴",
        body: "每位伙伴对应一个 AI 模型。国内的 DeepSeek、通义千问、Kimi、智谱、豆包、MiniMax、小米 MiMo 都能直接连上。用哪个服务商，就去那家官网申请一个 Key 填进来。",
        where: "标题栏右上角的伙伴头像，或左边栏「全部伙伴」",
        go: "settings",
        keys: "模型 key api 密钥 换模型",
      },
      {
        id: "first-chat",
        title: "说出你想做什么",
        body: "在右边的对话框里用大白话说就行，不用懂术语。说得越具体越好：给谁用、长什么样、要有哪些按钮。",
        where: "打开项目后，右边的对话栏",
        try: "帮我做一个记账网页，能记每天花了多少钱，按月份看总数",
        go: "work",
        keys: "对话 聊天 提问",
      },
      {
        id: "tour",
        title: "重看新手教程",
        body: "第一次打开时的引导可以随时重看：首页一段，项目里一段。",
        go: "tour-start",
        keys: "教程 引导 新手",
      },
    ],
  },
  {
    id: "work",
    title: "让 AI 干活",
    intro: "AI 会读文件、改代码、跑命令。做每件事之前，都先让你看到。",
    items: [
      {
        id: "diff",
        title: "改动卡片：先看再同意",
        body: "AI 想改文件时，对话里会出现一张卡片：红色是删掉的，绿色是新加的，改了的那几个字单独高亮，下面一句话说明为什么改。点「同意」才真的写进文件，点「不要」它会换个做法。想看整个文件，点「左右对比」。",
        where: "对话里的改动卡片",
        keys: "diff 修改 同意 拒绝 对比",
      },
      {
        id: "command",
        title: "命令也先问你",
        body: "装依赖、跑测试之前，它会说清楚这条命令是干嘛的。会删文件、会推送到网上的命令会额外标出提醒。",
        keys: "命令 终端 npm 安装",
      },
      {
        id: "undo",
        title: "改坏了，整轮撤销",
        body: "每一轮对话改了哪些文件都记着。不满意就点那一轮下面的「撤销」，所有文件回到改之前，不用会 Git。",
        where: "每轮回答末尾的「改了 N 个文件」",
        keys: "撤销 回退 恢复",
      },
      {
        id: "modes",
        title: "四种工作方式",
        body: "输入框左下角切换。Agent：每一步都问你，适合刚开始学。长任务：交代完去忙，「审批小助手」代你把关，拿不准的还是叫你。懒人：完全自己做，不再问你，危险命令（sudo、删项目外的文件、改系统设置、推送发布）会被自动拦下。超级调度：AI 只当指挥官，把任务拆开派给终端里的 Claude Code / Codex 和已配置好的模型并行做，自己不动手，同样不再问你；进度在调度台里看。",
        where: "输入框左下角「Agent ▾」",
        keys: "长任务 懒人 超级调度 子代理 编排 自动 autopilot 模式",
      },
      {
        id: "ask-first",
        title: "做新东西前，它会先问你",
        body: "新建项目、加大功能之前，它会先查 npm、PyPI 上候选库的最新版本和下载量，再用一张问题卡片问你几个只有你能定的事。推荐的选项放第一个，拿不准就点「都按推荐来」。",
        keys: "提问 卡片 推荐 技术选型",
      },
      {
        id: "plan",
        title: "看它的计划和进度",
        body: "要好几步才能做完的事，它会先列一份计划清单，做的时候一项项打勾，你随时知道做到哪了。",
        keys: "计划 进度 清单",
      },
      {
        id: "attach",
        title: "截图、文件直接丢进来",
        body: "报错截图、设计稿、PDF、代码文件，粘贴或拖进输入框就行。图片会先由识图模型看一遍，再交给 AI。",
        where: "输入框，或输入框旁边的回形针",
        try: "（拖一张报错截图进来）这是什么意思？怎么修？",
        keys: "图片 截图 pdf 拖拽 粘贴 识图",
      },
      {
        id: "browser",
        title: "内置浏览器：边改边看",
        body: "做网页时不用切到别的浏览器。点编辑器标签栏右边的地球图标打开，可以和代码左右分屏：左边改，右边马上看到效果。开发服务器一跑起来，它的地址会自动在这里打开。AI 也能用它：看页面、截图、点按钮测交互、读控制台报错。去外部网站点击、填表之前它会先问你；遇到登录它会请你自己登。登录状态、Cookie、访问历史都存在这台电脑上；保存的密码用系统钥匙串加密，只有你点钥匙图标时才会填入，AI 看不到。地址栏直接打字就是用必应搜索，可以在「⋯ → 设置」里换成百度或 Google。",
        where: "编辑器标签栏右边的地球图标",
        try: "打开 localhost:5173 看看首页，按钮点了有没有反应，控制台有没有报错",
        go: "work",
        keys: "浏览器 预览 网页 localhost 分屏 cookie 密码 历史 控制台 调试",
      },
      {
        id: "md-preview",
        title: "Markdown 文件看排版好的样子",
        body: "打开 .md 文件（比如 README.md、AI 写的说明文档），文件路径那一行右边可以切换「源码 / 分栏 / 预览」：预览显示排好版的标题、表格、清单和流程图，分栏就左边改右边马上看到。文档里的相对链接点一下就在编辑器里打开那个文件。选过一次以后，别的 .md 文件也按这个方式显示。",
        where: "打开 .md 文件后，编辑器顶部路径栏的右边",
        keys: "markdown md 预览 渲染 readme 文档 排版",
      },
      {
        id: "terminal",
        title: "终端",
        body: "开发服务器这种一直运行的命令，AI 会写在代码块里，点「在终端运行」就在下面的终端里跑起来。Windows 上命令统一在 Git Bash 里运行。",
        where: "编辑器下方的终端面板",
        keys: "终端 terminal bash 运行",
      },
    ],
  },
  {
    id: "memory",
    title: "让 AI 更懂你",
    intro: "它会记住你的习惯和项目的约定，下次不用再说一遍。",
    items: [
      {
        id: "remember",
        title: "长期记忆",
        body: "你说「以后注释都用中文」，它会记下来，以后每次新对话都带上。聊完空闲 10 分钟，它会把最近几次对话里值得记的整理进来：只提过一次的先放着，再提到才记；和旧记忆矛盾的，等你选。很久不用的记忆会放进归档，需要时还能找回来。",
        where: "左边栏的大脑图标「记忆与代码索引」",
        try: "记住：我喜欢简洁的界面，按钮都用圆角",
        go: "context",
        keys: "记忆 记住 偏好 忘记 归档",
      },
      {
        id: "recent",
        title: "接着上次做",
        body: "在同一个项目里开新对话，它会先看上次对话的摘要（7 天内的），知道上次做到哪、还剩什么没做。",
        try: "接着上次没做完的继续",
        keys: "上次 继续 摘要",
      },
      {
        id: "rules",
        title: "项目规则",
        body: "项目里放一个 AGENTS.md 或 CLAUDE.md，写上「用 Vue 写」「不要动 config 文件夹」这类规则，AI 每次都会照做。",
        go: "context",
        keys: "规则 agents.md claude.md 约定",
      },
      {
        id: "index",
        title: "自动找相关代码",
        body: "项目大了也不怕：每条消息发出前，它会在代码索引里找出可能相关的几段代码一起给 AI，省得它到处翻文件。",
        where: "「记忆与代码索引」→ 代码索引",
        go: "context",
        keys: "索引 rag 搜索代码",
      },
    ],
  },
  {
    id: "tools",
    title: "项目工具",
    intro: "写代码之外，帮你看懂、整理、展示一个项目。",
    items: [
      { id: "wiki", title: "项目百科", body: "AI 读完整个项目，写一份说明书和架构图。接手别人的代码时特别有用。", where: "左边栏「项目百科」", go: "wiki", keys: "文档 说明书 架构图 wiki" },
      { id: "graph", title: "知识图谱", body: "把项目代码或开发文档拆成节点和关系图，一眼看清谁调用了谁。", where: "左边栏「知识图谱」", go: "graph", keys: "图谱 关系 依赖" },
      { id: "studio", title: "原型工坊", body: "还没想好界面长什么样？先在这里让 AI 画几屏可点击的原型，满意了再写成真代码。", where: "左边栏「原型工坊」", go: "studio", keys: "原型 设计 界面 草图" },
      { id: "archive", title: "归档项目", body: "做完的项目打包成一个 zip 存起来，以后解压就能接着做。", where: "左边栏「归档项目」", keys: "打包 zip 备份" },
      { id: "android", title: "Android 模拟器", body: "做手机 App 时，在 sikeoop 里直接打开模拟器看效果。", where: "左边栏「Android 模拟器」", go: "android", keys: "安卓 手机 app 模拟器" },
    ],
  },
  {
    id: "extend",
    title: "装技能、接工具",
    intro: "让 AI 学会新本事，比如做 PPT、读 Excel、按某种风格写代码。",
    items: [
      { id: "resources", title: "资源库：一键安装", body: "挑好的技能和工具，点一下就装上。", where: "左边栏礼物图标「资源库」", go: "resources", keys: "技能 skill 安装 资源" },
      { id: "skillhub", title: "SkillHub 技能商店", body: "国内的技能商店（skillhub.cn），社区上传的技能都能搜到。装之前会先做安全审核：规则扫一遍，再让 AI 读一遍，查有没有藏着恶意指令。高风险的只有你本人能决定装不装。", where: "资源库 → SkillHub", go: "resources", keys: "skillhub 商店 审核 安全" },
      { id: "plugins", title: "插件：技能和 MCP", body: "管理已经装的技能，连接 MCP 服务器（让 AI 能操作数据库、浏览器等外部工具）。", where: "左边栏「插件」", go: "plugins", keys: "mcp 插件 扩展" },
    ],
  },
  {
    id: "team",
    title: "多位 AI 一起干",
    intro: "一个 AI 不够用时。",
    items: [
      { id: "group", title: "Agent 群聊", body: "拉几位不同模型的伙伴进一个群，让它们一起讨论一个方案，你看着它们吵完再拍板。", where: "左边栏「Agent 群聊」", go: "group", keys: "群聊 讨论 多模型" },
      { id: "automation", title: "自动化", body: "按时间表自动跑的任务，比如每天早上检查一遍依赖有没有安全更新。", where: "左边栏时钟图标「自动化」", go: "automation", keys: "定时 计划任务 自动" },
      { id: "cluster", title: "鸿蒙集群", body: "做鸿蒙应用时，把任务分派给几个专门的子代理（写 ArkTS、写测试、查规范），在控制台里看它们各自的进度。", where: "左边栏「鸿蒙集群」", go: "cluster", keys: "鸿蒙 harmony 子代理 集群" },
      { id: "regress", title: "测试与回归", body: "让终端里的 Claude Code、Codex 帮你检查功能有没有改坏。用法：先选一个空闲的会话，点「生成」让它列出值得检查的功能点，勾选后入库；再选几条点「执行」，AI 会逐条验证并给出通过或失败；觉得满意时存一个「基线」，以后改完代码再和基线对比，变红的就是回归。注意：AI 的结论仅供参考，不一定对，可以点「查看原文」自己看，也可以手动改判。点取消只是不再等结果，不会打断那个会话正在做的事。数据存在项目里的 .sikeoop/ 文件夹，要不要提交到 git 由你自己决定。", where: "左边栏「测试与回归」", keys: "测试 回归 基线 验证 检查 claude codex" },
      { id: "palette", title: "快速打开和命令面板", body: "按 ⌘P（Windows 是 Ctrl+P）输入文件名的几个字母就能打开文件，最近打开的排在前面；输入 :行号 跳到那一行。按 ⌘⇧P（Ctrl+Shift+P）打开命令面板，sikeoop 的每个页面和常用操作都能在这里找到，支持拼音和拼音首字母，比如输入 sj 就能找到「手机」。", where: "任何地方按快捷键", keys: "命令面板 快速打开 快捷键 ctrl+p 搜索文件 拼音" },
      { id: "peers", title: "让 Claude Code 和 Codex 互相发消息", body: "在 sikeoop 的终端里开着 Claude Code、Codex 时，它们能互相看到、互相留言，分工做一件事。", where: "终端面板", keys: "claude code codex 终端 协作" },
    ],
  },
  {
    id: "anywhere",
    title: "随手就能用",
    intro: "不在 sikeoop 窗口里时也能用。",
    items: [
      { id: "island", title: "灵动岛", body: "屏幕顶部正中的小胶囊，显示 AI 正在做什么、做完没有。切到别的窗口也能看到。", keys: "灵动岛 状态 顶部" },
      { id: "snip", title: "随手截图问 AI", body: "Mac 上在同一个地方快速点四下，Windows 上按鼠标侧键，就能框选屏幕任意一块截图，直接问 AI。", keys: "截图 手势 侧键" },
      { id: "dictation", title: "按住说话", body: "Mac 按住右边的 Option，Windows 按住右边的 Ctrl，说完松手，说的话会变成文字打进当前的输入框，任何软件里都行。用小米 MiMo 的语音识别，中文识别得准。", keys: "语音 听写 说话 输入" },
      { id: "background", title: "关窗口不停工", body: "关掉窗口只是缩到托盘（Mac 是菜单栏），长任务照样在跑；需要你的时候会弹系统通知。", keys: "后台 托盘 通知" },
    ],
  },
  {
    id: "money",
    title: "花了多少",
    intro: "心里有数。",
    items: [
      { id: "usage", title: "用量统计", body: "每天用了多少 token、花了多少钱，按模型分开看。", where: "左边栏「用量统计」", go: "usage", keys: "用量 token 费用 账单" },
      { id: "cache", title: "缓存命中率", body: "底部状态栏显示这段对话有多少内容命中了缓存。命中的部分价格很低，命中率越高越省钱。缓存不该断却断了时，会变成橙色提醒你。", where: "底部状态栏", keys: "缓存 省钱" },
    ],
  },
];

/** The touches made for Chinese users, already in the app. */
export const CN_TOUCHES: { title: string; body: string }[] = [
  { title: "全中文，说大白话", body: "界面、提示、AI 的回答都是简体中文。术语非用不可时，顺手用一句话解释。" },
  { title: "国产模型直接连", body: "DeepSeek、通义千问、Kimi、智谱 GLM、豆包、MiniMax、小米 MiMo 都内置了接入方式，填 Key 就能用，不用折腾网络。" },
  { title: "按人民币算钱，分峰谷", body: "用 DeepSeek 时，费用直接按人民币显示，而且按北京时间区分高峰和闲时价格，闲时写代码更便宜。" },
  { title: "国内的技能商店", body: "接入了 SkillHub（skillhub.cn），国内能直接搜、直接装，装之前自动做安全审核。" },
  { title: "中文语音输入", body: "按住说话，用小米 MiMo 的语音识别，普通话识别准，说完自动打进输入框。" },
  { title: "鸿蒙开发", body: "认识 ArkTS（.ets 文件），配好 DevEco Studio 的 SDK 后有代码提示；还有专门的鸿蒙子代理集群。" },
  { title: "微信小程序文件", body: "认识 .wxml、.wxss 文件，在文件树里有对应的图标，一眼分得清。" },
  { title: "Windows 上命令不出错", body: "命令统一在 Git Bash 里运行，AI 写的命令在 Windows 和 Mac 上是同一套写法。" },
];
