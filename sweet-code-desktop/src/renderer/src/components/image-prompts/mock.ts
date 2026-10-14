import type { ImagePromptCategory, ImagePromptFacet, ImagePromptLang, ImagePromptMeta, ImagePromptModel, ImagePromptQuery, SweetApi } from "@shared/types";
import { CATEGORY_LABEL, LANG_LABEL, MODEL_LABEL } from "./labels";
import { MOCK_SOURCES, buildMockEntries } from "./mock-data";

// dev:web stand-in for the 图片提示词精选库 IPC (~40 made-up samples; nothing is copied from prompt-sources/).
// 切换状态：地址栏加 ?ipl=missing | invalid | error，或在控制台写 window.__iplMock = "missing"（下次请求生效）。
//   missing / invalid / unreleased：模拟没有数据 / 数据校验没过 / 数据还没经过发布筛选；error：模拟接口报错。
// 模拟「后端刚启动、缩略图还在后台校验」：地址栏加 ?iplWarm=3（或控制台 window.__iplThumbWarmup = 3），
// 每个 id 前 3 次取缩略图都返回空对象，之后才给图。

type MockMode = "ready" | "missing" | "invalid" | "unreleased" | "error";
declare global { interface Window { __iplMock?: MockMode; __iplThumbWarmup?: number } }

const mode = (): MockMode => {
  const v = window.__iplMock ?? new URLSearchParams(window.location.search).get("ipl");
  return v === "missing" || v === "invalid" || v === "unreleased" || v === "error" ? v : "ready";
};
const warmup = (): number => {
  const v = window.__iplThumbWarmup ?? Number(new URLSearchParams(window.location.search).get("iplWarm"));
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const DATASET = "mockdata0001";

function facets<T extends string>(labels: Record<T, string>, count: (id: T) => number): ImagePromptFacet<T>[] {
  return (Object.keys(labels) as T[]).map((id) => ({ id, label: labels[id], count: count(id) }));
}

export function createImagePromptMock(): Pick<SweetApi, "imagePromptMeta" | "imagePromptQuery" | "imagePromptGet" | "imagePromptThumbs" | "imagePromptSetFavorite" | "imagePromptCopy"> {
  const entries = buildMockEntries();
  const byId = new Map(entries.map((e) => [e.id, e]));
  const toCard = ({ variants: _v, modelExact: _m, size: _s, sourceUrl: _u, attribution: _a, alsoIn: _i, hasVars: _h, thumbData: _t, ...card }: (typeof entries)[number]) => card;
  const thumbTries = new Map<string, number>();
  const favCount = () => entries.filter((e) => e.favorite).length;

  const searchText = (e: (typeof entries)[number]) =>
    [e.title, e.titleEn, e.author, ...e.tags, ...e.variants.flatMap((v) => v.steps.map((s) => s.text))].join("\n").toLowerCase();
  const texts = new Map(entries.map((e) => [e.id, searchText(e)]));

  function run(q: ImagePromptQuery) {
    const s = q.q?.trim().toLowerCase();
    return entries
      .filter((e) => (!s || texts.get(e.id)!.includes(s)) && (!q.category || e.category === q.category) && (!q.model || e.models.includes(q.model))
        && (!q.lang || e.langs.includes(q.lang)) && (!q.favoritesOnly || e.favorite) && (!q.withImage || e.hasThumb))
      .sort((a, b) => Number(b.featured) - Number(a.featured) || (a.id < b.id ? -1 : 1));
  }

  return {
    imagePromptMeta: async () => {
      await wait(200);
      const m = mode();
      const empty: ImagePromptMeta = { state: "missing", dataset: "", profile: "dev", generatedAt: 0, total: 0, favorites: 0, categories: [], models: [], langs: [], sources: [] };
      if (m === "error") throw new Error("Error invoking remote method 'imgprompt:meta': Error: 模拟的接口报错");
      if (m === "missing") return { ...empty, reason: "没有找到提示词数据" };
      if (m === "invalid") return { ...empty, state: "invalid", reason: "数据文件校验没有通过" };
      if (m === "unreleased") return { ...empty, state: "invalid", reason: "这份数据还没有经过发布筛选" };
      return {
        state: "ready", dataset: DATASET, profile: "dev", generatedAt: Date.now(), total: entries.length, favorites: favCount(),
        categories: facets<ImagePromptCategory>(CATEGORY_LABEL, (id) => entries.filter((e) => e.category === id).length),
        models: facets<ImagePromptModel>(MODEL_LABEL, (id) => entries.filter((e) => e.models.includes(id)).length),
        langs: facets<ImagePromptLang>(LANG_LABEL, (id) => entries.filter((e) => e.langs.includes(id)).length),
        sources: MOCK_SOURCES.map((s) => ({ ...s, count: entries.filter((e) => e.source === s.id).length })),
      };
    },
    imagePromptQuery: async (q) => {
      await wait(150);
      if (mode() === "error") throw new Error("Error invoking remote method 'imgprompt:query': Error: 模拟的接口报错");
      const all = run(q);
      const offset = Math.max(0, q.offset ?? 0);
      const limit = Math.min(96, Math.max(1, q.limit ?? 48));
      const items = all.slice(offset, offset + limit).map(toCard);
      return { items, total: all.length, offset, nextOffset: offset + limit < all.length ? offset + limit : null, dataset: DATASET };
    },
    imagePromptGet: async (id) => {
      await wait(180);
      const e = byId.get(id);
      if (!e) return null;
      const { thumbData: _t, ...detail } = e;
      return structuredClone(detail);
    },
    imagePromptThumbs: async (ids) => {
      await wait(250 + Math.random() * 350); // 人为延迟，方便看懒加载
      const out: Record<string, string> = {};
      const warm = warmup();
      for (const id of ids.slice(0, 24)) {
        const tries = (thumbTries.get(id) ?? 0) + 1;
        thumbTries.set(id, tries);
        if (tries <= warm) continue; // 模拟还没校验完：成功返回，但结果里没有这个 id
        const e = byId.get(id);
        if (e?.thumbData) out[id] = e.thumbData;
      }
      return out;
    },
    imagePromptSetFavorite: async (id, on) => {
      const e = byId.get(id);
      if (!e) throw new Error("找不到这条提示词");
      e.favorite = on;
      return { id, favorite: on, count: favCount() };
    },
    imagePromptCopy: async ({ id, lang, step }) => {
      const e = byId.get(id);
      if (!e) throw new Error("找不到这条提示词");
      const v = e.variants.find((x) => x.lang === lang) ?? e.variants[0];
      const steps = step === undefined ? v.steps : [v.steps[step]].filter(Boolean);
      if (!steps.length) throw new Error("没有这一步");
      const text = steps.map((s) => s.text).join("\n\n");
      try { await navigator.clipboard?.writeText(text); } catch { /* dev only */ }
      return { chars: text.length };
    },
  };
}
