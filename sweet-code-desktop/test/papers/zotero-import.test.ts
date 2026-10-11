// Run: npm test
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { PaperDoc, PaperEvent } from "../../src/shared/types.ts";
import { Dispatcher } from "../../src/main/dispatch/scheduler.ts";
import { PaperService } from "../../src/main/papers/service.ts";

function setup() {
  const base = realpathSync(mkdtempSync(path.join(os.tmpdir(), "sikeoop-zimport-")));
  const project = path.join(base, "project");
  const userData = path.join(base, "userData");
  mkdirSync(project);
  const events: PaperEvent[] = [];
  const svc = new PaperService({
    userData: () => userData,
    root: () => project,
    development: () => true,
    fetch: (async () => new Response("", { status: 500 })) as unknown as typeof fetch,
    dispatcher: new Dispatcher({ emit: () => {} }),
    emit: (e) => events.push(e),
    // Stands in for the model: a claim quoted word for word from the paper's one section.
    model: async () => JSON.stringify({ detail: "路由能省计算。", claims: [{ title: "延迟下降", detail: "平均下降 31%", quote: { sectionId: "s1", page: 1, excerpt: "Latency is reduced by 31% on average." } }] }),
    approveExport: async () => true,
  });
  const dir = path.join(userData, "papers", createHash("sha256").update(project).digest("hex").slice(0, 16));
  let reads = 0;
  // Reading a real PDF is pdf.ts's business; here the paper it would give is put in place directly.
  svc.import = async (source: unknown) => {
    reads++;
    const paper: PaperDoc = { id: `00000000-0000-4000-8000-00000000000${reads}`, title: "storage-file-name", authors: [], source: source as PaperDoc["source"], pages: 1, addedAt: 0, sections: [{ id: "s1", title: "Results", page: 1, text: "We compare two baselines. Latency is reduced by 31% on average." }] };
    mkdirSync(path.join(dir, paper.id), { recursive: true });
    writeFileSync(path.join(dir, paper.id, "paper.json"), JSON.stringify(paper));
    return paper;
  };
  const until = async (what: () => boolean) => {
    for (let i = 0; i < 400; i++) {
      if (what()) return;
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error("waited too long");
  };
  return { svc, dir, events, reads: () => reads, until };
}

test("a paper imported from Zotero carries Zotero's title, authors and citation key; importing it again reads nothing new", async () => {
  const t = setup();
  const meta = { citekey: "shili2024luyou", title: "按难度路由", authors: ["示例 作者甲"] };
  const paper = await t.svc.importFromZotero("/Users/me/Zotero/storage/ABCD/file.pdf", meta);
  assert.deepEqual([paper.citekey, paper.title, paper.authors, paper.source], ["shili2024luyou", "按难度路由", ["示例 作者甲"], { kind: "file", path: "/Users/me/Zotero/storage/ABCD/file.pdf" }]);
  assert.equal(JSON.parse(readFileSync(path.join(t.dir, paper.id, "paper.json"), "utf8")).citekey, "shili2024luyou");
  assert.deepEqual(t.events.at(-1), { type: "paper", paper });
  assert.deepEqual((await t.svc.list()).map((p) => p.citekey), ["shili2024luyou"]);

  const again = await t.svc.importFromZotero("/Users/me/Zotero/storage/ABCD/file.pdf", meta);
  assert.deepEqual([again.id, t.reads()], [paper.id, 1]);
  const bare = await t.svc.importFromZotero("/x/other.pdf", { citekey: "other2020", title: "", authors: [] });
  assert.deepEqual([bare.title, bare.citekey], ["storage-file-name", "other2020"], "without a title from Zotero the paper keeps its own");
});

test("evidence taken from a Zotero paper is referred to by its citation key", async () => {
  const t = setup();
  const paper = await t.svc.importFromZotero("/Users/me/Zotero/storage/ABCD/file.pdf", { citekey: "shili2024luyou", title: "按难度路由", authors: [] });
  const task = await t.svc.start("extract", [paper.id]);
  await t.until(() => !["queued", "running"].includes(t.svc.taskList().find((x) => x.id === task.id)!.status));
  const done = t.svc.taskList().find((x) => x.id === task.id)!;
  assert.equal(done.status, "done", done.error);
  assert.deepEqual(done.records!.map((r) => [r.ref, r.title, r.claims.length]), [["shili2024luyou", "按难度路由", 1]]);
});
