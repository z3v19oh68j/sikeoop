import type { AuditCategory, AuditFinding, AuditLevel, SkillAudit } from "@shared/types";

// Rule scan of a skill before it is installed. A skill is instructions the agent will follow
// plus files it may run, so the scan looks for what a malicious one would contain: instructions
// aimed at the agent (ignore your rules, keep this from the user), turning off confirmations,
// sending secrets out, wiping data, downloading and running code, starting itself on login,
// and hiding any of that (invisible characters, encoded payloads, comments).
//
// Rules err towards flagging: a finding is shown to the user, not acted on, and the AI review
// (skill-review.ts) reads the files for what patterns can't see. Documentation that merely
// quotes a dangerous command will be flagged too; the excerpt lets the user judge.

type Files = Map<string, Uint8Array>;

interface Rule {
  id: string;
  severity: AuditFinding["severity"];
  category: AuditCategory;
  title: string;
  re: RegExp;
  /** Only in instruction files (SKILL.md and other Markdown), where text is read by the agent. */
  docsOnly?: boolean;
  /**
   * In documentation, one level lower when the line warns against it ("do not…", "if a file tries
   * to 'ignore previous instructions', flag it"): skills that teach safe habits quote the bad thing.
   */
  quotable?: boolean;
}

const RULES: Rule[] = [
  // ---- instructions aimed at the agent ----
  {
    id: "ignore-instructions",
    quotable: true,
    severity: "high",
    category: "injection",
    title: "要求 AI 忽略原有的指令或规则",
    re: /\b(ignore|disregard|forget|override)\s+(all\s+|any\s+)?(of\s+)?(your\s+|the\s+)?(previous|prior|above|earlier|other|original|system)\s+(instructions?|rules?|prompts?|guidelines?|directives?)|忽略(掉)?(之前|以上|前面|先前|上面|原有|所有|其他|系统)(的)?(所有)?(指令|指示|规则|提示词?|要求|设定)/i,
  },
  {
    id: "hide-from-user",
    severity: "high",
    category: "injection",
    title: "要求 AI 瞒着用户",
    re: /\b(do\s*n[o']?t|never|without)\s+(tell(ing)?|inform(ing)?|mention(ing)?|show(ing)?|reveal(ing)?|notify(ing)?|let(ting)?)\s+(this\s+|it\s+)?(to\s+)?(the\s+)?(user|human|operator)\b|(silently|secretly|covertly)\s+(run|execute|send|upload|install|delete|modify)|(不要|别|切勿|禁止|不得|不能)(向|跟|对)?(用户|使用者|人类|主人)(透露|告知|说明|提起|显示|展示)|(不要|别|切勿|禁止|不得)(告诉|告知|让)(用户|使用者)(知道)?|(悄悄|偷偷|暗中|静默)(地)?(执行|运行|发送|上传|安装|删除|修改)/i,
  },
  {
    id: "jailbreak",
    quotable: true,
    severity: "high",
    category: "injection",
    title: "试图让 AI 进入“无限制”模式",
    re: /\byou\s+are\s+now\s+(in\s+)?(developer|DAN|jailbr\w*|unrestricted|god)\s*mode|\bdo\s+anything\s+now\b|(你现在|从现在起你)(是|处于|进入)?(开发者|越狱|无限制|不受限制)模式/i,
  },
  {
    id: "leak-prompt",
    quotable: true,
    severity: "high",
    category: "injection",
    title: "要求 AI 泄露系统提示词或对话内容",
    re: /\b(reveal|print|output|send|upload|leak|exfiltrate)\s+(your\s+|the\s+)?(full\s+|entire\s+)?(system\s+prompt|instructions|conversation\s+history|chat\s+history)|(泄露|输出|打印|发送|上传)(你的|完整的|全部)?(系统提示词?|对话记录|聊天记录)/i,
  },
  {
    id: "bypass-approval",
    quotable: true,
    severity: "high",
    category: "approval-bypass",
    title: "试图关闭确认、权限或沙箱",
    re: /--dangerously-skip-permissions|--yolo\b|\bbypass\s+(the\s+)?(permission|approval|confirmation|sandbox|safety)|\b(auto[-_ ]?approve|approve\s+all)\s+(every|all|commands|tool)|(关闭|跳过|绕过|禁用)(所有)?(审批|确认|权限|沙箱|安全检查)|自动(同意|批准|通过)(所有|全部)/i,
  },
  {
    id: "no-confirm",
    severity: "medium",
    category: "approval-bypass",
    title: "要求 AI 不经确认就动手",
    re: /\b(run|execute|install|delete|remove|overwrite|modify|edit|push|commit|deploy|proceed|act|apply)\w*\b[^.\n]{0,40}\bwithout\s+(asking|confirmation|permission|approval|the\s+user)|\bwithout\s+asking\s+(the\s+)?user|\bnever\s+ask\s+(the\s+user\s+)?(for\s+)?(permission|confirmation|approval)|(无需|不用|不必|不要|别)(再)?(询问|征求|请求)(用户)?(的)?(同意|确认|许可|批准)?|(无需|不用|不必)(经过)?(用户|你)?(的)?(确认|同意|批准)/i,
    docsOnly: true,
  },

  // ---- secrets and data leaving the machine ----
  {
    id: "secret-files",
    quotable: true,
    severity: "medium",
    category: "credentials",
    title: "读取密钥、密码或登录信息",
    re: /\.ssh\/(id_\w+|authorized_keys)|\bid_(rsa|ed25519|ecdsa)\b|\.aws\/credentials|\.netrc\b|\.npmrc\b|\.pypirc\b|\.docker\/config\.json|\.kube\/config|\.git-credentials|login\.keychain|security\s+find-(generic|internet)-password|Cookies\.binarycookies|\/(Chrome|Chromium|Brave|Edge)\/[^\s'"]*\/(Cookies|Login Data)|wallet\.dat|metamask|\.gnupg\b/i,
  },
  {
    id: "this-app-secrets",
    severity: "high",
    category: "credentials",
    title: "打 sikeoop 或其他 AI 工具保存的 Key 的主意",
    re: /provider-keys\.bin|Application Support\/(sikeoop|甜心代码屋)|\.claude\/(\.credentials|credentials)|\.codex\/auth\.json|ANTHROPIC_API_KEY|OPENAI_API_KEY|TOKENDANCE_API_KEY/i,
  },
  {
    id: "env-dump",
    quotable: true,
    severity: "medium",
    category: "credentials",
    title: "读取全部环境变量（里面常有 Key）",
    re: /\b(printenv|env)\s*(\||>|$)|JSON\.stringify\(\s*process\.env\s*\)|dict\(\s*os\.environ\s*\)|os\.environ\.items\(\)|Object\.(keys|entries)\(\s*process\.env\s*\)|Get-ChildItem\s+env:/i,
  },
  {
    id: "exfil-endpoint",
    severity: "high",
    category: "exfiltration",
    title: "往常被用来偷数据的地址发东西",
    re: /discord(app)?\.com\/api\/webhooks|hooks\.slack\.com\/services|api\.telegram\.org\/bot|webhook\.site|requestbin|pipedream\.net|ngrok(-free)?\.(io|app|dev)|burpcollaborator|\binteract\.sh\b|\.oast\.(fun|me|pro|live|site|online)|pastebin\.com\/api|transfer\.sh|file\.io\b/i,
  },
  {
    id: "reverse-shell",
    severity: "high",
    category: "remote-code",
    title: "反向连接（让别人远程控制这台电脑）",
    re: /bash\s+-i\s*>&?\s*\/dev\/tcp|\/dev\/tcp\/[\w.-]+\/\d+|\bnc(at)?\s+(-\w+\s+)*-[a-z]*e\s+\/?\w|\bsocat\s+[^\n]*exec:|import\s+socket[^\n]*subprocess|mkfifo\s+\/tmp\/\w+[^\n]*\bnc\b/i,
  },
  {
    id: "pipe-to-shell",
    quotable: true,
    severity: "medium",
    category: "remote-code",
    title: "下载脚本直接运行（curl | bash）",
    re: /\b(curl|wget)\b[^\n|;]*\|\s*(sudo\s+)?(ba|z|da)?sh\b|\biex\s*\(\s*(new-object|iwr|irm|invoke-(webrequest|restmethod))|Invoke-Expression[^\n]*(DownloadString|iwr|irm)/i,
  },
  {
    id: "decode-and-run",
    severity: "high",
    category: "obfuscation",
    title: "把加密 / 编码的内容解开后直接运行",
    re: /base64\s+(-d|--decode|-D)[^\n]*\|\s*(ba|z)?sh\b|\beval\s*\(\s*(atob|Buffer\.from|base64|unescape|String\.fromCharCode)|\bexec\s*\(\s*(base64\.b64decode|zlib\.decompress|codecs\.decode|bytes\.fromhex)|powershell[^\n]*-e(nc(odedcommand)?)?\s+[A-Za-z0-9+/=]{40,}/i,
  },

  // ---- damage and persistence ----
  {
    id: "wipe",
    quotable: true,
    severity: "high",
    category: "destructive",
    title: "删除整个硬盘或用户目录",
    re: /\brm\s+-[a-z]*(rf|fr)[a-z]*\s+(--no-preserve-root\s+)?["']?(\/|~|\$HOME|\/\*|~\/\*|\$HOME\/\*|\/Users|\/home)["']?(\s|$|;|&)|\bmkfs\.\w+|\bdd\s+[^\n]*of=\/dev\/(sd|disk|nvme|hd)|:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:|\bdiskutil\s+(erase|zero)|\bformat\s+[a-z]:|\bdel\s+\/[a-z\s/]*[a-z]:\\\*?|Remove-Item\s+[^\n]*-Recurse[^\n]*(C:\\|\$env:USERPROFILE|~)/i,
  },
  {
    id: "persistence",
    quotable: true,
    severity: "medium",
    category: "persistence",
    title: "设置开机自启，或改 shell 配置文件",
    re: />>?\s*["']?(~|\$HOME)\/\.(bashrc|zshrc|bash_profile|profile|zprofile|zshenv)|\bcrontab\s+(-\w+\s+)*-\s*$|\(crontab\s+-l|LaunchAgents\/|launchctl\s+(load|bootstrap)|systemctl\s+(--user\s+)?enable|schtasks\s+\/create|CurrentVersion\\Run\b/im,
  },
  {
    id: "sudo",
    quotable: true,
    severity: "medium",
    category: "destructive",
    title: "用管理员权限运行或放开权限",
    re: /\bsudo\s+(rm|chmod|chown|curl|wget|bash|sh|python|tee|dd)\b|\bchmod\s+(-R\s+)?(777|a\+rwx)\s+["']?(\/|~)/i,
  },

  // ---- informational ----
  {
    id: "network",
    severity: "low",
    category: "network",
    title: "会联网下载或发送数据",
    re: /\b(curl|wget)\s+\S|requests\.(get|post|put)\(|\bfetch\(\s*["'`]https?:|urllib\.request|axios\.(get|post)|Invoke-WebRequest/i,
  },
];

/**
 * Characters the user can't see but the model reads. Bidi overrides and Unicode "tag" characters
 * (used to smuggle whole sentences) are high; plain zero-width ones also appear in harmless text
 * (escaped code fences, copy-paste), so they're medium unless there are many.
 */
const SMUGGLE = /[\u202A-\u202E\u2066-\u2069]|[\u{E0000}-\u{E007F}]/u;
const ZERO_WIDTH = /[\u200B\u200C\u200E\u200F\u2060-\u2064\uFEFF]|\u200D/gu;
/** ZWJ inside an emoji sequence (👩🏽‍💻) is how those emoji are written. */
const EMOJI_ZWJ = /[\p{Extended_Pictographic}\u{1F3FB}-\u{1F3FF}\uFE0F]\u200D[\p{Extended_Pictographic}]/gu;
/** Words that show a line quotes a bad pattern to warn about it. */
const DEFENSIVE = /\b(do\s*n[o']?t|never|avoid|refuse|reject|flag|detect|watch\s+out|beware|warn|if\s+(a|the|any)\s+\w+\s+(tries|asks|says|contains)|tries\s+to|attempts?\s+to|such\s+as|e\.g\.|for\s+example)\b|不要|禁止|切勿|避免|拒绝|警惕|小心|识别|如果|比如|例如|譬如/i;
/** Quotation marks (not backticks: in Markdown those mark a command to run). */
const QUOTES = /["“”'‘’「」『』]/;
const LONG_BASE64 = /[A-Za-z0-9+/]{240,}={0,2}/;
const HEX_ESCAPES = /(\\x[0-9a-f]{2}){24,}/i;
const COMMENT_WITH_ORDERS = /<!--([\s\S]*?)-->/g;
/** A hidden comment is suspicious when it speaks to the agent and tells it to do something. */
const TO_AGENT = /\b(AI|assistant|agent|claude|gpt|llm|model|system\s+prompt)\b|助手|模型|系统提示|你必须|你要/i;
const ORDER_WORDS = /\b(ignore|disregard|run|execute|curl|wget|upload|send|delete|install|do\s*n[o']?t\s+tell|secretly|silently)\b|忽略|执行|运行|上传|发送|删除|安装|不要告诉|悄悄|偷偷/i;

const BINARY_EXT = /\.(exe|dll|so|dylib|bin|msi|scr|com|app|pkg|dmg|deb|rpm|jar)$/i;
const TEXT_EXT = /\.(md|mdc|txt|json|ya?ml|toml|ini|cfg|conf|sh|bash|zsh|ps1|bat|cmd|py|js|mjs|cjs|ts|tsx|jsx|rb|pl|php|lua|go|rs|java|kt|swift|c|h|cpp|hpp|cs|html?|css|xml|svg|csv|env|cursorrules)$|(^|\/)[^.\/]+$/i;
const DOC_EXT = /\.(md|mdc|txt|cursorrules)$/i;

const MAX_PER_RULE = 3;
const MAX_FINDINGS = 60;

export function auditSkill(files: Files): SkillAudit {
  const findings: AuditFinding[] = [];
  let scanned = 0;
  const add = (f: AuditFinding) => findings.length < MAX_FINDINGS && findings.push(f);

  for (const [file, bytes] of files) {
    if (file === ".sweet.json" || file === "_meta.json") continue;
    if (BINARY_EXT.test(file) || isExecutable(bytes)) {
      add({ severity: "medium", category: "binary", title: "带了可执行程序（看不到里面是什么）", file, excerpt: `${file}（${Math.ceil(bytes.length / 1024)} KB）` });
      continue;
    }
    if (!TEXT_EXT.test(file) && looksBinary(bytes)) continue; // images and the like
    scanned++;
    const text = new TextDecoder().decode(bytes);
    const isDoc = DOC_EXT.test(file) || file === "SKILL.md";
    const lines = text.split("\n");

    const hits = new Map<string, number>();
    lines.forEach((line, i) => {
      for (const rule of RULES) {
        if (rule.docsOnly && !isDoc) continue;
        const m = line.match(rule.re);
        if (!m) continue;
        const n = (hits.get(rule.id) ?? 0) + 1;
        hits.set(rule.id, n);
        if (n > MAX_PER_RULE) continue;
        // A doc line that quotes the pattern while warning about it is worth a look, not an alarm.
        const warned = rule.quotable && isDoc && (DEFENSIVE.test(line.replace(/[*_~]/g, "")) || quoted(line, m.index ?? 0, m[0].length));
        const severity = warned ? lower(rule.severity) : rule.severity;
        add({ severity, category: rule.category, title: warned ? `${rule.title}（看起来是在提醒防范，确认一下）` : rule.title, file, line: i + 1, excerpt: excerpt(line, m.index ?? 0) });
      }
      if (SMUGGLE.test(line)) {
        add({ severity: "high", category: "obfuscation", title: "藏着看不见的控制字符（可以把整段话藏起来给 AI 看）", file, line: i + 1, excerpt: visible(line).slice(0, 120) });
      } else {
        const zw = (line.replace(EMOJI_ZWJ, "").replace(/^\uFEFF/, i === 0 ? "" : "\uFEFF").match(ZERO_WIDTH) ?? []).length;
        if (zw) {
          add({
            severity: zw >= 8 ? "high" : "medium",
            category: "obfuscation",
            title: zw >= 8 ? "藏着一串看不见的字符（可能在给 AI 传暗号）" : "有看不见的零宽字符",
            file,
            line: i + 1,
            excerpt: visible(line).slice(0, 120),
          });
        }
      }
      if (LONG_BASE64.test(line) && !/^data:|base64,/.test(line.trim()) && !/\.(json|svg|csv)$/i.test(file)) {
        add({ severity: "medium", category: "obfuscation", title: "有一大段编码过的内容（看不出是什么）", file, line: i + 1, excerpt: excerpt(line, line.search(LONG_BASE64)) });
      }
      if (HEX_ESCAPES.test(line)) add({ severity: "medium", category: "obfuscation", title: "有一大段转义编码的内容", file, line: i + 1, excerpt: excerpt(line, line.search(HEX_ESCAPES)) });
    });
    for (const [id, n] of hits) {
      if (n > MAX_PER_RULE) {
        const rule = RULES.find((r) => r.id === id)!;
        add({ severity: rule.severity, category: rule.category, title: `${rule.title}（这个文件里还有 ${n - MAX_PER_RULE} 处）`, file, excerpt: "" });
      }
    }

    // Instructions hidden in HTML comments: invisible in rendered Markdown, read by the model.
    if (isDoc) {
      for (const m of text.matchAll(COMMENT_WITH_ORDERS)) {
        if (!ORDER_WORDS.test(m[1]) || !TO_AGENT.test(m[1])) continue;
        add({
          severity: "medium",
          category: "injection",
          title: "注释里藏着给 AI 的话（显示时看不到）",
          file,
          line: text.slice(0, m.index).split("\n").length,
          excerpt: m[1].trim().replace(/\s+/g, " ").slice(0, 160),
        });
      }
    }
  }

  // Secrets plus a way out in the same skill is the shape of a stealer.
  const cats = new Set(findings.map((f) => f.category));
  if ((cats.has("credentials") || findings.some((f) => f.title.includes("环境变量"))) && (cats.has("exfiltration") || cats.has("network"))) {
    const where = findings.find((f) => f.category === "credentials");
    if (where && !findings.some((f) => f.category === "exfiltration" && f.severity === "high")) {
      add({
        severity: "high",
        category: "exfiltration",
        title: "既读取密钥 / 环境变量，又会联网发送数据",
        file: where.file,
        line: where.line,
        excerpt: where.excerpt,
      });
    }
  }

  const order = { high: 0, medium: 1, low: 2 } as const;
  findings.sort((a, b) => order[a.severity] - order[b.severity]);
  return { level: levelOf(findings), findings, scanned };
}

export function levelOf(findings: AuditFinding[], aiVerdict?: string): AuditLevel {
  if (aiVerdict === "malicious" || findings.some((f) => f.severity === "high")) return "danger";
  if (aiVerdict === "suspicious" || findings.some((f) => f.severity === "medium")) return "warn";
  return findings.length ? "notice" : "pass";
}

const lower = (s: AuditFinding["severity"]): AuditFinding["severity"] => (s === "high" ? "medium" : "low");

/** The match sits inside quotation marks on its line. */
function quoted(line: string, at: number, len: number): boolean {
  return QUOTES.test(line.slice(Math.max(0, at - 3), at)) || QUOTES.test(line.slice(at + len, at + len + 4));
}

function excerpt(line: string, at: number): string {
  const start = Math.max(0, at - 40);
  const s = visible(line.slice(start, start + 160)).trim();
  return (start > 0 ? "…" : "") + s + (line.length > start + 160 ? "…" : "");
}

/** Show hidden characters as <U+200B> so the user can see them. */
function visible(s: string): string {
  return s.replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]|[\u{E0000}-\u{E007F}]/gu, (c) => `<U+${c.codePointAt(0)!.toString(16).toUpperCase()}>`);
}

function isExecutable(b: Uint8Array): boolean {
  if (b.length < 4) return false;
  const [a, c, d, e] = b;
  return (
    (a === 0x7f && c === 0x45 && d === 0x4c && e === 0x46) || // ELF
    (a === 0x4d && c === 0x5a) || // Windows MZ
    (a === 0xcf && c === 0xfa && d === 0xed && e === 0xfe) || // Mach-O 64
    (a === 0xce && c === 0xfa && d === 0xed && e === 0xfe) ||
    (a === 0xca && c === 0xfe && d === 0xba && e === 0xbe) // fat binary
  );
}

function looksBinary(b: Uint8Array): boolean {
  const n = Math.min(b.length, 4096);
  for (let i = 0; i < n; i++) if (b[i] === 0) return true;
  return false;
}
