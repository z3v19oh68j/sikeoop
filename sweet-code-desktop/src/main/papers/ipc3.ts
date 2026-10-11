import type { CiteService } from "./cite-service.ts";
import type { TypesetService } from "./typeset.ts";

// The third batch's channels: Zotero and citations (zotero:*, cite:*, bib:*) and typesetting with
// Quarto (quarto:*). Errors reach the window as "论文工坊：…", like the other batches'.

type Handle = (channel: string, handler: (_event: unknown, ...args: unknown[]) => unknown) => void;

export function registerPaperIpc3(handle: Handle, services: { cite: CiteService; typeset: TypesetService }): void {
  const { cite, typeset } = services;
  const methods: Record<string, (...args: unknown[]) => unknown> = {
    "zotero:status": () => cite.status(),
    "zotero:pick": (style) => cite.pick(style),
    "zotero:cancelPick": () => cite.cancelPick(),
    "zotero:search": (terms) => cite.search(terms),
    "zotero:collections": () => cite.collections(),
    "zotero:import": (item) => cite.import(item),
    "cite:format": (refs, style) => cite.format(refs, style),
    "bib:state": (file) => cite.bibState(file ?? undefined),
    "bib:sync": (req) => cite.bibSync(req),
    "quarto:status": () => typeset.status(),
    "quarto:documents": () => typeset.documents(),
    "quarto:render": (req) => typeset.render(req),
    "quarto:cancel": (id) => typeset.cancel(id),
    "quarto:runs": () => typeset.list(),
    "quarto:watch": (watch) => typeset.watch(watch),
    "quarto:watching": () => typeset.watchingNow(),
    "quarto:open": (file) => typeset.open(file),
    "quarto:cslStyles": () => typeset.cslStyles(),
    "quarto:newPaper": (req) => typeset.newPaper(req),
  };
  for (const [channel, method] of Object.entries(methods)) {
    handle(channel, async (_event, ...args) => {
      try {
        return await method(...args);
      } catch (e) {
        throw new Error(`论文工坊：${e instanceof Error ? e.message : "处理失败，请重试"}`);
      }
    });
  }
}
