import { asConversationId, asRequestId } from "@ortha/contracts";
import { distill } from "@ortha/harness";
import { describe, expect, it } from "vitest";
import {
  createCappedKvStore,
  createMemoryStore,
  DEFAULT_RAW_CAP_BYTES,
  isTruncatedBlob,
  mapKvPort,
  type ConvSummaryState,
  type RawBlobBackend,
  type TruncatedBlob,
} from "../src/store.js";

/**
 * In-memory stand-in for the DO SQLite-backed RawBlobBackend (apps/edge/src/raw-store.ts).
 * Records the byte size handed to putJson so tests can assert what was actually stored.
 */
function fakeBackend() {
  const rows = new Map<string, { json: string; bytes: number }>();
  const backend: RawBlobBackend = {
    getJson: (key) => rows.get(key)?.json ?? null,
    putJson: (key, json, bytes) => {
      rows.set(key, { json, bytes });
    },
  };
  return { backend, rows };
}

describe("createCappedKvStore", () => {
  it("round-trips a small value via get", async () => {
    const { store } = { store: createCappedKvStore(fakeBackend().backend) };
    const value = { name: "Patrick", nested: { count: 42 }, list: [1, 2, 3] };
    await store.put("k1", value);
    expect(await store.get("k1")).toEqual(value);
  });

  it("returns null for an unknown key", async () => {
    const store = createCappedKvStore(fakeBackend().backend);
    expect(await store.get("missing")).toBeNull();
  });

  it("stores a truncated marker for an oversized value without blowing up", async () => {
    const cap = 1024; // 1 KB cap for a fast test
    const { backend, rows } = fakeBackend();
    const store = createCappedKvStore(backend, cap);

    const big = "x".repeat(50 * 1024); // ~50 KB string → ~50 KB+ of JSON
    const value = { blob: big };
    await store.put("huge", value);

    const got = (await store.get("huge")) as TruncatedBlob;
    expect(isTruncatedBlob(got)).toBe(true);
    expect(got._truncated).toBe(true);
    // The reported size is the byte length of the ORIGINAL serialized value.
    expect(got.bytes).toBeGreaterThan(50 * 1024);
    // A leading preview is retained, but it is small (~2 KB), not the whole blob.
    expect(got.preview.length).toBeLessThanOrEqual(2 * 1024);
    expect(got.preview.startsWith('{"blob":"xxx')).toBe(true);

    // What was actually persisted is the small marker (~preview + overhead),
    // not the ~50 KB blob — bounded well under 4 KB regardless of input size.
    expect(rows.get("huge")!.bytes).toBeLessThan(4 * 1024);
    expect(rows.get("huge")!.bytes).toBeLessThan(got.bytes);
  });

  it("keeps a value that sits just under the cap intact", async () => {
    const cap = 1024;
    const store = createCappedKvStore(fakeBackend().backend, cap);
    // JSON of {"v":"<700 x>"} is ~708 bytes < 1024.
    const value = { v: "x".repeat(700) };
    await store.put("ok", value);
    const got = await store.get("ok");
    expect(isTruncatedBlob(got)).toBe(false);
    expect(got).toEqual(value);
  });

  it("handles null / undefined values", async () => {
    const store = createCappedKvStore(fakeBackend().backend);
    await store.put("n", null);
    expect(await store.get("n")).toBeNull();
    await store.put("u", undefined);
    expect(await store.get("u")).toBeNull();
  });

  it("counts UTF-8 bytes (not code units) against the cap", async () => {
    // 200 multi-byte chars (3 bytes each in UTF-8) → ~600 bytes, over a 256-byte cap,
    // even though .length is only ~200.
    const cap = 256;
    const store = createCappedKvStore(fakeBackend().backend, cap);
    const value = { s: "あ".repeat(200) };
    await store.put("uni", value);
    const got = (await store.get("uni")) as TruncatedBlob;
    expect(isTruncatedBlob(got)).toBe(true);
    expect(got.bytes).toBeGreaterThan(cap);
  });

  it("exposes a 256 KB default cap", () => {
    expect(DEFAULT_RAW_CAP_BYTES).toBe(256 * 1024);
  });
});

describe("createCappedKvStore wired as a MemoryStore rawStore", () => {
  const CONV = asConversationId("conv_capped");
  const summarize = async (text: string): Promise<string> => distill({ text }).summary;

  it("persists raw results across getRaw (cross-turn expand_result)", async () => {
    const rawStore = createCappedKvStore(fakeBackend().backend);
    const store = createMemoryStore({
      rawStore,
      summaryStore: mapKvPort<ConvSummaryState>(),
      summarize,
    });
    const rid = asRequestId("run_capped");
    const raw = { result: "the full tool output", rows: [{ id: 1 }, { id: 2 }] };
    await store.appendDistilled(CONV, rid, "summary", raw);
    expect(await store.getRaw(rid)).toEqual(raw);
  });

  it("returns a truncated marker through getRaw for an oversized result", async () => {
    const rawStore = createCappedKvStore(fakeBackend().backend, 1024);
    const store = createMemoryStore({
      rawStore,
      summaryStore: mapKvPort<ConvSummaryState>(),
      summarize,
    });
    const rid = asRequestId("run_big");
    await store.appendDistilled(CONV, rid, "summary", { blob: "y".repeat(40 * 1024) });
    const got = await store.getRaw(rid);
    expect(isTruncatedBlob(got)).toBe(true);
  });
});
