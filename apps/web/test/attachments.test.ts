import { describe, expect, it } from "vitest";
import { buildPromptWithAttachments, formatAttachment, isTextFile } from "../src/lib/attachments.ts";

describe("isTextFile", () => {
  it("accepts any text/* mime regardless of extension", () => {
    expect(isTextFile("notes", "text/plain")).toBe(true);
    expect(isTextFile("weird.bin", "text/markdown")).toBe(true);
  });

  it("accepts known text-ish application mimes", () => {
    expect(isTextFile("data", "application/json")).toBe(true);
    expect(isTextFile("feed", "application/xml")).toBe(true);
    expect(isTextFile("logo", "image/svg+xml")).toBe(true);
  });

  it("accepts known text extensions even with an empty mime", () => {
    for (const name of ["notes.txt", "README.md", "doc.markdown", "rows.csv", "config.json", "app.ts", "main.py", "server.log"]) {
      expect(isTextFile(name, "")).toBe(true);
    }
  });

  it("is case-insensitive about the extension", () => {
    expect(isTextFile("README.MD", "")).toBe(true);
    expect(isTextFile("DATA.JSON", "")).toBe(true);
  });

  it("rejects binary formats (PDF, docx, images)", () => {
    expect(isTextFile("paper.pdf", "application/pdf")).toBe(false);
    expect(isTextFile("resume.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document")).toBe(false);
    expect(isTextFile("photo.png", "image/png")).toBe(false);
    expect(isTextFile("photo.jpg", "image/jpeg")).toBe(false);
  });

  it("rejects unknown extensions with no helpful mime", () => {
    expect(isTextFile("archive.zip", "")).toBe(false);
    expect(isTextFile("noextension", "")).toBe(false);
    expect(isTextFile(".hiddenonly", "")).toBe(false);
  });
});

describe("formatAttachment", () => {
  it("wraps the content in a labelled fenced block", () => {
    const out = formatAttachment("notes.txt", "hello world");
    expect(out).toBe("Attached file: notes.txt\n```\nhello world\n```\n");
  });

  it("does not add a truncation note when under the cap", () => {
    const out = formatAttachment("a.txt", "short", 100);
    expect(out).not.toContain("(truncated)");
    expect(out).toContain("short");
  });

  it("caps the body and appends a truncation note when over the cap", () => {
    const big = "x".repeat(50);
    const out = formatAttachment("big.txt", big, 10);
    expect(out).toContain("(truncated)");
    // Only the first 10 chars of the body survive.
    expect(out).toContain("x".repeat(10));
    expect(out).not.toContain("x".repeat(11));
  });

  it("respects the default cap of 20000 chars", () => {
    const big = "y".repeat(20001);
    const out = formatAttachment("big.txt", big);
    expect(out).toContain("(truncated)");
    expect(out).not.toContain("y".repeat(20001));
  });
});

describe("buildPromptWithAttachments", () => {
  it("returns the user text unchanged when there are no attachments", () => {
    expect(buildPromptWithAttachments("what is this?", [])).toBe("what is this?");
  });

  it("composes a single file before the user question", () => {
    const out = buildPromptWithAttachments("summarize", [{ name: "a.txt", content: "alpha" }]);
    expect(out).toContain("Attached file: a.txt");
    expect(out).toContain("alpha");
    expect(out).toContain("summarize");
    // The user question comes after the file block.
    expect(out.indexOf("alpha")).toBeLessThan(out.indexOf("summarize"));
  });

  it("composes multiple files and keeps the user question last", () => {
    const out = buildPromptWithAttachments("compare these", [
      { name: "first.txt", content: "AAA" },
      { name: "second.txt", content: "BBB" },
    ]);
    expect(out).toContain("Attached file: first.txt");
    expect(out).toContain("Attached file: second.txt");
    expect(out).toContain("AAA");
    expect(out).toContain("BBB");
    expect(out.indexOf("AAA")).toBeLessThan(out.indexOf("BBB"));
    expect(out.indexOf("BBB")).toBeLessThan(out.indexOf("compare these"));
  });
});
