import type { DisclosureDraft } from "@shared/types";
import type { IdeasService } from "./ideas.ts";
import type { ReviewService } from "./review.ts";

// The second batch's channels: simulated review (review:*), topic ideas (ideas:*), and the AI-use
// statement (paper:disclosure). Errors reach the window as "论文工坊：…", like the first batch's.

type Handle = (channel: string, handler: (_event: unknown, ...args: unknown[]) => unknown) => void;

export function registerPaperIpc2(handle: Handle, services: { review: ReviewService; ideas: IdeasService; disclosure(): Promise<DisclosureDraft> }): void {
  const { review, ideas } = services;
  const methods: Record<string, (...args: unknown[]) => unknown> = {
    "review:candidates": () => review.candidates(),
    "review:start": (req) => review.start(req),
    "review:cancel": (id) => review.cancel(id),
    "review:list": () => review.list(),
    "review:get": (id) => review.get(id),
    "review:delete": (id) => review.delete(id),
    "review:polishSeed": (id, weakness) => review.polishSeed(id, weakness),
    "review:toResearch": (id, target) => review.toResearch(id, target),
    "ideas:start": (req) => ideas.start(req),
    "ideas:cancel": (id) => ideas.cancel(id),
    "ideas:list": () => ideas.list(),
    "ideas:delete": (id) => ideas.delete(id),
    "ideas:check": (id, ideaId) => ideas.check(id, ideaId ?? undefined),
    "ideas:consent": () => ideas.consent(),
    "ideas:grantConsent": () => ideas.grantConsent(),
    "ideas:settings": () => ideas.settings(),
    "ideas:setSettings": (patch) => ideas.setSettings(patch),
    "ideas:toEvidence": (id, ideaIds, name) => ideas.toEvidence(id, ideaIds, name),
    "ideas:toResearch": (id, ideaId) => ideas.toResearch(id, ideaId),
    "ideas:export": (id) => ideas.export(id),
    "paper:disclosure": () => services.disclosure(),
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
