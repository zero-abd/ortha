import { describe, expect, it } from "vitest";
import { kvSessionStore } from "../src/auth-stores.js";
import { makeGoogleExchanger } from "../src/google-oauth.js";
import type { Env } from "../src/env.js";
import type { Session, UserId, WorkspaceId } from "@ortha/contracts";

function mockKv(): KVNamespace {
  const m = new Map<string, string>();
  return {
    async get(k: string) {
      return m.get(k) ?? null;
    },
    async put(k: string, v: string) {
      m.set(k, v);
    },
    async delete(k: string) {
      m.delete(k);
    },
  } as unknown as KVNamespace;
}

describe("kvSessionStore", () => {
  it("puts, gets, and deletes a session", async () => {
    const store = kvSessionStore(mockKv());
    const s: Session = { userId: "u1" as UserId, workspaceId: "w1" as WorkspaceId, token: "tok", expiresAt: Date.now() + 100_000 };
    await store.put(s);
    expect((await store.get("tok"))?.workspaceId).toBe("w1");
    await store.del("tok");
    expect(await store.get("tok")).toBeNull();
  });
});

describe("makeGoogleExchanger", () => {
  it("is null when Google isn't configured (route 501s)", () => {
    expect(makeGoogleExchanger({} as Env, "https://app")).toBeNull();
  });

  it("exchanges a code for the verified email from the id_token", async () => {
    const env = { GOOGLE_CLIENT_ID: "id", GOOGLE_CLIENT_SECRET: "sec" } as Env;
    const payload = btoa(JSON.stringify({ email: "a@b.com", email_verified: true })).replace(/=+$/, "");
    const idToken = `header.${payload}.sig`;
    const orig = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify({ id_token: idToken }), { status: 200 })) as typeof fetch;
    try {
      const exchange = makeGoogleExchanger(env, "https://app");
      expect(exchange).not.toBeNull();
      expect((await exchange!("the-code")).email).toBe("a@b.com");
    } finally {
      globalThis.fetch = orig;
    }
  });

  it("rejects an unverified Google email", async () => {
    const env = { GOOGLE_CLIENT_ID: "id", GOOGLE_CLIENT_SECRET: "sec" } as Env;
    const payload = btoa(JSON.stringify({ email: "a@b.com", email_verified: false })).replace(/=+$/, "");
    const orig = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify({ id_token: `h.${payload}.s` }), { status: 200 })) as typeof fetch;
    try {
      const exchange = makeGoogleExchanger(env, "https://app")!;
      await expect(exchange("code")).rejects.toThrow(/not verified/);
    } finally {
      globalThis.fetch = orig;
    }
  });
});
