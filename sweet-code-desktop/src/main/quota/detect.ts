export interface LimitDetection {
  reason: string;
  resumeAt?: number;
  source: 'reset_time' | 'retry_after' | 'default';
}

/** No provider SDK or process dependencies: also accepts the original API error. */
export function detectLimit(input: unknown, now: number): LimitDetection | null {
  const error = input && typeof input === 'object' ? input as Record<string, unknown> : null;
  const text = (typeof input === 'string' ? input : String(error?.message ?? input ?? '')).replace(/\x1b\[[0-9;]*m/g, '');
  const status = Number(error?.status ?? error?.statusCode);
  const explicit = /Claude AI usage limit reached|(?:5[- ]hour|weekly|usage) limit (?:reached|exceeded)|you(?:'|’)?ve hit your (?:usage )?limit|(?:usage|quota)\s+(?:limit\s+)?(?:exceeded|exhausted|reached)|insufficient[_ ](?:balance|quota)|(?:error|HTTP|status)\s*[:=]?\s*(?:429|402)\b|^\s*(?:429|402)\b|(?:rate limit(?:ed| exceeded| reached)|too many requests)|额度(?:已)?(?:用完|耗尽|不足)|余额不足/i;
  if (status !== 429 && status !== 402 && !explicit.test(text) && !(error && /\bquota\b|\brate limit\b/i.test(text)) && !/usage limit[^\n]*\breset(?:s| at)?\b/i.test(text)) return null;
  const result: LimitDetection = { reason: text.slice(0, 300) || `HTTP ${status}`, source: 'default' };
  if (error) {
    const headers = error.headers as { get?: (key: string) => string | null } & Record<string, unknown> | undefined;
    const values: number[] = [];
    const get = (key: string) => headers?.get ? headers.get(key) : Object.entries(headers ?? {}).find(([k]) => k.toLowerCase() === key)?.[1];
    const retry = get('retry-after');
    if (retry != null) {
      const n = Number(retry);
      const time = Number.isFinite(n) ? now + n * 1000 : Date.parse(String(retry));
      if (Number.isFinite(time)) values.push(time);
    }
    for (const key of ['anthropic-ratelimit-requests-reset', 'anthropic-ratelimit-tokens-reset', 'anthropic-ratelimit-input-tokens-reset', 'anthropic-ratelimit-output-tokens-reset']) {
      const value = get(key);
      if (value != null && Number.isFinite(Date.parse(String(value)))) values.push(Date.parse(String(value)));
    }
    if (values.length) return { ...result, resumeAt: Math.max(...values), source: 'retry_after' };
  }
  const unix = text.match(/Claude AI usage limit reached\s*\|\s*(\d{10,13})/i);
  let time: number | undefined;
  if (unix) time = Number(unix[1]) * (unix[1].length === 13 ? 1 : 1000);
  const duration = text.match(/try again in\s+(?:(\d+)\s*hours?)?\s*(?:(\d+)\s*minutes?)?\s*(?:(\d+)\s*seconds?)?/i);
  if (duration && duration.slice(1).some(Boolean)) time = now + (Number(duration[1] ?? 0) * 3600 + Number(duration[2] ?? 0) * 60 + Number(duration[3] ?? 0)) * 1000;
  if (time === undefined) {
    const reset = text.match(/(?:resets?|reset at|try again at)\s+(?:at\s+)?(.+)/i)?.[1];
    if (reset) time = parseReset(reset, now);
  }
  return time === undefined ? result : { ...result, resumeAt: time, source: 'reset_time' };
}

function parseReset(text: string, now: number): number | undefined {
  const zone = text.match(/\(([A-Za-z_]+\/[A-Za-z_]+(?:\/[A-Za-z_]+)?)\)/)?.[1];
  const clock = text.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i) ?? text.match(/\b(\d{1,2}):(\d{2})\b/);
  if (!clock) {
    const iso = text.match(/\d{4}-\d{2}-\d{2}T[\d:.]+(?:Z|[+-]\d{2}:?\d{2})/);
    const parsed = iso ? Date.parse(iso[0]) : NaN;
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  let hour = Number(clock[1]);
  const minute = Number(clock[2] ?? 0);
  if (minute > 59 || hour > (clock[3] ? 12 : 23) || (clock[3] && hour < 1)) return undefined;
  if (clock[3]) hour = hour % 12 + (/pm/i.test(clock[3]) ? 12 : 0);
  try {
    const fmt = new Intl.DateTimeFormat('en-US', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
    const parts = (t: number) => Object.fromEntries(fmt.formatToParts(t).map(p => [p.type, p.value]));
    const p = parts(now);
    const day = new Date(Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day)));
    const weekday = text.match(/\b(Sun(?:day)?|Mon(?:day)?|Tue(?:sday)?|Wed(?:nesday)?|Thu(?:rsday)?|Fri(?:day)?|Sat(?:urday)?)\b/i);
    if (weekday) day.setUTCDate(day.getUTCDate() + (['sun','mon','tue','wed','thu','fri','sat'].indexOf(weekday[1].slice(0, 3).toLowerCase()) - day.getUTCDay() + 7) % 7);
    const convert = () => {
      const wall = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), hour, minute);
      let candidate = wall;
      for (let i = 0; i < 4; i++) {
        const q = parts(candidate);
        const shown = Date.UTC(Number(q.year), Number(q.month) - 1, Number(q.day), Number(q.hour), Number(q.minute), Number(q.second));
        candidate += wall - shown;
      }
      return candidate;
    };
    let candidate = convert();
    if (candidate <= now) { day.setUTCDate(day.getUTCDate() + (weekday ? 7 : 1)); candidate = convert(); }
    return candidate;
  } catch { return undefined; }
}
