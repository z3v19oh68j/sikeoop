import type { ToolboxService } from "./service.ts";
import type { AiToolboxPrefs } from "../../shared/types.ts";
export function registerToolboxIpc(handle: (channel: string, handler: (_event: unknown, ...args: any[]) => unknown) => void, toolbox: ToolboxService): void {
  handle("toolbox:sites", () => toolbox.sites());
  handle("toolbox:prefs", () => toolbox.prefs());
  handle("toolbox:savePrefs", (_event, prefs: AiToolboxPrefs) => toolbox.savePrefs(prefs));
  handle("toolbox:openUrl", (_event, id: string, q?: string) => toolbox.openUrl(id, q));
}
