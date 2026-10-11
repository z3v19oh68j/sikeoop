import type { AgentPermissionCard } from "../../shared/types.ts";

/** ACP cards keep their original options; no shared approval-router changes. */
export class AgentApprovals {
  private pending = new Map<string, { card: AgentPermissionCard; finish(optionId: string | null): void }>();
  private show: (card: AgentPermissionCard) => void;
  private gone: (id: string) => void;
  constructor(show: (card: AgentPermissionCard) => void, gone: (id: string) => void) { this.show = show; this.gone = gone; }
  ask(card: AgentPermissionCard, signal: AbortSignal): Promise<string | null> {
    if (signal.aborted) return Promise.resolve(null);
    return new Promise(resolve => {
      const abort = () => finish(null);
      const timer = setTimeout(abort, 100000);
      const finish = (optionId: string | null) => {
        if (!this.pending.delete(card.id)) return;
        clearTimeout(timer); signal.removeEventListener("abort", abort); this.gone(card.id); resolve(optionId);
      };
      this.pending.set(card.id, { card, finish });
      signal.addEventListener("abort", abort, { once: true });
      this.show(card);
    });
  }
  answer(id: string, optionId: string | null): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    if (optionId !== null && !pending.card.options.some(o => o.optionId === optionId)) throw Error("Unknown ACP optionId");
    pending.finish(optionId);
  }
  has(id: string): boolean { return this.pending.has(id); }
  close(): void { for (const p of [...this.pending.values()]) p.finish(null); }
}
