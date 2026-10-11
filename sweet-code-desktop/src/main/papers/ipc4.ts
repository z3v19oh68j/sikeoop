import type { ToolsService } from "./tools.ts";

// The fourth batch's channels: Quarto / Zotero / Better BibTeX downloaded when the user asks
// (tools:*). Errors reach the window as "论文工坊：…", like the other batches'.

type Handle = (channel: string, handler: (_event: unknown, ...args: unknown[]) => unknown) => void;

export function registerPaperIpc4(handle: Handle, services: { tools: ToolsService }): void {
  const { tools } = services;
  const methods: Record<string, (...args: unknown[]) => unknown> = {
    "tools:state": () => tools.state(),
    "tools:offer": (tool) => tools.offer(tool),
    "tools:download": (tool, version) => tools.download(tool, version),
    "tools:cancel": (tool) => tools.cancel(tool),
    "tools:open": (tool) => tools.open(tool),
    "tools:reveal": (tool) => tools.reveal(tool),
    "tools:removeQuarto": (version) => tools.removeQuarto(version),
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
