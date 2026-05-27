// General web access for the agent: search the open web + read a specific page.
// Unlike the Orthogonal catalog (paid, discovered at runtime), these are
// always-on built-in tools the agent itself calls — executed server-side and
// identical across every LLM provider (which is why they work on Gemini too,
// where the provider's own grounding can't coexist with function tools).

export interface WebSearchResult {
  readonly title: string;
  readonly url: string;
  /** A short snippet/description of the page. */
  readonly snippet: string;
}

export interface WebPage {
  readonly url: string;
  readonly title?: string;
  /** The page rendered as clean markdown (may be truncated by the implementation). */
  readonly markdown: string;
  /** True when the implementation truncated the content to protect the context window. */
  readonly truncated: boolean;
}

export interface WebClient {
  /** Search the open web; returns ranked results with title, url, and snippet. */
  search(query: string): Promise<readonly WebSearchResult[]>;
  /** Fetch and read a single URL as clean markdown. */
  scrape(url: string): Promise<WebPage>;
}
