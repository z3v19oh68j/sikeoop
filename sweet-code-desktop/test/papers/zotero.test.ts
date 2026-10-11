// Run: npm test
import test from "node:test";
import assert from "node:assert/strict";
import { ZoteroClient, ZoteroUnreachable, caywQuery, collectionExportPath, parseAttachments, parseCollections, parseExport, parseZoteroItems, zoteroStatusOf, zoteroUrl } from "../../src/main/papers/zotero.ts";

test("every address is on Zotero's local server; anything else is refused", () => {
  assert.equal(zoteroUrl("/better-bibtex/cayw?probe=1"), "http://127.0.0.1:23119/better-bibtex/cayw?probe=1");
  for (const bad of ["//evil.example/better-bibtex/x", "/connector/ping", "@evil.example/better-bibtex/", "/better-bibtex/../../x", "/better-bibtex/a b", "http://evil.example/better-bibtex/"]) assert.throws(() => zoteroUrl(bad), /地址不正确/, bad);
  assert.equal(caywQuery("pandoc"), "format=pandoc&brackets=1");
  assert.equal(caywQuery("latex"), "format=latex&command=cite");
  assert.equal(collectionExportPath(1, "ABCD2345", "biblatex"), "/better-bibtex/collection?/1/ABCD2345.biblatex");
  assert.equal(collectionExportPath(42, "ABCD2345", "bibtex", true), "/better-bibtex/export/collection?/42/ABCD2345.bibtex");
  for (const [lib, key] of [[-1, "ABCD2345"], [1.5, "ABCD2345"], [1, "abcd2345"], [1, "../../etc"], [1, "ABCD2345/x"]] as const) assert.throws(() => collectionExportPath(lib, key, "bibtex"), /集合编号不正确/);
});

test("the status says in plain words what is missing and what to do", () => {
  const down = zoteroStatusOf(null);
  assert.deepEqual([down.state, down.steps.length > 0], ["not_running", true]);
  assert.match(down.message, /没有连上 Zotero/);
  const noBbt = zoteroStatusOf({ status: 404, body: "No endpoint found" });
  assert.equal(noBbt.state, "no_bbt");
  assert.ok(noBbt.steps.some((s) => s.includes(".xpi")));
  assert.equal(zoteroStatusOf({ status: 200, body: "something else" }).state, "no_bbt");
  const old = zoteroStatusOf({ status: 200, body: "ready" }, "missing");
  assert.deepEqual([old.state, /太旧/.test(old.message)], ["outdated", true]);
  const oldZotero = zoteroStatusOf({ status: 200, body: "ready\n" }, { zotero: "6.0.37", betterbibtex: "6.7.140" });
  assert.deepEqual([oldZotero.state, oldZotero.zotero], ["outdated", "6.0.37"]);
  assert.deepEqual(zoteroStatusOf({ status: 200, body: "ready" }, { zotero: "8.0.1", betterbibtex: "7.0.5" }), { state: "ready", zotero: "8.0.1", betterBibtex: "7.0.5", message: "", steps: [] });
  assert.equal(zoteroStatusOf({ status: 200, body: "ready" }, { zotero: 7, betterbibtex: null }).state, "outdated", "versions that aren't text don't count");
});

// Made-up answers in the shapes Better BibTeX's JSON-RPC gives.
const ITEMS = [
  { id: "http://zotero.org/users/1/items/AAAA1111", type: "article-journal", citekey: "vaswani2017", "citation-key": "vaswani2017", title: "Attention Is\n All You Need", author: [{ family: "Vaswani", given: "Ashish" }, { literal: "Google Brain Team" }], issued: { "date-parts": [[2017, 6, 12]] }, "container-title": "Advances in Neural Information Processing Systems" },
  { type: "book", citationKey: "knuth1984", title: "The TeXbook", creators: [{ lastName: "Knuth", firstName: "Donald E." }], date: "1984-01-01", publisher: "Addison-Wesley" },
  { type: "report", "citation-key": "anon2020", title: "No authors, raw date", issued: { raw: "circa 2020" } },
  { type: "webpage", citekey: "noyear", title: "No date at all" },
  { type: "article", citekey: "bad key!", title: "Unusable key" },
  { type: "article", citekey: "notitle" },
  null,
  "text",
];

test("search results become a list: key, title, authors, year, venue", () => {
  assert.deepEqual(parseZoteroItems(ITEMS), [
    { citekey: "vaswani2017", title: "Attention Is All You Need", authors: ["Ashish Vaswani", "Google Brain Team"], year: 2017, type: "article-journal", venue: "Advances in Neural Information Processing Systems" },
    { citekey: "knuth1984", title: "The TeXbook", authors: ["Donald E. Knuth"], year: 1984, type: "book", venue: "Addison-Wesley" },
    { citekey: "anon2020", title: "No authors, raw date", authors: [], year: 2020, type: "report" },
    { citekey: "noyear", title: "No date at all", authors: [], year: null, type: "webpage" },
  ]);
  assert.throws(() => parseZoteroItems({ error: "x" }), /不是文献列表/);
  assert.equal(parseZoteroItems(Array.from({ length: 80 }, (_, i) => ({ citekey: `k${i}`, title: `T${i}` }))).length, 50);
});

