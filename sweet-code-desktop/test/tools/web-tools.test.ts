// Run: node --test test/tools/web-tools.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { cameFromSearch, webTools, type SearchConfig } from "../../src/main/tools/web-tools.ts";
import type { ToolContext } from "../../src/main/tools/registry.ts";

const ctx = { signal: new AbortController().signal } as ToolContext;

const DDG = `<html><body>
<div class="result"><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2FExample.com%2Fdocs%3Fa%3D1&amp;rut=x">Example <b>Docs</b></a>
<a class="result__snippet" href="#">First <b>snippet</b> text</a></div>
<div class="result"><a rel="nofollow" class="result__a" href="https://second.example/page">Second</a>
<div class="result__snippet">Second snippet</div></div>
</body></html>`;

function search(config: SearchConfig, fetcher: (url: string) => Promise<Response>) {
  return webTools(fetcher, () => config).find((t) => t.name === "web_search")!;
}

test("DuckDuckGo results keep their own snippets", async () => {
  const tool = search({ engine: "duckduckgo", apiKey: "" }, async () => new Response(DDG));
  const out = await tool.run({ query: "example docs" }, ctx);
  assert.match(out, /1\. Example Docs\n {3}https:\/\/Example\.com\/docs\?a=1\n {3}First snippet text/);
  assert.match(out, /2\. Second\n {3}https:\/\/second\.example\/page\n {3}Second snippet/);
});

test("a search result written slightly differently still counts as from the search", async () => {
  const tool = search({ engine: "duckduckgo", apiKey: "" }, async () => new Response(DDG));
  await tool.run({ query: "example docs" }, ctx);
  assert.ok(cameFromSearch("https://example.com/docs?a=1#intro"));
  assert.ok(cameFromSearch("https://SECOND.example/page"));
  assert.ok(!cameFromSearch("https://evil.example/?data=1"));
});

test("a chosen engine without a key says DuckDuckGo was used instead", async () => {
  const tool = search({ engine: "tavily", apiKey: "" }, async (url) => {
    assert.match(url, /duckduckgo/);
    throw new Error("network down");
  });
  const out = await tool.run({ query: "anything" }, ctx);
  assert.match(out, /Search failed: network down\./);
  assert.match(out, /Tavily is chosen in settings but has no key/);
});
