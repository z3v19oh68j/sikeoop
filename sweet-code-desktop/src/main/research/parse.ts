import type { ResearchProgress } from '../../shared/types.ts';

export function redact(message: string, secrets: readonly string[] = []): string {
  let text = message;
  for (const secret of secrets) if (secret) text = text.split(secret).join('[已隐藏]');
  return text.replace(/\bBearer\s+[^\s,;"']+/gi, 'Bearer [已隐藏]')
    .replace(/\b(?:sk|tp|ttp)-[^\s,;"']+/gi, '[已隐藏]')
    .replace(/((?:api[_ -]?key|token|authorization)\s*[=:]\s*)[^\s,;]+/gi, '$1[已隐藏]')
    .replace(/[A-Za-z0-9_+/.*=-]{24,}/g, '[已隐藏]')
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '').slice(0, 1000);
}

export function initialProgress(maxRounds: number): ResearchProgress {
  return { round: 0, maxRounds, claims: 0, chains: 0, attacks: 0, calling: [], failures: [], activity: '等待开始' };
}

/** Unknown output, including model text, is discarded. */
export function parseProgress(line: string, previous: ResearchProgress, at = Date.now(), secrets: readonly string[] = []): ResearchProgress | null {
  const text = line.trim();
  const p = { ...previous, calling: [...previous.calling], failures: [...previous.failures] };
  let m: RegExpMatchArray | null;
  if ((m = text.match(/^-- Round (\d+) --$/))) {
    p.round = Number(m[1]) + 1; p.calling = []; p.activity = `第 ${p.round} 轮开始`;
  } else if ((m = text.match(/^\[(agent_\d+)\] calling /))) {
    if (!p.calling.includes(m[1])) p.calling.push(m[1]);
    p.activity = `${m[1]} 正在调用模型`;
  } else if ((m = text.match(/^\[(agent_\d+)\] call failed:\s*(.*)$/))) {
    p.calling = p.calling.filter(a => a !== m![1]);
    p.failures = [...p.failures, { agent: m[1], message: redact(m[2], secrets), at }].slice(-100);
    p.activity = `${m[1]} 调用失败`;
  } else if ((m = text.match(/^\[(agent_\d+)\] → /))) {
    p.calling = p.calling.filter(a => a !== m![1]); p.activity = `${m[1]} 已返回`;
  } else if ((m = text.match(/^Claims:\s*(\d+)\s+Chains:\s*(\d+)\s+Attacks:\s*(\d+)$/))) {
    [p.claims, p.chains, p.attacks] = m.slice(1).map(Number); p.activity = `第 ${p.round} 轮：${p.attacks} 次攻击`;
  } else if (text.startsWith('TERMINATED:')) {
    p.calling = []; p.activity = '研究已达到终止条件';
  } else return null;
  return p;
}
