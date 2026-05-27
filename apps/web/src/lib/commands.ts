// Command registry for the slash-menu and the ⌘K command palette.
//
// Two kinds of commands:
//  - "prompt" fast-paths expand the typed args into a clear, tool-agnostic
//    instruction so the self-extending agent skips guessing and goes straight
//    to discovering the right kind of Orthogonal tool. They never name a
//    specific API — the agent discovers it at runtime.
//  - "action" commands run a local handler against the chat UI (new chat,
//    switch model, open the cost meter, clear the current chat).
//
// Both are matched by `matchCommands(query)`, which the slash menu (filtering on
// the leading-slash draft) and the palette (fuzzy free-text) share.

import { PROVIDERS } from "./providers.ts";

/** Side-effecting handlers the host app wires in. Kept tiny on purpose. */
export interface CommandContext {
  /** Send a message through the normal turn pipeline. */
  send: (text: string) => void;
  /** Replace the composer draft (used when a prompt command needs an arg). */
  setDraft: (text: string) => void;
  /** Start a fresh conversation. */
  newChat: () => void;
  /** Switch the active model by provider id. */
  changeProvider: (providerId: string) => void;
  /** Open the settings modal (Usage/cost lives there). */
  openSettings: () => void;
  /** Clear the current chat without creating a new conversation id. */
  clearChat: () => void;
  /** Open the batch runner (run a skill across many rows). */
  openBatch: () => void;
  /** Run a saved skill: send it directly if it has no fields, else open its run form. */
  runSkill: (skill: { name: string; template: string }) => void;
}

export type CommandKind = "prompt" | "action";

export interface Command {
  /** Slash trigger without the leading slash, e.g. "enrich". */
  id: string;
  /** Human label shown in menus, e.g. "/enrich". */
  title: string;
  /** One-line description of what it does. */
  description: string;
  kind: CommandKind;
  /** Hint shown after the title when the command expects an argument. */
  argHint?: string;
  /**
   * Prompt commands: expand the raw arg string into an agent instruction.
   * Returns null when the arg is required but empty (caller should prompt for
   * input rather than send an incomplete instruction).
   */
  expand?: (arg: string) => string | null;
  /**
   * Action commands: run the local handler. `arg` is the trimmed text after
   * the command word (e.g. the provider id for `/model`).
   */
  run?: (ctx: CommandContext, arg: string) => void;
}

/** Resolve a free-text provider arg to a known provider id (label or id). */
export function resolveProvider(arg: string): string | null {
  const q = arg.trim().toLowerCase();
  if (!q) return null;
  const byId = PROVIDERS.find((p) => p.id.toLowerCase() === q);
  if (byId) return byId.id;
  const byLabel = PROVIDERS.find((p) => p.label.toLowerCase() === q);
  if (byLabel) return byLabel.id;
  // Loose contains match against id, label, and the default model id so
  // "/model claude" and "/model gpt" both land on the right provider.
  const loose = PROVIDERS.find(
    (p) => p.id.toLowerCase().includes(q) || p.label.toLowerCase().includes(q) || p.defaultModel.toLowerCase().includes(q),
  );
  return loose?.id ?? null;
}

export const COMMANDS: Command[] = [
  // ── Prompt fast-paths ───────────────────────────────────────────────────
  {
    id: "enrich",
    title: "/enrich",
    description: "Enrich a person or company from an email, domain, or name",
    kind: "prompt",
    argHint: "<email | domain | name>",
    expand: (arg) =>
      arg.trim()
        ? `Enrich the person and company behind ${arg.trim()} — find their name, title, company, and any public profiles using an enrichment tool.`
        : null,
  },
  {
    id: "email",
    title: "/email",
    description: "Find a work email for someone at a company",
    kind: "prompt",
    argHint: "<name> at <company>",
    expand: (arg) =>
      arg.trim()
        ? `Find the work email address for ${arg.trim()} using an email-finding tool, and verify it if possible.`
        : null,
  },
  {
    id: "research",
    title: "/research",
    description: "Research a topic and summarize what you find",
    kind: "prompt",
    argHint: "<topic>",
    expand: (arg) =>
      arg.trim()
        ? `Research ${arg.trim()} using web search and research tools, then summarize the key findings with sources.`
        : null,
  },
  {
    id: "scrape",
    title: "/scrape",
    description: "Extract the contents of a web page",
    kind: "prompt",
    argHint: "<url>",
    expand: (arg) =>
      arg.trim()
        ? `Scrape the page at ${arg.trim()} using a web-scraping tool and return the key structured contents.`
        : null,
  },
  {
    id: "company",
    title: "/company",
    description: "Look up details and recent news about a company",
    kind: "prompt",
    argHint: "<name>",
    expand: (arg) =>
      arg.trim()
        ? `Look up the company ${arg.trim()} — find its website, industry, size, key people, and any recent news using a company-data tool.`
        : null,
  },

  // ── Actions ─────────────────────────────────────────────────────────────
  {
    id: "new",
    title: "/new",
    description: "Start a new chat",
    kind: "action",
    run: (ctx) => ctx.newChat(),
  },
  {
    id: "model",
    title: "/model",
    description: "Switch the model provider",
    kind: "action",
    argHint: PROVIDERS.map((p) => p.label).join(" · "),
    run: (ctx, arg) => {
      const id = resolveProvider(arg);
      if (id) ctx.changeProvider(id);
      else ctx.openSettings();
    },
  },
  {
    id: "cost",
    title: "/cost",
    description: "Open usage and spending",
    kind: "action",
    run: (ctx) => ctx.openSettings(),
  },
  {
    id: "clear",
    title: "/clear",
    description: "Clear the current chat",
    kind: "action",
    run: (ctx) => ctx.clearChat(),
  },
  {
    id: "batch",
    title: "/batch",
    description: "Run a skill across many rows",
    kind: "action",
    run: (ctx) => ctx.openBatch(),
  },
];

