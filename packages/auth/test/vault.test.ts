import { asWorkspaceId, ErrorCode } from "@ortha/contracts";
import { describe, expect, it } from "vitest";
import { createKeyVault } from "../src/vault.js";
import { createMemoryStore, type KVStore } from "../src/store.js";

// A deterministic 32-byte (AES-256) master key, base64-encoded.
const MASTER_KEY_B64 = btoa(String.fromCharCode(...Array.from({ length: 32 }, (_, i) => (i * 7 + 3) % 256)));
const WS = asWorkspaceId("ws_test");
const SECRET = "sk_live_supersecret_1234";

const setup = async (): Promise<{ vault: Awaited<ReturnType<typeof createKeyVault>>; store: KVStore }> => {
  const store = createMemoryStore();
  const vault = await createKeyVault({ masterKeyBase64: MASTER_KEY_B64, store });
  return { vault, store };
};

describe("createKeyVault construction", () => {
  it("rejects a master key that is not 32 bytes", async () => {
    await expect(createKeyVault({ masterKeyBase64: btoa("short"), store: createMemoryStore() })).rejects.toThrow(
      /32 bytes/,
    );
  });
});

describe("encrypt -> getKey round-trip", () => {
  it("returns the original plaintext", async () => {
    const { vault } = await setup();
    await vault.putKey(WS, "anthropic", SECRET);
    expect(await vault.getKey(WS, "anthropic")).toBe(SECRET);
  });

  it("stores ciphertext, not plaintext", async () => {
    const { vault, store } = await setup();
    await vault.putKey(WS, "openai", SECRET);
    const raw = await store.get(`key:${WS}:openai`);
    expect(raw).not.toBeNull();
    expect(raw).not.toContain(SECRET);
    const record = JSON.parse(raw as string);
    expect(record.ciphertext).not.toContain(SECRET);
    expect(typeof record.iv).toBe("string");
  });

  it("uses a fresh random IV per encryption (same plaintext -> different ciphertext)", async () => {
    const { vault, store } = await setup();
    await vault.putKey(WS, "openai", SECRET);
    const first = JSON.parse((await store.get(`key:${WS}:openai`)) as string);
    await vault.rotate(WS, "openai", SECRET); // same plaintext, re-encrypted
    const second = JSON.parse((await store.get(`key:${WS}:openai`)) as string);
    expect(second.iv).not.toBe(first.iv);
    expect(second.ciphertext).not.toBe(first.ciphertext);
  });

  it("getKey returns null for an unset key", async () => {
    const { vault } = await setup();
    expect(await vault.getKey(WS, "gemini")).toBeNull();
  });
});

describe("listKeys metadata", () => {
  it("never leaks plaintext in its serialized output", async () => {
    const { vault } = await setup();
    await vault.putKey(WS, "anthropic", SECRET);
    await vault.putKey(WS, "orthogonal", "orth_live_topsecret_9999");
    const meta = await vault.listKeys(WS);
    const serialized = JSON.stringify(meta);
    expect(serialized).not.toContain(SECRET);
    expect(serialized).not.toContain("orth_live_topsecret_9999");
    expect(serialized).not.toContain("ciphertext");
  });

  it("exposes a last-4 hint and the status/version", async () => {
    const { vault } = await setup();
    await vault.putKey(WS, "anthropic", SECRET);
    const meta = await vault.listKeys(WS);
    const entry = meta.find((m) => m.provider === "anthropic");
    expect(entry?.hint).toBe(SECRET.slice(-4));
    expect(entry?.status).toBe("active");
    expect(entry?.version).toBe(1);
  });

  it("scopes results to the workspace", async () => {
    const { vault } = await setup();
    await vault.putKey(WS, "anthropic", SECRET);
    await vault.putKey(asWorkspaceId("ws_other"), "openai", "sk_other_0000");
    const meta = await vault.listKeys(WS);
    expect(meta).toHaveLength(1);
    expect(meta[0]?.provider).toBe("anthropic");
  });
});

describe("rotate", () => {
  it("bumps the version and the new plaintext decrypts", async () => {
    const { vault } = await setup();
    await vault.putKey(WS, "openai", SECRET);
    const next = "sk_live_rotated_5678";
    await vault.rotate(WS, "openai", next);
    expect(await vault.getKey(WS, "openai")).toBe(next);
    const meta = await vault.listKeys(WS);
    expect(meta[0]?.version).toBe(2);
    expect(meta[0]?.hint).toBe(next.slice(-4));
  });
});

describe("revoke", () => {
  it("flips status to revoked and getKey returns null", async () => {
    const { vault } = await setup();
    await vault.putKey(WS, "openai", SECRET);
    await vault.revoke(WS, "openai");
    expect(await vault.getKey(WS, "openai")).toBeNull();
    const meta = await vault.listKeys(WS);
    expect(meta[0]?.status).toBe("revoked");
  });

  it("is a no-op for an unknown key", async () => {
    const { vault } = await setup();
    await expect(vault.revoke(WS, "gemini")).resolves.toBeUndefined();
  });
});

// Keeps the otherwise-unused ErrorCode import meaningful as a contract sanity check.
describe("contract wiring", () => {
  it("AUTH error code is exported from contracts", () => {
    expect(ErrorCode.AUTH).toBe("AUTH");
  });
});
