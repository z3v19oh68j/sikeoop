// Run: npm test
import test from "node:test";
import assert from "node:assert/strict";
import { ScholarSearch, abstractFromIndex, mergeWorks, openAlexUrl, parseOpenAlex, parseSemanticScholar, semanticScholarUrl } from "../../src/main/papers/openalex.ts";

// Made-up responses in the shape of the two services' search results.
const OPENALEX = {
  meta: { count: 2 },
  results: [
    {
      id: "https://openalex.org/W1000000001", doi: "https://doi.org/10.0000/sample.1", display_name: "  Routing  Tokens by\nDifficulty ", publication_year: 2024, cited_by_count: 12,
      authorships: [{ author: { display_name: "A. Sample" } }, { author: { display_name: "B. Example" } }, { author: null }],
      primary_location: { landing_page_url: "https://example.org/p/1", source: { display_name: "Sample Conference" } },
      abstract_inverted_index: { We: [0], route: [1], tokens: [2, 5], by: [3], difficulty: [4] },
    },
    { id: "https://openalex.org/W1000000002", doi: null, display_name: "No DOI Here", publication_year: null, authorships: [], primary_location: null, abstract_inverted_index: null },
    { id: "W-bad", doi: "javascript:alert(1)", display_name: "Bad link" },
    { id: "https://openalex.org/W1000000003", display_name: "" },
    null,
  ],
};

test("OpenAlex results become works: title, year, link, authors, venue, citations, abstract", () => {
  const works = parseOpenAlex(OPENALEX);
  assert.deepEqual(works[0], {
    title: "Routing Tokens by Difficulty", year: 2024, url: "https://doi.org/10.0000/sample.1", authors: ["A. Sample", "B. Example"],
    venue: "Sample Conference", citedBy: 12, abstract: "We route tokens by difficulty tokens", source: "openalex",
  });
  assert.deepEqual(works[1], { title: "No DOI Here", year: null, url: "https://openalex.org/W1000000002", authors: [], source: "openalex" });
  assert.equal(works.length, 2, "entries without a title or a real link are left out");
  assert.throws(() => parseOpenAlex({ error: "rate limited" }), /不是论文列表/);
  assert.throws(() => parseOpenAlex(null), /不是论文列表/);
});

test("an inverted abstract is put back in order and cut", () => {
  assert.equal(abstractFromIndex({ b: [1], a: [0], c: [3] }), "a b c");
  assert.equal(abstractFromIndex(null), "");
  assert.equal(abstractFromIndex({ x: "oops", y: [-1, 99999] }), "");
  assert.ok(abstractFromIndex(Object.fromEntries(Array.from({ length: 400 }, (_, i) => [`word${i}`, [i]]))).length <= 600);
});

test("Semantic Scholar results are read the same way", () => {
  const works = parseSemanticScholar({ data: [{ title: "S2 Paper", year: 2023, url: "https://www.semanticscholar.org/paper/abc", authors: [{ name: "C. Demo" }], venue: "", citationCount: 5, abstract: "An abstract." }, { title: "no url" }] });
  assert.deepEqual(works, [{ title: "S2 Paper", year: 2023, url: "https://www.semanticscholar.org/paper/abc", authors: ["C. Demo"], citedBy: 5, abstract: "An abstract.", source: "semantic_scholar" }]);
  assert.throws(() => parseSemanticScholar({}), /不是论文列表/);
});

test("the request addresses: a mailto only when it is an address", () => {
  const u = new URL(openAlexUrl("dynamic routing small models", "me@example.org"));
  assert.equal(u.origin + u.pathname, "https://api.openalex.org/works");
  assert.deepEqual([u.searchParams.get("search"), u.searchParams.get("per-page"), u.searchParams.get("mailto")], ["dynamic routing small models", "5", "me@example.org"]);
  assert.equal(new URL(openAlexUrl("q", "")).searchParams.has("mailto"), false);
  assert.equal(new URL(openAlexUrl("q", "not an email")).searchParams.has("mailto"), false);
  assert.equal(new URL(semanticScholarUrl("q")).hostname, "api.semanticscholar.org");
});

test("result lists are merged round-robin without repeating a title", () => {
  const w = (title: string) => ({ title, year: 2020, url: `https://example.org/${title}`, authors: [], source: "openalex" as const });
  const merged = mergeWorks([[w("A"), w("B"), w("C")], [w("a"), w("D"), w("E"), w("F")]], 4);
  assert.deepEqual(merged.map((x) => x.title), ["A", "B", "D", "C"]);
});

function fakeFetch(bodies: Record<string, unknown>) {
  const calls: { url: string; key?: string }[] = [];
  const fetcher = (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    calls.push({ url: u, key: (init?.headers as Record<string, string> | undefined)?.["x-api-key"] });
    const body = bodies[new URL(u).hostname];
    return { ok: body !== undefined, status: body === undefined ? 503 : 200, json: async () => body } as Response;
  }) as typeof fetch;
  return { fetcher, calls };
}

test("searching needs the user's consent, spaces requests out, and sends the e-mail only when set", async () => {
  const { fetcher, calls } = fakeFetch({ "api.openalex.org": OPENALEX });
  let agreed = false;
  const slept: number[] = [];
  const s = new ScholarSearch({ fetch: fetcher, consent: async () => agreed, mailto: async () => "me@example.org", semanticScholarKey: () => undefined, sleep: async (ms) => void slept.push(ms) });
  await assert.rejects(s.search(["q"]), /先阅读并同意/);
  assert.equal(calls.length, 0, "nothing leaves before consent");

  agreed = true;
  const works = await s.search(["first query", "second query", "third", "fourth is ignored"]);
  assert.deepEqual(works.map((w) => w.title), ["Routing Tokens by Difficulty", "No DOI Here"]);
  assert.equal(calls.length, 3, "at most three phrases are searched");
  assert.ok(calls.every((c) => c.url.includes("mailto=me%40example.org") && c.key === undefined));
  assert.ok(slept.slice(1).every((ms) => ms > 900), "about a second between requests");
});

test("Semantic Scholar is searched too when there is a key; its failure doesn't fail the check", async () => {
  const both = fakeFetch({ "api.openalex.org": { results: [] }, "api.semanticscholar.org": { data: [{ title: "Only on S2", year: 2022, url: "https://www.semanticscholar.org/paper/x", authors: [] }] } });
  const deps = { consent: async () => true, mailto: async () => "", semanticScholarKey: () => "secret-key", sleep: async () => {} };
  const works = await new ScholarSearch({ fetch: both.fetcher, ...deps }).search(["q"]);
  assert.deepEqual(works.map((w) => [w.title, w.source]), [["Only on S2", "semantic_scholar"]]);
  assert.deepEqual(both.calls.map((c) => [new URL(c.url).hostname, c.key]), [["api.openalex.org", undefined], ["api.semanticscholar.org", "secret-key"]], "the key goes only to Semantic Scholar");
  assert.ok(!both.calls[0].url.includes("mailto"));

  const down = fakeFetch({ "api.openalex.org": OPENALEX });
  assert.equal((await new ScholarSearch({ fetch: down.fetcher, ...deps }).search(["q"])).length, 2);
  await assert.rejects(new ScholarSearch({ fetch: fakeFetch({}).fetcher, ...deps }).search(["q"]), /api\.openalex\.org 暂时无法访问（503）/);
});
