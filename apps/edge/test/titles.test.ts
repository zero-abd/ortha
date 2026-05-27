import { describe, expect, it } from "vitest";
import { makeMockLLMProvider } from "@ortha/contracts/mocks";
import { generateTitle, sanitizeTitle } from "../src/titles.js";

describe("sanitizeTitle", () => {
  it("passes a clean title through unchanged", () => {
    expect(sanitizeTitle("Refactor Auth Flow")).toBe("Refactor Auth Flow");
  });
  it("strips surrounding quotes (straight and smart)", () => {
    expect(sanitizeTitle('"Plan The Roadmap"')).toBe("Plan The Roadmap");
    expect(sanitizeTitle("“Plan The Roadmap”")).toBe("Plan The Roadmap");
  });
  it("collapses newlines and extra whitespace", () => {
    expect(sanitizeTitle("Plan\n  The   Roadmap\n")).toBe("Plan The Roadmap");
  });
  it("drops trailing sentence punctuation", () => {
    expect(sanitizeTitle("Plan The Roadmap.")).toBe("Plan The Roadmap");
  });
  it("caps the length at 60 chars", () => {
    const long = "Word ".repeat(40).trim();
    expect(sanitizeTitle(long).length).toBeLessThanOrEqual(60);
  });
  it("returns empty string for whitespace-only input", () => {
    expect(sanitizeTitle("   \n  ")).toBe("");
  });
});

describe("generateTitle", () => {
  it("collects streamed tokens into a sanitized title", async () => {
    const llm = makeMockLLMProvider([
      { type: "token", text: '"Refactor ' },
      { type: "token", text: "Auth Flow\"" },
      { type: "done", stopReason: "end" },
    ]);
    const title = await generateTitle(llm, "gemini-flash-latest", "please help me refactor my authentication flow");
    expect(title).toBe("Refactor Auth Flow");
  });

  it("falls back to the truncated prompt when the model returns nothing", async () => {
    const llm = makeMockLLMProvider([{ type: "done", stopReason: "end" }]);
    const prompt = "a".repeat(100);
    const title = await generateTitle(llm, "gemini-flash-latest", prompt);
    expect(title).toBe("a".repeat(60));
  });

  it("falls back to the truncated prompt when the stream throws", async () => {
    const llm = {
      id: "anthropic" as const,
      // eslint-disable-next-line require-yield
      async *streamCompletion() {
        throw new Error("provider down");
      },
    };
    const prompt = "Summarize my quarterly sales numbers for the board meeting tomorrow morning";
    const title = await generateTitle(llm, "gemini-flash-latest", prompt);
    expect(title).toBe(prompt.slice(0, 60));
  });
});
