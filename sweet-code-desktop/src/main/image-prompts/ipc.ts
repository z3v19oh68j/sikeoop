import type { ImagePromptService } from "./service.ts";
// Arguments are passed through untouched: the service validates every input itself.
export function registerImagePromptIpc(handle: (channel: string, handler: (_event: unknown, ...args: any[]) => unknown) => void, service: ImagePromptService): void {
  handle("imgprompt:meta", () => service.meta());
  handle("imgprompt:query", (_event, query: unknown) => service.query(query));
  handle("imgprompt:get", (_event, id: unknown) => service.get(id));
  handle("imgprompt:thumbs", (_event, ids: unknown) => service.thumbs(ids));
  handle("imgprompt:favorite", (_event, id: unknown, on: unknown) => service.setFavorite(id, on));
  handle("imgprompt:copy", (_event, request: unknown) => service.copyPrompt(request));
}
