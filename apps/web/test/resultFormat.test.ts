import { describe, expect, it } from "vitest";
import { toCSV, toMarkdown, toModel, type ResultModel } from "../src/lib/resultFormat.ts";

describe("toModel", () => {
  it("renders a single plain object as a record", () => {
    const m = toModel({ name: "Stripe", ceo: "Patrick Collison", employees: 8000 });
    expect(m).toEqual({
      kind: "record",
      rows: [
        { k: "name", v: "Stripe" },
        { k: "ceo", v: "Patrick Collison" },
        { k: "employees", v: "8000" },
      ],
    });
  });

  it("renders an array of flat objects as a table with the column union", () => {
    const m = toModel([
      { name: "Ada", role: "eng" },
      { name: "Linus", city: "Portland" },
    ]);
    expect(m.kind).toBe("table");
    if (m.kind !== "table") throw new Error("expected table");
    // Columns preserve first-seen order across the union.
    expect(m.columns).toEqual(["name", "role", "city"]);
    expect(m.rows).toEqual([
      ["Ada", "eng", ""],
      ["Linus", "", "Portland"],
    ]);
  });

  it("unwraps a { results: [...] } envelope into a table", () => {
    const m = toModel({ results: [{ id: 1 }, { id: 2 }] });
    expect(m.kind).toBe("table");
    if (m.kind !== "table") throw new Error("expected table");
    expect(m.columns).toEqual(["id"]);
    expect(m.rows).toEqual([["1"], ["2"]]);
  });

  it("unwraps a { data: {...} } envelope into a record", () => {
    const m = toModel({ data: { email: "a@b.com" } });
    expect(m).toEqual({ kind: "record", rows: [{ k: "email", v: "a@b.com" }] });
  });

  it("unwraps an { items: [...] } envelope", () => {
    const m = toModel({ items: [{ x: 1 }] });
    expect(m.kind).toBe("table");
  });

  it("JSON-stringifies nested values in a record cell", () => {
    const m = toModel({ name: "Acme", tags: ["a", "b"], meta: { k: 1 } });
    expect(m).toEqual({
      kind: "record",
      rows: [
        { k: "name", v: "Acme" },
        { k: "tags", v: '["a","b"]' },
        { k: "meta", v: '{"k":1}' },
      ],
    });
  });

  it("JSON-stringifies nested values in a table cell", () => {
    const m = toModel([{ name: "Acme", labels: ["x", "y"] }]);
    if (m.kind !== "table") throw new Error("expected table");
    expect(m.rows).toEqual([["Acme", '["x","y"]']]);
  });

  it("renders null and undefined cells as empty strings", () => {
    const m = toModel({ a: null, b: undefined, c: 0, d: false });
    expect(m).toEqual({
      kind: "record",
      rows: [
        { k: "a", v: "" },
        { k: "b", v: "" },
        { k: "c", v: "0" },
        { k: "d", v: "false" },
      ],
    });
  });

  it("falls back to text for a primitive", () => {
    expect(toModel("hello")).toEqual({ kind: "text", text: "hello" });
    expect(toModel(42)).toEqual({ kind: "text", text: "42" });
    expect(toModel(true)).toEqual({ kind: "text", text: "true" });
  });

  it("falls back to text for an empty array", () => {
    expect(toModel([])).toEqual({ kind: "text", text: "[]" });
  });

  it("falls back to text for an empty object", () => {
    expect(toModel({})).toEqual({ kind: "text", text: "{}" });
  });

  it("falls back to text (pretty JSON) for an array of primitives", () => {
    const m = toModel([1, 2, 3]);
    expect(m.kind).toBe("text");
    if (m.kind !== "text") throw new Error("expected text");
    expect(m.text).toBe(JSON.stringify([1, 2, 3], null, 2));
  });

  it("falls back to text for a mixed array (object + primitive)", () => {
    const m = toModel([{ a: 1 }, "loose"]);
    expect(m.kind).toBe("text");
  });

  it("renders null/undefined as empty text", () => {
    expect(toModel(null)).toEqual({ kind: "text", text: "" });
    expect(toModel(undefined)).toEqual({ kind: "text", text: "" });
  });

  it("does not unwrap an envelope whose payload is a primitive", () => {
    // { data: "x" } has no array/object payload, so render the envelope itself.
    const m = toModel({ data: "x" });
    expect(m).toEqual({ kind: "record", rows: [{ k: "data", v: "x" }] });
  });
});

describe("toCSV", () => {
  it("serializes a table to CSV", () => {
    const m: ResultModel = { kind: "table", columns: ["a", "b"], rows: [["1", "2"], ["3", "4"]] };
    expect(toCSV(m)).toBe("a,b\n1,2\n3,4");
  });

  it("serializes a record to key,value CSV", () => {
    const m: ResultModel = { kind: "record", rows: [{ k: "name", v: "Acme" }] };
    expect(toCSV(m)).toBe("key,value\nname,Acme");
  });

  it("quotes and escapes fields containing comma, quote, or newline", () => {
    const m: ResultModel = {
      kind: "table",
      columns: ["note"],
      rows: [["a,b"], ['say "hi"'], ["line1\nline2"]],
    };
    expect(toCSV(m)).toBe('note\n"a,b"\n"say ""hi"""\n"line1\nline2"');
  });

  it("emits just the header when a table has no rows", () => {
    const m: ResultModel = { kind: "table", columns: ["a", "b"], rows: [] };
    expect(toCSV(m)).toBe("a,b");
  });

  it("serializes text as a single field", () => {
    expect(toCSV({ kind: "text", text: "hello, world" })).toBe('"hello, world"');
  });
});

describe("toMarkdown", () => {
  it("serializes a table to a Markdown grid", () => {
    const m: ResultModel = { kind: "table", columns: ["a", "b"], rows: [["1", "2"]] };
    expect(toMarkdown(m)).toBe("| a | b |\n| --- | --- |\n| 1 | 2 |");
  });

  it("serializes a record to a two-column Markdown table", () => {
    const m: ResultModel = { kind: "record", rows: [{ k: "name", v: "Acme" }] };
    expect(toMarkdown(m)).toBe("| Field | Value |\n| --- | --- |\n| name | Acme |");
  });

  it("escapes pipes and flattens newlines in cells", () => {
    const m: ResultModel = { kind: "table", columns: ["x"], rows: [["a|b\nc"]] };
    expect(toMarkdown(m)).toBe("| x |\n| --- |\n| a\\|b c |");
  });

  it("wraps text in a fenced code block", () => {
    expect(toMarkdown({ kind: "text", text: "{}" })).toBe("```\n{}\n```");
  });

  it("emits header-only Markdown for an empty table", () => {
    const m: ResultModel = { kind: "table", columns: ["a"], rows: [] };
    expect(toMarkdown(m)).toBe("| a |\n| --- |");
  });
});
