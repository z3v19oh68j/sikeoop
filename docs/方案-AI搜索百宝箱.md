# 方案：AI 搜索百宝箱

日期：2026-10-11　状态：方案稿，等用户确认后拆任务
一句话：把市面上的 AI 搜索 / AI 问答网站收进一个页面，点一下就在内置浏览器里打开；输入一次问题，可以同时发给多家对比。

---

## 1. 建在现有内置浏览器上

已有 `src/main/browser/service.ts` + `BrowserPane.tsx`：`<webview>`、独立持久会话 `persist:sikeoop-browser`（登录状态重启后还在）、历史、钥匙串加密的密码保存。百宝箱直接复用，不新开浏览器内核。

- 用 `<webview>` 打开，不用 iframe：大多数站点禁止被 iframe 嵌入，webview 是独立页面，不受影响。
- 每个站点用户**自己登录**，sikeoop 不代登录、不存别家的 Key、不抓取或转发对方内容。
- 只做“打开网址 + 把问题填进网址参数”。不支持网址带问题的站点，就打开首页，把问题复制到剪贴板提示粘贴。

## 2. 界面

新页面「百宝箱」（侧栏「工具」书签堆）：
- 顶部一个大输入框 +「发给：」勾选几家（默认 3 家，可存成组合，如“国内三家”“学术三家”）。
- 下面是站点卡片墙，按分类分区，每张卡：图标、名字、一句话特点、是否免登录、国内能否直连。可收藏、拖动排序、隐藏。
- 对比模式：勾选的几家并排分栏打开（2–4 栏），各自独立滚动。
- 「自定义添加」：填名字 + 网址模板（`{q}` 为问题占位）。

## 3. 站点清单（首版）

> 网址模板是否支持 `{q}` 需逐个实测，标 ? 的为待核；不支持的退回“打开首页 + 复制问题”。

**国内 AI 搜索**
| 名称 | 地址 | 问题参数 |
|---|---|---|
| 秘塔 AI 搜索 | https://metaso.cn | `?q={q}` ? |
| 纳米 AI 搜索（360） | https://www.n.cn | ? |
| 百度 AI 搜索 | https://chat.baidu.com | ? |
| 天工 AI | https://www.tiangong.cn | ? |
| 夸克 AI | https://www.quark.cn | ? |
| 知乎直答 | https://zhida.zhihu.com | ? |
| Bing（中国） | https://cn.bing.com | `/search?q={q}`（已有） |

**国内 AI 助手（带联网搜索）**
| 名称 | 地址 | 问题参数 |
|---|---|---|
| DeepSeek | https://chat.deepseek.com | 无，复制粘贴 |
| Kimi | https://www.kimi.com | `?q={q}` ? |
| 豆包 | https://www.doubao.com/chat | ? |
| 通义 | https://www.tongyi.com | ? |
| 腾讯元宝 | https://yuanbao.tencent.com | ? |
| 智谱清言 | https://chatglm.cn | ? |
| 文心一言 | https://yiyan.baidu.com | ? |
| 小米 MiMo | 待核 | ? |
| MiniMax（海螺） | https://hailuoai.com | ? |

**海外 AI 搜索**
| 名称 | 地址 | 问题参数 |
|---|---|---|
| Perplexity | https://www.perplexity.ai | `/search?q={q}` |
| Google AI 模式 | https://www.google.com | `/search?q={q}&udm=50` ? |
| ChatGPT 搜索 | https://chatgpt.com | `/?q={q}&hints=search` ? |
| Microsoft Copilot | https://copilot.microsoft.com | `/?q={q}` ? |
| Gemini | https://gemini.google.com | 无，复制粘贴 |
| Claude | https://claude.ai/new | `?q={q}` ? |
| Grok | https://grok.com | `?q={q}` ? |
| Brave Search（AI 摘要） | https://search.brave.com | `/search?q={q}` |
| Kagi | https://kagi.com | `/search?q={q}`（需订阅） |
| You.com | https://you.com | `/search?q={q}` ? |
| Felo | https://felo.ai | `/search?q={q}` ? |
| Genspark | https://www.genspark.ai | ? |
| Phind（编程） | https://www.phind.com | `/search?q={q}` ? |
| Mistral Le Chat | https://chat.mistral.ai | `?q={q}` ? |
| DuckDuckGo AI | https://duck.ai | ? |

**学术 / 专业**
| 名称 | 地址 | 问题参数 |
|---|---|---|
| Consensus | https://consensus.app | `/results/?q={q}` ? |
| Elicit | https://elicit.com | ? |
| SciSpace | https://scispace.com | ? |
| Semantic Scholar | https://www.semanticscholar.org | `/search?q={q}` |
| 秘塔学术 | https://metaso.cn | 学术模式 ? |
| 知网 AI | https://www.cnki.net | ? |

**开发者**
| 名称 | 地址 | 问题参数 |
|---|---|---|
| Phind | 同上 | |
| DeepWiki | https://deepwiki.com | 仓库路径 |
| Context7 | https://context7.com | ? |
| GitHub Copilot Chat | https://github.com/copilot | ? |

清单做成 JSON 随应用发布（`resources/ai-search/sites.json`），以后版本更新清单；用户的收藏、排序、自定义站点存在本地。

## 4. 让 AI 也能用（第二批）

- 给内置 AI 加一个工具 `ai_search_compare(question, sites)`：在百宝箱里打开几家，等页面出结果后用现有的浏览器快照读回正文，汇总成对比表。
- 读到的网页内容一律当资料，不照做（和现有浏览器规则一致）。
- 默认关闭，每次调用要用户点头（会用到用户在这些站的账号额度）。

## 5. 边界

- 不绕过登录、验证码、付费墙；不批量自动提问刷别家额度。
- 不内置任何站点的私有 API 或逆向接口，只开网页。
- 站点图标优先用 favicon 实时取，不打包别家商标图片。
- 某站点打不开（被墙、关停），卡片显示“打不开”，不影响别的。

## 6. 分批

- **第一批**：站点清单 JSON（含实测过的 `{q}` 模板）+ 百宝箱页面 + 一键发给多家 + 并排对比 + 自定义站点。
- **第二批**：组合预设、AI 工具 `ai_search_compare`、结果汇总。

## 7. 派活建议

- 站点清单实测（逐个核网址和问题参数）→ 空闲的终端 Claude Code
- 页面、卡片墙、并排对比 → ui-engineer
- 清单加载、多 webview 会话、AI 工具 → Codex

## 8. 要你决定

1. 放正式版还是先只在开发版？（建议正式版：建在已有浏览器上，风险小）
2. 清单是否就按上面这些，还是要增删？
3. 第二批让 AI 读别家结果做汇总，要不要做？
