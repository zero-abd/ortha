import type { WebClient, WebPage, WebSearchResult } from "@ortha/contracts";

/**
 * General web access the agent calls as tools (web_search / web_scrape). Both run
 * server-side from the Worker, are keyless, and work identically for every LLM
 * provider — which is the whole point: a provider's built-in grounding can't be
 * combined with the agent's function tools (Gemini rejects it outright), so the
 * web capability has to be an app-executed tool.
 *
 *   search → DuckDuckGo HTML endpoint (keyless), parsed into ranked results.
 *   scrape → Jina Reader (https://r.jina.ai/<url>) — keyless, returns clean
 *            markdown and handles JS-rendered pages a raw fetch can't.
 */

export interface WebClientDeps {
  /** Cap on returned page markdown, to protect the model's context window. Default 8000. */
  maxPageChars?: number;
  /** Max search results returned. Default 8. */
  maxResults?: number;
  /** Per-request timeout in ms. Default 20000. */
  timeoutMs?: number;
  /**
   * Hard wall-clock timeout per scrape in ms. Default 10000 — tighter than the
   * generic request timeout so one slow page can't stall a research turn. The
   * Jina `X-Timeout` header bounds server-side render time but doesn't guarantee
   * a fast client-side abort, so we wrap the fetch in our own AbortController.
   */
  scrapeTimeoutMs?: number;
  /** Max concurrent scrapes for scrapeMany. Default 4. */
  scrapeConcurrency?: number;
  /**
   * Optional Jina reader API key (a single Worker secret, not a per-user key).
   * Keyless works for light use, but the free shared tier rate-limits (429) under
   * the Worker's shared IP on bursty multi-page reads; a key lifts that limit for
   * everyone with zero per-user setup.
   */
  jinaApiKey?: string;
  /** Injectable fetch (tests). Defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const DDG = "https://html.duckduckgo.com/html/";
const READER = "https://r.jina.ai/";
const JINA_SEARCH = "https://s.jina.ai/";

/**
 * Hosts that reliably block automated access. Reading these wastes the full
 * scrape timeout on a guaranteed dead end (a login wall or 999 challenge), so
 * scrape() short-circuits IMMEDIATELY with a clear error instead. Matched on the
 * registrable domain, so www.linkedin.com and linkedin.com both hit.
 */
const BLOCKED_DOMAINS: ReadonlySet<string> = new Set([
  "linkedin.com",
  "facebook.com",
  "instagram.com",
  "x.com",
  "twitter.com",
]);

/**
 * Best-effort registrable domain (eTLD+1) for blocklist matching. Without a
 * public-suffix list we take the last two labels, which covers the flat
 * `example.com`-style hosts in the blocklist (www/sub-domains collapse to the
 * same key). Multi-level TLDs (e.g. co.uk) aren't in the blocklist, so the
 * naive heuristic is sufficient here.
 */
function registrableDomain(host: string): string {
  const h = host.toLowerCase().replace(/\.$/, "");
  const parts = h.split(".");
  return parts.length <= 2 ? h : parts.slice(-2).join(".");
}

/** Decode DuckDuckGo's `//duckduckgo.com/l/?uddg=<encoded>` redirect to the real URL. */
function resolveDdgHref(href: string): string {
  const uddg = href.match(/[?&]uddg=([^&]+)/);
  if (uddg) {
    try {
      return decodeURIComponent(uddg[1]!);
    } catch {
      /* fall through */
    }
  }
  return href.startsWith("//") ? `https:${href}` : href;
}

/** Strip HTML tags and decode the handful of entities DDG emits. */
function stripHtml(s: string): string {
  return s
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function createWebClient(deps: WebClientDeps = {}): WebClient {
  const doFetch = deps.fetchImpl ?? fetch;
  const maxPageChars = deps.maxPageChars ?? 8000;
  const maxResults = deps.maxResults ?? 8;
  const timeoutMs = deps.timeoutMs ?? 20_000;
  const scrapeTimeoutMs = deps.scrapeTimeoutMs ?? 10_000;
  const scrapeConcurrency = Math.max(1, deps.scrapeConcurrency ?? 4);

  // A timed-out abort and a server failure are distinguishable: we tag the
  // controller so the catch can throw a clear "timed out" error rather than a
  // generic abort, matching how the agent loop surfaces scrape failures.
  async function get(
    url: string,
    accept: string,
    extra: Record<string, string> = {},
    timeout = timeoutMs,
  ): Promise<Response> {
    const ctrl = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      ctrl.abort();
    }, timeout);
    try {
      return await doFetch(url, { headers: { "User-Agent": UA, Accept: accept, ...extra }, signal: ctrl.signal });
    } catch (err) {
      if (timedOut) throw new Error(`timed out after ${timeout}ms`);
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async search(query: string): Promise<readonly WebSearchResult[]> {
      const q = query.trim();
      if (!q) return [];

      // With a Jina key, search via Jina (keyed → no per-IP burst limit, returns
      // JSON). Keyless falls back to scraping DuckDuckGo's HTML endpoint.
      if (deps.jinaApiKey) {
        // `X-Respond-With: no-content` returns the SERP (title/url/description)
        // WITHOUT fetching every result's full page — ~2x faster and ~70x smaller
        // than the default. The agent scrapes the specific results it wants next.
        const res = await get(`${JINA_SEARCH}?q=${encodeURIComponent(q)}`, "application/json", {
          Authorization: `Bearer ${deps.jinaApiKey}`,
          "X-Respond-With": "no-content",
        });
        if (!res.ok) throw new Error(`search failed (${res.status})`);
        const body = (await res.json()) as { data?: { title?: string; url?: string; description?: string; content?: string }[] };
        const docs = Array.isArray(body.data) ? body.data : [];
        return docs.slice(0, maxResults).map((d) => ({
          title: (d.title ?? d.url ?? "Untitled").slice(0, 300),
          url: d.url ?? "",
          snippet: (d.description ?? d.content ?? "").replace(/\s+/g, " ").trim().slice(0, 500),
        }));
      }

      const res = await get(`${DDG}?q=${encodeURIComponent(q)}`, "text/html");
      if (!res.ok) throw new Error(`search failed (${res.status})`);
      const html = await res.text();

      const linkRe = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>(.*?)<\/a>/g;
      const snipRe = /class="result__snippet"[^>]*>(.*?)<\/a>/g;
      const snippets: string[] = [];
      let s: RegExpExecArray | null;
      while ((s = snipRe.exec(html))) snippets.push(stripHtml(s[1]!));

      const out: WebSearchResult[] = [];
      let m: RegExpExecArray | null;
      let i = 0;
      while ((m = linkRe.exec(html)) && out.length < maxResults) {
        const url = resolveDdgHref(m[1]!);
        const title = stripHtml(m[2]!);
        if (url && title) out.push({ title, url, snippet: snippets[i] ?? "" });
        i++;
      }
      return out;
    },

    async scrape(url: string): Promise<WebPage> {
      const target = url.trim();
      if (!/^https?:\/\//i.test(target)) throw new Error("scrape requires an absolute http(s) URL");
      // Short-circuit hosts that always block bots, so we don't burn the full
      // scrape timeout hitting a guaranteed login wall / challenge page.
      let host: string;
      try {
        host = new URL(target).hostname;
      } catch {
        throw new Error("scrape requires an absolute http(s) URL");
      }
      if (BLOCKED_DOMAINS.has(registrableDomain(host))) {
        throw new Error(`cannot read ${host} (blocks automated access)`);
      }
      // Strip image data (the LLM can't use it and it bloats the markdown) and
      // bound Jina's own render time so a slow page can't hang the tool. A hard
      // client-side abort (scrapeTimeoutMs) backstops the X-Timeout header so a
      // single slow page can't stall the research turn.
      const readerHeaders: Record<string, string> = { "X-Retain-Images": "none", "X-Timeout": "15" };
      if (deps.jinaApiKey) readerHeaders["Authorization"] = `Bearer ${deps.jinaApiKey}`;
      let res: Response;
      try {
        res = await get(`${READER}${target}`, "text/markdown", readerHeaders, scrapeTimeoutMs);
      } catch (err) {
        if (err instanceof Error && /timed out/.test(err.message)) {
          throw new Error(`scrape timed out reading ${target} (${scrapeTimeoutMs}ms)`);
        }
        throw err;
      }
      if (!res.ok) throw new Error(`could not read ${target} (${res.status})`);
      const raw = (await res.text()).trim();
      // Jina prepends "Title: …\nURL Source: …\nMarkdown Content:\n". Lift the title.
      const titleMatch = raw.match(/^Title:\s*(.+)$/m);
      const truncated = raw.length > maxPageChars;
      return {
        url: target,
        ...(titleMatch ? { title: titleMatch[1]!.trim() } : {}),
        markdown: truncated ? `${raw.slice(0, maxPageChars)}\n\n…[truncated]` : raw,
        truncated,
      };
    },

    async scrapeMany(urls: readonly string[]): Promise<readonly PromiseSettledResult<WebPage>[]> {
      // Bounded-concurrency fan-out so a research turn can read several pages at
      // once without opening dozens of sockets. Order of results matches `urls`;
      // each entry is a settled result so one failure never sinks the batch.
      const results: PromiseSettledResult<WebPage>[] = new Array(urls.length);
      let next = 0;
      const worker = async (): Promise<void> => {
        while (true) {
          const i = next++;
          if (i >= urls.length) return;
          try {
            results[i] = { status: "fulfilled", value: await this.scrape(urls[i]!) };
          } catch (reason) {
            results[i] = { status: "rejected", reason };
          }
        }
      };
      const workers = Array.from({ length: Math.min(scrapeConcurrency, urls.length) }, worker);
      await Promise.all(workers);
      return results;
    },
  };
}
