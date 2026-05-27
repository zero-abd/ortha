import { describe, expect, it } from "vitest";
import { createWebClient } from "../src/web.js";

const DDG_HTML = `
<div class="result">
  <h2 class="result__title"><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa&amp;rut=abc">Example <b>One</b></a></h2>
  <a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa">First <b>snippet</b> &amp; more.</a>
</div>
<div class="result">
  <h2 class="result__title"><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.org%2Fb">Example Two</a></h2>
  <a class="result__snippet">Second snippet.</a>
</div>`;

const JINA_MD = `Title: Example Domain\nURL Source: https://example.com\nMarkdown Content:\n# Example Domain\n\nThis domain is for use in examples.`;

function fakeFetch(routes: Record<string, { status?: number; body: string }>): typeof fetch {
  return (async (url: string | URL | Request) => {
    const u = String(url);
    const key = Object.keys(routes).find((k) => u.includes(k));
    const r = key ? routes[key]! : { status: 404, body: "not found" };
    return new Response(r.body, { status: r.status ?? 200 });
  }) as unknown as typeof fetch;
}

describe("createWebClient.search (DuckDuckGo)", () => {
  it("parses results and decodes the uddg redirect to the real URL", async () => {
    const web = createWebClient({ fetchImpl: fakeFetch({ "html.duckduckgo.com": { body: DDG_HTML } }) });
    const results = await web.search("example");
    expect(results).toHaveLength(2);
    expect(results[0]).toEqual({ title: "Example One", url: "https://example.com/a", snippet: "First snippet & more." });
    expect(results[1]!.url).toBe("https://example.org/b");
  });

  it("returns [] for a blank query without calling out", async () => {
    let called = false;
    const web = createWebClient({ fetchImpl: (async () => { called = true; return new Response(""); }) as unknown as typeof fetch });
    expect(await web.search("   ")).toEqual([]);
    expect(called).toBe(false);
  });

  it("throws on a non-OK search response", async () => {
    const web = createWebClient({ fetchImpl: fakeFetch({ "html.duckduckgo.com": { status: 503, body: "" } }) });
    await expect(web.search("x")).rejects.toThrow(/search failed \(503\)/);
  });
});

describe("createWebClient.scrape (reader)", () => {
  it("reads a page to markdown and lifts the title", async () => {
    const web = createWebClient({ fetchImpl: fakeFetch({ "r.jina.ai": { body: JINA_MD } }) });
    const page = await web.scrape("https://example.com");
    expect(page.url).toBe("https://example.com");
    expect(page.title).toBe("Example Domain");
    expect(page.markdown).toContain("# Example Domain");
    expect(page.truncated).toBe(false);
  });

  it("truncates oversized pages to protect the context window", async () => {
    const big = "Title: Big\n" + "x".repeat(50_000);
    const web = createWebClient({ maxPageChars: 1000, fetchImpl: fakeFetch({ "r.jina.ai": { body: big } }) });
    const page = await web.scrape("https://example.com");
    expect(page.truncated).toBe(true);
    expect(page.markdown.length).toBeLessThan(1100);
    expect(page.markdown).toContain("[truncated]");
  });

  it("rejects a non-http URL before fetching", async () => {
    const web = createWebClient();
    await expect(web.scrape("ftp://nope")).rejects.toThrow(/absolute http/);
  });
});
