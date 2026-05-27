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

  async function get(url: string, accept: string, extra: Record<string, string> = {}): Promise<Response> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      return await doFetch(url, { headers: { "User-Agent": UA, Accept: accept, ...extra }, signal: ctrl.signal });
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
        const res = await get(`${JINA_SEARCH}?q=${encodeURIComponent(q)}`, "application/json", {
          Authorization: `Bearer ${deps.jinaApiKey}`,
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
      const auth = deps.jinaApiKey ? { Authorization: `Bearer ${deps.jinaApiKey}` } : {};
      const res = await get(`${READER}${target}`, "text/markdown", auth);
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
  };
}
