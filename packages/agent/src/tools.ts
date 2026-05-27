import type { ToolSpec } from "@ortha/contracts";

/**
 * The four meta-tools the LLM is given. The agent is "self-extending": instead of
 * hard-wired integrations, the model discovers tools (search_tools), inspects them
 * (get_tool_details), executes them through the budgeted harness (run_tool), and
 * pulls the full out-of-context payload on demand (expand_result).
 */

export const SEARCH_TOOLS = "search_tools";
export const GET_TOOL_DETAILS = "get_tool_details";
export const RUN_TOOL = "run_tool";
export const EXPAND_RESULT = "expand_result";
export const WEB_SEARCH = "web_search";
export const WEB_SCRAPE = "web_scrape";

export const META_TOOLS: readonly ToolSpec[] = [
  {
    name: SEARCH_TOOLS,
    description:
      "Search Orthogonal's catalog of real-world APIs for tools that can answer the user's request. Returns matching APIs and their endpoints with prices.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Natural-language description of the capability you need." },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: GET_TOOL_DETAILS,
    description:
      "Fetch the full input/output schema, price, and side-effect class for one endpoint before calling it.",
    inputSchema: {
      type: "object",
      properties: {
        api: { type: "string", description: "The API slug, e.g. \"apollo\"." },
        path: { type: "string", description: "The endpoint path, e.g. \"/v1/people/match\"." },
      },
      required: ["api", "path"],
      additionalProperties: false,
    },
  },
  {
    name: RUN_TOOL,
    description:
      "Execute one endpoint. Spend is checked against the budget cap first; expensive or side-effecting calls may require user approval. Returns a compact summary; use expand_result for the full payload.",
    inputSchema: {
      type: "object",
      properties: {
        api: { type: "string", description: "The API slug." },
        path: { type: "string", description: "The endpoint path." },
        method: {
          type: "string",
          description: "HTTP method from get_tool_details (e.g. \"GET\"/\"POST\"). Disambiguates endpoints sharing a path for accurate pricing.",
        },
        body: { type: "object", description: "Request body, per the endpoint's input schema." },
        query: {
          type: "object",
          description: "Query-string parameters (string values only).",
          additionalProperties: { type: "string" },
        },
      },
      required: ["api", "path"],
      additionalProperties: false,
    },
  },
  {
    name: EXPAND_RESULT,
    description:
      "Retrieve the full raw payload of a previous tool call by its requestId, when the distilled summary is not enough.",
    inputSchema: {
      type: "object",
      properties: {
        requestId: { type: "string", description: "The requestId returned by a prior run_tool result." },
      },
      required: ["requestId"],
      additionalProperties: false,
    },
  },
  {
    name: WEB_SEARCH,
    description:
      "Search the open web for current, public, or general information. Always available and free — use it for anything not covered by a specialized Orthogonal endpoint (news, facts, who/what/where, finding pages to then read). Returns ranked results with title, url, and snippet.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "What to search the web for." },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: WEB_SCRAPE,
    description:
      "Fetch a single web page and read it as clean markdown. Use after web_search (or with a known URL) to read a page's actual contents. Always available and free.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "Absolute http(s) URL of the page to read." },
      },
      required: ["url"],
      additionalProperties: false,
    },
  },
];

export const SYSTEM_PROMPT = [
  "You are Ortha, a self-extending assistant with general web access.",
  "You have two kinds of tools. (1) Always-available, free web tools: web_search (search the",
  "open web) and web_scrape (read a page as markdown). Reach for them WHEN YOU ACTUALLY NEED",
  "them: current or recent events, real-time or fast-changing facts, specific people/companies/",
  "contacts, niche or obscure details, or anything you're not confident you know — typically",
  "web_search first, then web_scrape the most promising results. For timeless or general",
  "knowledge you already know well (definitions, concepts, how-tos, math, code), just answer",
  "directly without searching.",
  "(2) Orthogonal's paid API catalog, discovered at runtime: search_tools to find an endpoint,",
  "get_tool_details to inspect it, run_tool to execute it (use this for specialized/structured",
  "data the open web can't give cleanly). Use expand_result only when a distilled summary is",
  "insufficient. Prefer the cheapest path that answers the user, and prefer the free web tools",
  "before paid endpoints when either would work. When you use the web, cite the page URLs you",
  "relied on at the end of your answer.",
  "Act, don't narrate: if you decide to use a tool, emit that tool call in the same",
  "response — never reply with only a description of what you are about to do next. If a",
  "tool's result doesn't fully answer the question, immediately search for and call another",
  "tool instead of stopping. Keep going until you can answer; end a turn only with either a",
  "tool call or a complete plain-language answer.",
  "Always explain your answer in plain language once you have the data.",
].join(" ");

// ── Typed argument coercion (LLM args arrive as untyped Record) ──────────────

export function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

export function asRecord(v: unknown): Record<string, unknown> | undefined {
  return v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}

export function asStringRecord(v: unknown): Record<string, string> | undefined {
  const rec = asRecord(v);
  if (!rec) return undefined;
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(rec)) {
    if (typeof val === "string") out[k] = val;
    else out[k] = String(val);
  }
  return out;
}
