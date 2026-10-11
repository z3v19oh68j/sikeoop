// Takes secrets and personal contact details out of text before it is kept as memory (c2 session
// summaries now; MemoryStore.add later). Errs toward over-matching: a summary that loses a long
// hex string is fine, one that keeps an API key is not.

const RULES: [RegExp, string][] = [
  // Provider keys and tokens with a known prefix.
  [/\b(sk|tp|pk|rk)-[A-Za-z0-9_-]{16,}/g, "[密钥]"],
  [/\b(ghp|gho|ghu|ghs|github_pat)_[A-Za-z0-9_]{20,}/g, "[密钥]"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "[密钥]"],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, "[密钥]"],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/gi, "Bearer [令牌]"],
  // key=value / key: value for anything that sounds secret.
  [/\b(password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|密码|口令|密钥)(\s*[:=：]\s*)("[^"]*"|'[^']*'|\S+)/gi, "$1$2[已隐藏]"],
  // Long opaque strings: hex and base64-ish runs that read like keys.
  [/\b[A-Fa-f0-9]{32,}\b/g, "[长串]"],
  [/\b(?=[A-Za-z0-9+/_-]*\d)(?=[A-Za-z0-9+/_-]*[A-Z])(?=[A-Za-z0-9+/_-]*[a-z])[A-Za-z0-9+/_-]{40,}={0,2}/g, "[长串]"],
  // Contact details.
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[邮箱]"],
  [/(?<!\d)1[3-9]\d{9}(?!\d)/g, "[手机号]"],
];

export function redact(text: string): string {
  return RULES.reduce((s, [re, to]) => s.replace(re, to), text);
}
