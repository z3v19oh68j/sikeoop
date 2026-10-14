import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";

// 缩略图懒加载：卡片进入视口前后 400px 才登记 id，50ms 内的登记合并成一次请求（一次最多 24 个）。
// 渲染层最多留 400 张（LRU）。图片地址只会是接口返回的 data: URL。
//
// 暂时拿不到图的处理：只有 hasThumb 为 true 的卡片才会登记 id。请求出错，或者请求成功但结果里没有这个 id
// （后端刚启动、还在后台校验图片文件时会这样），都算「暂时拿不到」：过一会儿自动再取，间隔越来越长，
// 超过 MAX_TRIES 次才记成「确实没有图」。仍在视口里的卡片不用滚动就会补上；页面藏起来或应用窗口不可见（最小化、切到后台）时暂停，恢复后继续。

const MAX_CACHE = 400;
const BATCH = 24;
const DELAY = 50;
const MAX_TRIES = 8; // 同一张图最多请求几次，都拿不到才当作没有图
const RETRY_STEPS = [1500, 3000, 6000]; // 第 1、2、3 次失败后等多久；之后每次等 RETRY_LATER
const RETRY_LATER = 10000;
const OK_PREFIX = "data:image/jpeg;base64,";

const waitAfter = (tries: number) => RETRY_STEPS[tries - 1] ?? RETRY_LATER;

export interface Thumbs {
  /** 取已加载好的图；还没有或确认没有都返回 undefined。 */
  src(id: string): string | undefined;
  /** 登记一个有缩略图的 id（比如打开详情时），立刻排队去取。没有缩略图的卡片不要调用。 */
  want(id: string): void;
  /** 给卡片的图片区挂上，进入视口时自动登记。元素上要带 data-tid。 */
  observe: (el: HTMLElement | null) => void | (() => void);
  /** 换了一份数据集或重新加载时清空。 */
  reset(): void;
}

export function useThumbs(rootRef: RefObject<HTMLElement | null>, hidden = false): Thumbs {
  const cache = useRef(new Map<string, string>()); // 空串表示「确认没有图」
  const queue = useRef(new Set<string>());
  const inflight = useRef(new Set<string>());
  const visible = useRef(new Set<string>()); // 现在在视口里的 id
  const retry = useRef(new Map<string, { n: number; at: number }>()); // 暂时拿不到的 id：已请求次数、最早再试的时间
  const timer = useRef<number | undefined>(undefined);
  const retryTimer = useRef<number | undefined>(undefined);
  const paused = useRef(hidden);
  const io = useRef<IntersectionObserver | null>(null);
  const alive = useRef(true);
  const gen = useRef(0);
  const tickRef = useRef<() => void>(() => {});
  const [, bump] = useState(0);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      window.clearTimeout(timer.current);
      window.clearTimeout(retryTimer.current);
      io.current?.disconnect();
      io.current = null;
    };
  }, []);

  // 按最早一条「还没到点」的记录排一个定时器。已经到点但不在视口里的不管（卡片滚回来时由 want 接手）。
  const schedule = useCallback(() => {
    window.clearTimeout(retryTimer.current);
    retryTimer.current = undefined;
    if (paused.current || !alive.current) return;
    const now = Date.now();
    let next = Infinity;
    for (const r of retry.current.values()) if (r.at > now && r.at < next) next = r.at;
    if (next !== Infinity) retryTimer.current = window.setTimeout(() => tickRef.current(), Math.max(0, next - now) + 10);
  }, []);

  const flush = useCallback(() => {
    timer.current = undefined;
    const ids = [...queue.current].slice(0, BATCH);
    if (!ids.length) return;
    for (const id of ids) { queue.current.delete(id); inflight.current.add(id); }
    const g = gen.current;
    void window.sweet
      .imagePromptThumbs(ids)
      .then(
        (got) => ({ ok: true as const, got }),
        () => ({ ok: false as const, got: {} as Record<string, string> }),
      )
      .then(({ ok, got }) => {
        if (!alive.current || g !== gen.current) return;
        const now = Date.now();
        for (const id of ids) {
          inflight.current.delete(id);
          const url = ok ? got[id] : undefined;
          if (typeof url === "string" && url) {
            retry.current.delete(id);
            cache.current.delete(id);
            // 给了地址却不是 JPEG data URL：不用，也不再试。
            cache.current.set(id, url.startsWith(OK_PREFIX) ? url : "");
            continue;
          }
          // 出错，或成功但没给这个 id：暂时拿不到，稍后再取；次数用完才记成「没有图」。
          const n = (retry.current.get(id)?.n ?? 0) + 1;
          if (n >= MAX_TRIES) {
            retry.current.delete(id);
            cache.current.delete(id);
            cache.current.set(id, "");
          } else {
            retry.current.set(id, { n, at: now + waitAfter(n) });
          }
        }
        while (cache.current.size > MAX_CACHE) cache.current.delete(cache.current.keys().next().value as string);
        schedule();
        bump((n) => n + 1);
      });
    if (queue.current.size) timer.current = window.setTimeout(flush, DELAY);
  }, [schedule]);

  const want = useCallback((id: string) => {
    if (cache.current.has(id) || inflight.current.has(id) || queue.current.has(id)) return;
    const r = retry.current.get(id);
    if (r && r.at > Date.now()) return; // 还没到点，定时器会来
    queue.current.add(id);
    if (timer.current === undefined) timer.current = window.setTimeout(flush, DELAY);
  }, [flush]);

  // 到点了：还在视口里的补取一次，然后给后面的记录重新排定时器。
  tickRef.current = () => {
    retryTimer.current = undefined;
    if (paused.current || !alive.current) return;
    const now = Date.now();
    for (const [id, r] of retry.current) if (r.at <= now && visible.current.has(id)) want(id);
    schedule();
  };

  useEffect(() => {
    const sync = () => {
      paused.current = hidden || document.hidden;
      if (paused.current) {
        window.clearTimeout(retryTimer.current);
        retryTimer.current = undefined;
      } else {
        tickRef.current();
      }
    };
    sync();
    document.addEventListener("visibilitychange", sync);
    return () => document.removeEventListener("visibilitychange", sync);
  }, [hidden]);

  const observe = useCallback((el: HTMLElement | null) => {
    if (!el) return;
    if (!io.current) {
      io.current = new IntersectionObserver(
        (entries) => {
          for (const e of entries) {
            const id = (e.target as HTMLElement).dataset.tid;
            if (!id) continue;
            if (e.isIntersecting) { visible.current.add(id); want(id); } else visible.current.delete(id);
          }
        },
        { root: rootRef.current, rootMargin: "400px 0px" },
      );
    }
    const o = io.current;
    o.observe(el);
    return () => {
      o.unobserve(el);
      if (el.dataset.tid) visible.current.delete(el.dataset.tid);
    };
  }, [rootRef, want]);

  const src = useCallback((id: string) => {
    const v = cache.current.get(id);
    if (v === undefined) return undefined;
    // 看过就算「最近用过」，挪到最后，避免正在看的图被挤掉。
    cache.current.delete(id);
    cache.current.set(id, v);
    return v || undefined;
  }, []);

  const reset = useCallback(() => {
    gen.current++;
    cache.current.clear();
    queue.current.clear();
    inflight.current.clear();
    retry.current.clear();
    window.clearTimeout(retryTimer.current);
    retryTimer.current = undefined;
    bump((n) => n + 1);
  }, []);

  return useMemo(() => ({ src, want, observe, reset }), [src, want, observe, reset]);
}
