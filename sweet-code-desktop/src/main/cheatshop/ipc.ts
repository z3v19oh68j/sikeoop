import type { CheatshopService } from "./service.ts";

export function registerCheatshopIpc(
  handle: (channel: string, handler: (_event: unknown, ...args: any[]) => unknown) => void,
  service: CheatshopService,
): void {
  handle("cheatshop:tree", () => service.tree());
  handle("cheatshop:read", (_event, p: unknown) => service.read(p));
}