// ── Dynamic skill commands ──────────────────────────────────────────────────
// Saved skills (the user's own + any public skill they added) are exposed as
// slash commands so `/their-skill` runs it. The host (App) rebuilds this list
// whenever the skill set changes via `setSkillCommands`. Kept in a module-level
// registry so both the slash menu and the ⌘K palette (which share
// `matchCommands`) pick them up without threading props through every layer.
let SKILL_COMMANDS: Command[] = [];

/** Slugify a skill name into a slash trigger, e.g. "Find Leads" → "find-leads". */
export function skillSlug(name: string): string {
  return (
    name.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "skill"
  );
}

/** Build the slash command for one saved skill (runs it via `ctx.runSkill`). */
export function skillCommand(skill: { name: string; template: string }): Command {
  return {
    id: skillSlug(skill.name),
    title: `/${skillSlug(skill.name)}`,
    description: skill.name,
    kind: "action",
    run: (ctx) => ctx.runSkill(skill),
  };
}

/** Replace the dynamic skill-command set (called by the host when skills change). */
export function setSkillCommands(skills: readonly { name: string; template: string }[]): void {
  const seen = new Set(COMMANDS.map((c) => c.id));
  SKILL_COMMANDS = [];
  for (const s of skills) {
    const cmd = skillCommand(s);
    if (seen.has(cmd.id)) continue; // built-in command wins on a name clash
    seen.add(cmd.id);
    SKILL_COMMANDS.push(cmd);
  }
}

/** Built-in commands plus the current dynamic skill commands. */
function allCommands(): Command[] {
  return SKILL_COMMANDS.length > 0 ? [...COMMANDS, ...SKILL_COMMANDS] : COMMANDS;
}

/** Subsequence fuzzy match: are all chars of `needle` found in order in `hay`? */
function fuzzyHit(hay: string, needle: string): boolean {
  if (!needle) return true;
  let i = 0;
  for (const ch of hay) {
    if (ch === needle[i]) i++;
    if (i === needle.length) return true;
  }
  return i === needle.length;
}

/**
 * Filter commands for a query. Accepts either a leading-slash slash-menu query
 * ("/enr") or bare palette text ("enrich"). Matches the command word as a
 * prefix first, then falls back to a fuzzy subsequence over title+description,
 * so `/cmp` finds `/company` and "switch model" finds `/model`. An empty query
 * returns all commands in registry order.
 */
export function matchCommands(query: string): Command[] {
  // Slash queries are "/word arg"; we filter on the word only so args don't
  // narrow the list once a command is chosen.
  const raw = query.startsWith("/") ? query.slice(1) : query;
  const word = raw.split(/\s+/)[0]?.toLowerCase() ?? "";
  const pool = allCommands();
  if (!word) return pool;

  const scored = pool.map((c) => {
    const id = c.id.toLowerCase();
    let score = -1;
    if (id === word) score = 3;
    else if (id.startsWith(word)) score = 2;
    else if (fuzzyHit(id, word)) score = 1;
    else if (fuzzyHit(`${c.title} ${c.description}`.toLowerCase(), word)) score = 0;
    return { c, score };
  }).filter((s) => s.score >= 0);

  // Stable sort: higher score first, registry order within a score.
  scored.sort((a, b) => b.score - a.score);
  return scored.map((s) => s.c);
}

/**
 * Split a slash draft into its command word and the trailing argument text.
 * "/email Jane at Acme" → { word: "email", arg: "Jane at Acme" }.
 */
export function parseSlash(draft: string): { word: string; arg: string } {
  const raw = draft.startsWith("/") ? draft.slice(1) : draft;
  const m = raw.match(/^(\S*)\s*(.*)$/s);
  return { word: (m?.[1] ?? "").toLowerCase(), arg: m?.[2] ?? "" };
}

/**
 * Run a command against the host context. Prompt commands either send the
 * expanded instruction (when an arg is present) or, when the arg is missing,
 * fill the composer with the command word + a trailing space so the user can
 * type the argument. Returns the action taken so callers can update focus.
 */
export function runCommand(cmd: Command, arg: string, ctx: CommandContext): "sent" | "filled" | "action" {
  if (cmd.kind === "action") {
    cmd.run?.(ctx, arg);
    return "action";
  }
  const expanded = cmd.expand?.(arg) ?? null;
  if (expanded) {
    ctx.send(expanded);
    return "sent";
  }
  // Prompt command without an argument: prime the composer for the user.
  ctx.setDraft(`/${cmd.id} `);
  return "filled";
}