test("attachments, collections and exports are read from what the server gives", () => {
  assert.deepEqual(parseAttachments([{ open: "zotero://open-pdf/library/items/X", path: "/Users/me/Zotero/storage/X/paper.pdf" }, { path: "/Users/me/Zotero/storage/Y/snapshot.html" }, { path: 3 }, null]), ["/Users/me/Zotero/storage/X/paper.pdf"]);
  assert.deepEqual(parseAttachments(undefined), []);

  const flat = [{ id: 1, name: "My Library", collections: [{ key: "AAAA1111", name: "博士论文", parentCollection: false }, { key: "BBBB2222", name: "第二章", parentCollection: "AAAA1111" }, { key: "bad", name: "x" }] }, { id: 7, name: "课题组", collections: null }];
  assert.deepEqual(parseCollections(flat), [
    { libraryId: 1, library: "My Library", key: "AAAA1111", name: "博士论文", path: "博士论文" },
    { libraryId: 1, library: "My Library", key: "BBBB2222", name: "第二章", path: "博士论文 / 第二章" },
  ]);
  const nested = [{ id: 2, name: "Group", collections: [{ key: "CCCC3333", data: { name: "Top" }, children: [{ key: "DDDD4444", name: "Inner" }] }] }];
  assert.deepEqual(parseCollections(nested).map((c) => c.path), ["Top", "Top / Inner"]);
  assert.throws(() => parseCollections("nope"), /不是文献库列表/);

  assert.equal(parseExport("@article{a,\n}"), "@article{a,\n}");
  assert.equal(parseExport([200, { "Content-Type": "text/plain" }, "@article{a,\n}"]), "@article{a,\n}", "older versions wrapped it in a list");
  assert.throws(() => parseExport({ nope: true }), /没有返回参考文献/);
});

/** A stand-in for Zotero's local server. */
function server(handlers: { get?(path: string): { status?: number; body: string } | undefined; rpc?(method: string, params: unknown[]): unknown }) {
  const calls: { url: string; method: string; headers: Record<string, string>; redirect?: string; rpc?: string; params?: unknown[] }[] = [];
  const fetcher = (async (url: string | URL, init: RequestInit = {}) => {
    const u = new URL(String(url));
    const call = { url: String(url), method: init.method ?? "GET", headers: init.headers as Record<string, string>, redirect: init.redirect as string | undefined } as (typeof calls)[number];
    calls.push(call);
    if (init.method === "POST") {
      const body = JSON.parse(String(init.body)) as { method: string; params: unknown[] };
      call.rpc = body.method;
      call.params = body.params;
      try {
        return new Response(JSON.stringify({ jsonrpc: "2.0", result: handlers.rpc?.(body.method, body.params), id: 1 }), { status: 200 });
      } catch (err) {
        return new Response(JSON.stringify({ jsonrpc: "2.0", error: { code: -32602, message: (err as Error).message }, id: 1 }), { status: 200 });
      }
    }
    const got = handlers.get?.(u.pathname + u.search);
    return new Response(got?.body ?? "No endpoint found", { status: got ? (got.status ?? 200) : 404 });
  }) as typeof fetch;
  return { client: new ZoteroClient(fetcher), calls };
}
const refused = (async () => {
  throw new TypeError("fetch failed");
}) as unknown as typeof fetch;

test("the client only talks to 127.0.0.1:23119, refuses redirects, and says it is a meant request", async () => {
  const s = server({ get: (p) => (p === "/better-bibtex/cayw?probe=1" ? { body: "ready" } : undefined), rpc: (m) => (m === "api.ready" ? { zotero: "7.0.11", betterbibtex: "6.7.230" } : []) });
  assert.deepEqual(await s.client.status(), { state: "ready", zotero: "7.0.11", betterBibtex: "6.7.230", message: "", steps: [] });
  await s.client.search("attention");
  assert.ok(s.calls.every((c) => c.url.startsWith("http://127.0.0.1:23119/better-bibtex/") && c.redirect === "error" && c.headers["Zotero-Allowed-Request"] === "1"));
  assert.deepEqual(s.calls.map((c) => c.rpc ?? c.method), ["GET", "api.ready", "item.search"]);
  assert.deepEqual(s.calls[2].params, ["attention"]);

  assert.equal((await new ZoteroClient(refused).status()).state, "not_running");
  await assert.rejects(new ZoteroClient(refused).search("x"), ZoteroUnreachable);
  assert.equal((await server({}).client.status()).state, "no_bbt");
  assert.equal((await server({ get: () => ({ body: "ready" }), rpc: () => { throw new Error("Method not found"); } }).client.status()).state, "outdated");
});

