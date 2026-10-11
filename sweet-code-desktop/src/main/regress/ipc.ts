import type { RegressService } from "./service.ts";

// The regression panel's channels, as the preload calls them. Each answers with data or { error }.

/** `handle` is ipcMain.handle; the first argument of a handler (the event) is not used. */
export function registerRegressIpc(handle: (channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) => void, regress: RegressService): void {
  handle("regress:view", () => regress.view());
  handle("regress:generate", (_e, session, focus) => regress.generate(session, focus));
  handle("regress:addItems", (_e, candidates) => regress.addItems(candidates));
  handle("regress:updateItem", (_e, id, patch) => regress.updateItem(id, patch));
  handle("regress:deleteItem", (_e, id) => regress.deleteItem(id));
  handle("regress:run", (_e, itemIds, session) => regress.run(itemIds, session));
  handle("regress:cancel", (_e, runId) => regress.cancel(runId ?? undefined));
  handle("regress:override", (_e, runId, verdict) => regress.override(runId, verdict));
  handle("regress:snapshot", (_e, name) => regress.snapshot(name));
  handle("regress:diff", (_e, baselineId) => regress.diff(baselineId));
  handle("regress:deleteBaseline", (_e, id) => regress.deleteBaseline(id));
  handle("regress:reply", (_e, runId) => regress.reply(runId));
  handle("regress:setSettings", (_e, patch) => regress.setSettings(patch));
}
