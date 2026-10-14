import { memo, useEffect, useMemo, useState } from "react";
import type { UsageModelRow, UsageSummary } from "@shared/types";
import { Icon } from "./Icon";

/** 312万 / 1.28亿: Chinese units read faster than long digit runs. */
export function fmtTokens(n: number): string {
  if (n >= 1e8) return `${(n / 1e8).toFixed(2)} 亿`;
  if (n >= 1e4) return `${(n / 1e4).toFixed(n >= 1e6 ? 0 : 1)} 万`;
  return String(Math.round(n));
}

const totalOf = (r: Pick<UsageModelRow, "input" | "output" | "cacheRead" | "cacheWrite">) => r.input + r.output + r.cacheRead + r.cacheWrite;

const pad = (n: number) => String(n).padStart(2, "0");
const keyOf = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parse = (k: string) => {
  const [y, m, d] = k.split("-").map(Number);
  return new Date(y, m - 1, d);
};
const label = (k: string) => {
  const d = parse(k);
  return `${d.getMonth() + 1}月${d.getDate()}日`;
};

interface DayTotals {
  date: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

type Range = 7 | 30 | "all";

/** Token use since the first recorded request: totals, a bar per day, and a ranking by model. */
export const UsageScreen = memo(function UsageScreen({ hidden }: { hidden: boolean }) {
  const [data, setData] = useState<UsageSummary | null>(null);
  const [range, setRange] = useState<Range>(30);
  const [hover, setHover] = useState(-1);

  // Fresh numbers each time the screen is shown.
  useEffect(() => {
    if (!hidden) void window.sweet.usageSummary().then(setData);
  }, [hidden]);

  const view = useMemo(() => {
    if (!data) return null;
    const byDate = new Map(data.days.map((d) => [d.date, d]));
    const today = parse(data.today);
    const first = data.firstDay ? parse(data.firstDay) : today;
    const allDays = Math.max(1, Math.round((today.getTime() - first.getTime()) / 86400000) + 1);
    const n = range === "all" ? allDays : range;

    // Every day of the range, including days without use (zero bars).
    const days: DayTotals[] = [];
    for (let i = n - 1; i >= 0; i--) {
      const d = new Date(today);
      d.setDate(today.getDate() - i);
      const k = keyOf(d);
      const rows = Object.values(byDate.get(k)?.models ?? {});
      const t = { date: k, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
      for (const r of rows) {
        t.input += r.input;
        t.output += r.output;
        t.cacheRead += r.cacheRead;
        t.cacheWrite += r.cacheWrite;
      }
      t.total = totalOf(t);
      days.push(t);
    }

    const allTotal = data.days.reduce((s, d) => s + Object.values(d.models).reduce((a, r) => a + totalOf(r), 0), 0);
    const todayTotal = days[days.length - 1].total;
    const prev7 = [...Array(7)].map((_, i) => {
      const d = new Date(today);
      d.setDate(today.getDate() - 1 - i);
      return Object.values(byDate.get(keyOf(d))?.models ?? {}).reduce((a, r) => a + totalOf(r), 0);
    });
    const avg7 = prev7.reduce((a, b) => a + b, 0) / 7;
    const rangeTotal = days.reduce((s, d) => s + d.total, 0);
    const inputAll = days.reduce((s, d) => s + d.input + d.cacheRead + d.cacheWrite, 0);
    const cacheShare = inputAll ? days.reduce((s, d) => s + d.cacheRead, 0) / inputAll : 0;

    // Models within the range, biggest first.
    const models = new Map<string, UsageModelRow & { total: number }>();
    const from = days[0].date;
    for (const d of data.days) {
      if (d.date < from) continue;
      for (const [k, r] of Object.entries(d.models)) {
        const m = models.get(k) ?? { ...r, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, requests: 0, total: 0 };
        m.input += r.input;
        m.output += r.output;
        m.cacheRead += r.cacheRead;
        m.cacheWrite += r.cacheWrite;
        m.requests += r.requests;
        m.total += totalOf(r);
        m.providerName = r.providerName;
        models.set(k, m);
      }
    }
    const ranked = [...models.values()].sort((a, b) => b.total - a.total);

    const max = Math.max(...days.map((d) => d.total), 1);
    const top = niceTop(max);
    return { days, allDays, allTotal, todayTotal, avg7, rangeTotal, cacheShare, ranked, top, n };
  }, [data, range]);

  if (!data || !view) return <main className="usage" hidden={hidden} />;
  const rangeName = range === "all" ? "全部时间" : `近 ${range} 天`;
  const tip = hover >= 0 ? view.days[hover] : null;
  const vs = view.avg7 ? Math.round((view.todayTotal / view.avg7 - 1) * 100) : null;

  return (
    <main className="usage" hidden={hidden}>
      <div className="usage-inner">
        <div className="usage-head">
          <h1>用量统计</h1>
          <span className="spacer" />
          <div className="seg" role="radiogroup" aria-label="时间范围">
            {([7, 30, "all"] as Range[]).map((r) => (
              <button key={r} type="button" role="radio" aria-checked={range === r} className={range === r ? "on" : undefined} onClick={() => (setRange(r), setHover(-1))}>
                {r === "all" ? "全部" : `近 ${r} 天`}
              </button>
            ))}
          </div>
        </div>

        {!data.firstDay ? (
          <div className="wiki-empty">
            <Icon name="chart" />
            <h2>还没有用量记录</h2>
            <p>从现在开始，sikeoop 会记下每个模型每天用了多少 token：主对话、群聊、项目百科、识图都算在内。</p>
          </div>
        ) : (
          <>
            <div className="usage-tiles">
              <div className="usage-tile">
                <span className="k">从开始记录到今天</span>
                <span className="v">{fmtTokens(view.allTotal)}</span>
                <span className="s">
                  tokens · {data.firstDay} 起，共 {view.allDays} 天
                </span>
              </div>
              <div className="usage-tile today">
                <span className="k">今天</span>
                <span className="v">{fmtTokens(view.todayTotal)}</span>
                <span className="s">{vs === null ? "前 7 天没有用量可比" : `比前 7 天平均${vs >= 0 ? "多" : "少"} ${Math.abs(vs)}%`}</span>
              </div>
              <div className="usage-tile">
                <span className="k">{rangeName}日均</span>
                <span className="v">{fmtTokens(view.rangeTotal / view.n)}</span>
                <span className="s">
                  {rangeName}合计 {fmtTokens(view.rangeTotal)}
                </span>
              </div>
              <div className="usage-tile">
                <span className="k">缓存命中</span>
                <span className="v">{Math.round(view.cacheShare * 100)}%</span>
                <span className="s">输入里读缓存的比例，这部分更便宜</span>
              </div>
            </div>

            <section className="usage-card">
              <div className="usage-card-head">
                <h2>每天用了多少 token</h2>
                <span>所有模型加在一起 · 鼠标移到柱子上看明细</span>
              </div>
              <div className="usage-chart">
                <div className="y">
                  <span>{fmtTokens(view.top)}</span>
                  <span>{fmtTokens(view.top / 2)}</span>
                  <span>0</span>
                </div>
                <div className="plot-wrap">
                  <div className="plot" onMouseLeave={() => setHover(-1)}>
                    <div className="grid top" />
                    <div className="grid mid" />
                    <div className="bars" style={{ gap: view.n > 60 ? 1 : 2 }}>
                      {view.days.map((d, i) => (
                        <div key={d.date} className="col" onMouseEnter={() => setHover(i)} aria-label={`${label(d.date)}：${fmtTokens(d.total)} tokens`}>
                          <div
                            className={"bar" + (i === view.days.length - 1 ? " today" : "") + (i === hover ? " hot" : "")}
                            style={{ height: d.total ? `${Math.max(1.5, (d.total / view.top) * 100)}%` : 0 }}
                          />
                        </div>
                      ))}
                    </div>
                    {tip && (
                      <div className="tip" style={{ left: `${Math.min(Math.max(((hover + 0.5) / view.days.length) * 100, 10), 86)}%` }}>
                        <span className="d">
                          {label(tip.date)}
                          {hover === view.days.length - 1 ? "（今天）" : ""}
                        </span>
                        <span className="t">{fmtTokens(tip.total)} tokens</span>
                        <span className="r">
                          <em>输入</em> {fmtTokens(tip.input + tip.cacheRead + tip.cacheWrite)}
                        </span>
                        <span className="r">
                          <em>其中读缓存</em> {fmtTokens(tip.cacheRead)}
                        </span>
                        <span className="r">
                          <em>输出</em> {fmtTokens(tip.output)}
                        </span>
                      </div>
                    )}
                  </div>
                  <div className="x">
                    <span>{label(view.days[0].date)}</span>
                    {view.n > 2 && <span>{label(view.days[Math.floor(view.days.length / 2)].date)}</span>}
                    <span>今天</span>
                  </div>
                </div>
              </div>
            </section>

            <section className="usage-card">
              <div className="usage-card-head">
                <h2>按模型</h2>
                <span>{rangeName} · 同一个服务商的不同模型分开算</span>
              </div>
              {view.ranked.length === 0 && <p className="hint">这段时间没有用量。</p>}
              <div className="usage-models">
                {view.ranked.map((m) => (
                  <div key={`${m.providerId}::${m.model}`} className="usage-model" title={`${m.requests} 次请求`}>
                    <span className="n">
                      <span>{m.providerName}</span>
                      <small>{m.model}</small>
                    </span>
                    <span className="track">
                      <span style={{ width: `${(m.total / view.ranked[0].total) * 100}%` }} />
                    </span>
                    <span className="v">{fmtTokens(m.total)}</span>
                    <span className="p">{view.rangeTotal ? Math.round((m.total / view.rangeTotal) * 100) : 0}%</span>
                  </div>
                ))}
              </div>
            </section>
          </>
        )}
      </div>
    </main>
  );
});

/** A round axis top just above the largest bar: 1/2/5 × 10^n. */
function niceTop(max: number): number {
  const p = 10 ** Math.floor(Math.log10(max));
  for (const m of [1, 2, 5, 10]) if (m * p >= max) return m * p;
  return 10 * p;
}
