import { describe, expect, it } from "vitest";
import { domainOf, extractSources } from "../src/lib/sources.ts";
import type { TraceStep } from "../src/types.ts";

/** Build a minimal trace step with sensible defaults. */
function step(over: Partial<TraceStep>): TraceStep {
  return { stepId: "s", status: "success", ...over };
}

const scrape = (url: string, summaryUrl = url): TraceStep =>
  step({ api: "web", path: url, summary: `read ${summaryUrl} (1234 chars)` });

const search = (query: string): TraceStep =>
  step({ api: "web", path: `search: "${query}"`, summary: `3 web results for "${query}"` });

describe("extractSources", () => {
  it("extracts the URLs of scraped pages, in order", () => {
    const sources = extractSources([scrape("https://stripe.com/about"), scrape("http://example.org/x")]);
    expect(sources).toEqual([
      { url: "https://stripe.com/about", domain: "stripe.com" },
      { url: "http://example.org/x", domain: "example.org" },
    ]);
  });

  it("dedupes a URL read more than once, keeping first-seen order", () => {
    const sources = extractSources([
      scrape("https://a.com/1"),
      scrape("https://b.com/2"),
      scrape("https://a.com/1"),
    ]);
    expect(sources.map((s) => s.url)).toEqual(["https://a.com/1", "https://b.com/2"]);
  });

  it("falls back to parsing the URL out of a scrape's `read <url>` summary when path isn't a URL", () => {
    // A scrape with no resolved URL in `path` still records the page from its summary.
    const noPath = step({ api: "web", path: "scrape", summary: "read https://news.example.com/post (900 chars)" });
    expect(extractSources([noPath])).toEqual([
      { url: "https://news.example.com/post", domain: "news.example.com" },
    ]);
  });

  it("returns nothing for a search-only turn (search steps carry no page URL)", () => {
    expect(extractSources([search("who is the CEO of Stripe"), search("stripe funding")])).toEqual([]);
  });

  it("ignores non-web steps entirely", () => {
    const apiStep = step({ api: "people-search", path: "/v1/enrich", summary: "read https://leaked.example/x (10 chars)" });
    expect(extractSources([apiStep, scrape("https://real.com/p")])).toEqual([
      { url: "https://real.com/p", domain: "real.com" },
    ]);
  });

  it("is safe when web steps have no URL and malformed summaries", () => {
    const steps: TraceStep[] = [
      step({ api: "web", path: "scrape" }), // no path URL, no summary
      step({ api: "web", path: "scrape", summary: "read (missing url)" }),
      step({ api: "web", path: "search: \"x\"", summary: "0 web results for \"x\"" }),
      step({ api: "web", path: "ftp://nope.example/file", summary: "read ftp://nope.example/file (5 chars)" }),
    ];
    expect(extractSources(steps)).toEqual([]);
  });

  it("handles an empty trace", () => {
    expect(extractSources([])).toEqual([]);
  });
});

describe("domainOf", () => {
  it("strips the scheme and leading www.", () => {
    expect(domainOf("https://www.openai.com/blog")).toBe("openai.com");
    expect(domainOf("http://example.org")).toBe("example.org");
  });

  it("degrades gracefully on a non-URL string", () => {
    expect(domainOf("not a url")).toBe("not a url");
    expect(domainOf("www.bare.com/path")).toBe("bare.com");
  });
});
