import { describe, expect, it } from "vitest";
import {
  COMMANDS,
  matchCommands,
  parseSlash,
  resolveProvider,
  runCommand,
  type CommandContext,
} from "../src/lib/commands.ts";

function makeCtx(): CommandContext & {
  calls: { sent: string[]; drafts: string[]; providers: string[]; newChat: number; settings: number; clear: number; batch: number };
} {
  const calls = { sent: [] as string[], drafts: [] as string[], providers: [] as string[], newChat: 0, settings: 0, clear: 0, batch: 0 };
  return {
    calls,
    send: (t) => calls.sent.push(t),
    setDraft: (t) => calls.drafts.push(t),
    newChat: () => {
      calls.newChat++;
    },
    changeProvider: (p) => calls.providers.push(p),
    openSettings: () => {
      calls.settings++;
    },
    clearChat: () => {
      calls.clear++;
    },
    openBatch: () => {
      calls.batch++;
    },
  };
}

describe("command registry", () => {
  it("exposes the expected commands", () => {
    const ids = COMMANDS.map((c) => c.id).sort();
    expect(ids).toEqual(["batch", "clear", "company", "cost", "email", "enrich", "model", "new", "research", "scrape"].sort());
  });

  it("every prompt command has an expander; every action has a runner", () => {
    for (const c of COMMANDS) {
      if (c.kind === "prompt") expect(typeof c.expand).toBe("function");
      if (c.kind === "action") expect(typeof c.run).toBe("function");
    }
  });
});

describe("matchCommands", () => {
  it("returns all commands for an empty or bare-slash query", () => {
    expect(matchCommands("")).toHaveLength(COMMANDS.length);
    expect(matchCommands("/")).toHaveLength(COMMANDS.length);
  });

  it("prefix-matches the command word", () => {
    const r = matchCommands("/enr");
    expect(r[0]?.id).toBe("enrich");
  });

  it("ignores the trailing argument when filtering", () => {
    const r = matchCommands("/email Jane at Acme");
    expect(r[0]?.id).toBe("email");
  });

  it("ranks an exact id above a mere prefix", () => {
    // "new" is an exact id; nothing else should outrank it.
    expect(matchCommands("/new")[0]?.id).toBe("new");
  });

  it("fuzzy-matches a subsequence of the id", () => {
    const r = matchCommands("/cmp");
    expect(r.some((c) => c.id === "company")).toBe(true);
  });

  it("matches description text when the id misses", () => {
    const r = matchCommands("provider");
    expect(r.some((c) => c.id === "model")).toBe(true);
  });

  it("returns nothing for a non-matching query", () => {
    expect(matchCommands("/zzzzz")).toHaveLength(0);
  });
});

describe("parseSlash", () => {
  it("splits a command word from its argument", () => {
    expect(parseSlash("/email Jane at Acme")).toEqual({ word: "email", arg: "Jane at Acme" });
  });
  it("handles a bare command with no arg", () => {
    expect(parseSlash("/new")).toEqual({ word: "new", arg: "" });
  });
});

describe("resolveProvider", () => {
  it("resolves by id, label, and loose contains", () => {
    expect(resolveProvider("anthropic")).toBe("anthropic");
    expect(resolveProvider("Claude")).toBe("anthropic");
    expect(resolveProvider("gpt")).toBe("openai");
  });
  it("returns null for empty or unknown input", () => {
    expect(resolveProvider("")).toBeNull();
    expect(resolveProvider("nope")).toBeNull();
  });
});

describe("runCommand — prompt fast-paths", () => {
  const get = (id: string) => COMMANDS.find((c) => c.id === id)!;

  it("expands and sends when an arg is present", () => {
    const ctx = makeCtx();
    const out = runCommand(get("enrich"), "a@b.com", ctx);
    expect(out).toBe("sent");
    expect(ctx.calls.sent).toHaveLength(1);
    expect(ctx.calls.sent[0]).toContain("a@b.com");
    // Tool-agnostic: must not name a specific API.
    expect(ctx.calls.sent[0]!.toLowerCase()).not.toContain("apollo");
  });

  it("primes the draft when the arg is missing", () => {
    const ctx = makeCtx();
    const out = runCommand(get("research"), "", ctx);
    expect(out).toBe("filled");
    expect(ctx.calls.drafts).toEqual(["/research "]);
    expect(ctx.calls.sent).toHaveLength(0);
  });
});

describe("runCommand — actions", () => {
  const get = (id: string) => COMMANDS.find((c) => c.id === id)!;

  it("/new starts a new chat", () => {
    const ctx = makeCtx();
    expect(runCommand(get("new"), "", ctx)).toBe("action");
    expect(ctx.calls.newChat).toBe(1);
  });

  it("/clear clears the chat", () => {
    const ctx = makeCtx();
    runCommand(get("clear"), "", ctx);
    expect(ctx.calls.clear).toBe(1);
  });

  it("/cost opens settings", () => {
    const ctx = makeCtx();
    runCommand(get("cost"), "", ctx);
    expect(ctx.calls.settings).toBe(1);
  });

  it("/batch opens the batch runner", () => {
    const ctx = makeCtx();
    expect(runCommand(get("batch"), "", ctx)).toBe("action");
    expect(ctx.calls.batch).toBe(1);
  });

  it("/model <provider> switches provider", () => {
    const ctx = makeCtx();
    runCommand(get("model"), "claude", ctx);
    expect(ctx.calls.providers).toEqual(["anthropic"]);
  });

  it("/model with an unknown provider falls back to opening settings", () => {
    const ctx = makeCtx();
    runCommand(get("model"), "frobnicator", ctx);
    expect(ctx.calls.providers).toHaveLength(0);
    expect(ctx.calls.settings).toBe(1);
  });
});

describe("expansions stay tool-agnostic", () => {
  it("never names a concrete Orthogonal API", () => {
    const banned = ["apollo", "hunter", "clearbit", "firecrawl", "exa", "serp"];
    for (const c of COMMANDS) {
      if (c.kind !== "prompt" || !c.expand) continue;
      const text = (c.expand("test input") ?? "").toLowerCase();
      for (const b of banned) expect(text).not.toContain(b);
    }
  });
});
