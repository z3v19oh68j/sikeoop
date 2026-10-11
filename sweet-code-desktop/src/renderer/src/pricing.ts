// DeepSeek list prices (CNY per million tokens) from the official pricing page. Peak hours
// (Mon–Fri 9:00–12:00 and 14:00–18:00 Beijing time) cost twice the off-peak price.
const DEEPSEEK: Record<string, { hit: number; miss: number; out: number }> = {
  "deepseek-flash": { hit: 0.02, miss: 1, out: 4 },
  "deepseek-v4-pro": { hit: 0.15, miss: 4.5, out: 13.5 },
};
// Older names that DeepSeek now routes to deepseek-flash at flash prices.
const ALIASES: Record<string, string> = {
  "deepseek-v4-flash": "deepseek-flash",
  "deepseek-v4-flash-vision-exp": "deepseek-flash",
};

/** Beijing-time peak window. Public holidays are off-peak but not detected here. */
export function isDeepSeekPeak(now = new Date()): boolean {
  const bj = new Date(now.getTime() + 8 * 3600_000);
  const day = bj.getUTCDay();
  const min = bj.getUTCHours() * 60 + bj.getUTCMinutes();
  return day >= 1 && day <= 5 && ((min >= 540 && min < 720) || (min >= 840 && min < 1080));
}

/** Estimated cost in CNY of one request, or null when the model's price isn't known. */
export function deepseekCost(
  model: string,
  u: { input: number; cacheRead: number; output: number },
  now = new Date(),
): number | null {
  const p = DEEPSEEK[ALIASES[model] ?? model];
  if (!p) return null;
  const k = isDeepSeekPeak(now) ? 2 : 1;
  return ((u.cacheRead * p.hit + u.input * p.miss + u.output * p.out) * k) / 1_000_000;
}