test("the picker: Zotero writes the citation in the asked-for syntax; closing it without a choice is null", async () => {
  const s = server({ get: (p) => (p.includes("format=pandoc") ? { body: "[@vaswani2017; @knuth1984]" } : p.includes("format=latex") ? { body: "" } : undefined) });
  const signal = new AbortController().signal;
  assert.deepEqual(await s.client.pick("pandoc", signal), { text: "[@vaswani2017; @knuth1984]", keys: ["vaswani2017", "knuth1984"], style: "pandoc" });
  assert.equal(await s.client.pick("latex", signal), null);
  assert.deepEqual(s.calls.map((c) => c.url), ["http://127.0.0.1:23119/better-bibtex/cayw?format=pandoc&brackets=1", "http://127.0.0.1:23119/better-bibtex/cayw?format=latex&command=cite"]);
  await assert.rejects(server({}).client.pick("pandoc", signal), /没有找到 Better BibTeX 的引用选择框/);

  // Stopped waiting: the request is aborted and says so.
  const waiting = new AbortController();
  const hung = new ZoteroClient(((_url: string, init: RequestInit) => new Promise((_res, rej) => init.signal!.addEventListener("abort", () => rej(new Error("aborted"))))) as unknown as typeof fetch);
  const pick = hung.pick("pandoc", waiting.signal);
  waiting.abort();
  await assert.rejects(pick, /已取消/);
});

test("exporting keys: all at once, and one at a time after a refusal to find the keys Zotero doesn't have", async () => {
  const known: Record<string, string> = { a2020: "@article{a2020,\n}", b2021: "@book{b2021,\n}" };
  const s = server({
    rpc: (method, params) => {
      assert.equal(method, "item.export");
      const [keys, translator] = params as [string[], string];
      assert.equal(translator, "biblatex");
      const missing = keys.filter((k) => !known[k]);
      if (missing.length) throw new Error(`citekey ${missing[0]} not found`);
      return keys.map((k) => known[k]).join("\n\n");
    },
  });
  assert.deepEqual(await s.client.exportKnown(["a2020", "b2021"], "biblatex"), { bib: "@article{a2020,\n}\n\n@book{b2021,\n}", missing: [] });
  assert.equal(s.calls.length, 1);
  assert.deepEqual(await s.client.exportKnown(["a2020", "ghost", "b2021"], "biblatex"), { bib: "@article{a2020,\n}\n\n@book{b2021,\n}", missing: ["ghost"] });
  assert.deepEqual(await s.client.exportKnown([], "biblatex"), { bib: "", missing: [] });
  await assert.rejects(new ZoteroClient(refused).exportKnown(["a2020"], "bibtex"), ZoteroUnreachable, "Zotero being closed is not 'every key is missing'");

  // An older version that knows the translator only by its full name.
  const old = server({ rpc: (_m, params) => { if ((params as [string[], string])[1] === "bibtex") throw new Error("translator bibtex not found"); return `full name: ${(params as [string[], string])[1]}`; } });
  assert.equal(await old.client.exportKeys(["a2020"], "bibtex"), "full name: Better BibTeX");
});

test("a collection is exported by pull export, with the newer address as a second try", async () => {
  const first = server({ get: (p) => (p === "/better-bibtex/collection?/1/ABCD2345.biblatex" ? { body: "@article{x,\n}" } : undefined) });
  assert.equal(await first.client.exportCollection(1, "ABCD2345", "biblatex"), "@article{x,\n}");
  const second = server({ get: (p) => (p === "/better-bibtex/export/collection?/1/ABCD2345.bibtex" ? { body: "@article{y,\n}" } : undefined) });
  assert.equal(await second.client.exportCollection(1, "ABCD2345", "bibtex"), "@article{y,\n}");
  assert.equal(second.calls.length, 2);
  await assert.rejects(server({ get: () => ({ status: 500, body: "collection not found" }) }).client.exportCollection(1, "ABCD2345", "bibtex"), /没能导出这个集合（500）：collection not found/);
  const groups = server({ rpc: (m, params) => (m === "user.groups" && (params as unknown[])[0] === true ? [{ id: 1, name: "My Library", collections: [{ key: "ABCD2345", name: "论文" }] }] : null) });
  assert.deepEqual(await groups.client.collections(), [{ libraryId: 1, library: "My Library", key: "ABCD2345", name: "论文", path: "论文" }]);
});
