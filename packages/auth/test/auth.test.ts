import { ErrorCode, isOrthaError } from "@ortha/contracts";
import { describe, expect, it } from "vitest";
import { createAuthService, type AuthServiceDeps, type GoogleCodeExchanger } from "../src/auth.js";
import {
  createMemorySessionStore,
  createMemoryUserStore,
  createMemoryWorkspaceStore,
} from "../src/memory.js";

const buildService = (overrides: Partial<AuthServiceDeps> = {}): ReturnType<typeof createAuthService> => {
  const exchangeGoogleCode: GoogleCodeExchanger = async (code) => ({ email: `${code}@gmail.com` });
  return createAuthService({
    users: createMemoryUserStore(),
    sessions: createMemorySessionStore(),
    workspaces: createMemoryWorkspaceStore(),
    exchangeGoogleCode,
    ...overrides,
  });
};

describe("email signup + login", () => {
  it("signup returns a session with a workspace", async () => {
    const auth = buildService();
    const session = await auth.signupEmail("Alice@Example.com", "hunter2pw");
    expect(session.token).toBeTruthy();
    expect(session.userId).toBeTruthy();
    expect(session.workspaceId).toBeTruthy();
    expect(session.expiresAt).toBeGreaterThan(Date.now());
  });

  it("login after signup succeeds and reuses the same workspace", async () => {
    const auth = buildService();
    const signup = await auth.signupEmail("bob@example.com", "correcthorse");
    const login = await auth.loginEmail("bob@example.com", "correcthorse");
    expect(login.userId).toBe(signup.userId);
    expect(login.workspaceId).toBe(signup.workspaceId);
    expect(login.token).not.toBe(signup.token); // a fresh session token
  });

  it("normalizes email case on login", async () => {
    const auth = buildService();
    await auth.signupEmail("Case@Example.com", "passwordy1");
    const login = await auth.loginEmail("case@example.com", "passwordy1");
    expect(login.token).toBeTruthy();
  });

  it("rejects a duplicate signup with AUTH", async () => {
    const auth = buildService();
    await auth.signupEmail("dup@example.com", "passwordy1");
    const err = await auth.signupEmail("dup@example.com", "passwordy1").catch((e) => e);
    expect(isOrthaError(err) && err.code).toBe(ErrorCode.AUTH);
  });

  it("rejects too-short passwords with BAD_REQUEST", async () => {
    const auth = buildService();
    const err = await auth.signupEmail("short@example.com", "tiny").catch((e) => e);
    expect(isOrthaError(err) && err.code).toBe(ErrorCode.BAD_REQUEST);
  });
});

describe("wrong credentials", () => {
  it("wrong password throws AUTH", async () => {
    const auth = buildService();
    await auth.signupEmail("carol@example.com", "rightpassword");
    await expect(auth.loginEmail("carol@example.com", "wrongpassword")).rejects.toMatchObject({
      code: ErrorCode.AUTH,
    });
  });

  it("unknown email throws AUTH", async () => {
    const auth = buildService();
    await expect(auth.loginEmail("nobody@example.com", "whatever1")).rejects.toMatchObject({
      code: ErrorCode.AUTH,
    });
  });
});

describe("session lookup", () => {
  it("returns the session for a valid token", async () => {
    const auth = buildService();
    const created = await auth.signupEmail("dave@example.com", "passwordy1");
    const found = await auth.session(created.token);
    expect(found?.userId).toBe(created.userId);
    expect(found?.workspaceId).toBe(created.workspaceId);
  });

  it("returns null for an unknown token", async () => {
    const auth = buildService();
    expect(await auth.session("not-a-real-token")).toBeNull();
  });

  it("returns null for an expired token", async () => {
    let t = 1_000_000;
    const auth = buildService({ sessionTtlMs: 50, now: () => t });
    const created = await auth.signupEmail("eve@example.com", "passwordy1");
    expect(await auth.session(created.token)).not.toBeNull();
    t += 1_000; // advance well past the 50ms TTL
    expect(await auth.session(created.token)).toBeNull();
  });
});

describe("loginGoogle", () => {
  it("returns a session via the mock exchanger (new user upserted)", async () => {
    const auth = buildService();
    const session = await auth.loginGoogle("frank");
    expect(session.token).toBeTruthy();
    expect(session.workspaceId).toBeTruthy();
  });

  it("reuses the existing user/workspace on a second google login", async () => {
    const auth = buildService();
    const first = await auth.loginGoogle("grace");
    const second = await auth.loginGoogle("grace");
    expect(second.userId).toBe(first.userId);
    expect(second.workspaceId).toBe(first.workspaceId);
  });

  it("maps an exchanger failure to AUTH", async () => {
    const auth = buildService({
      exchangeGoogleCode: async () => {
        throw new Error("bad code");
      },
    });
    await expect(auth.loginGoogle("nope")).rejects.toMatchObject({ code: ErrorCode.AUTH });
  });

  it("a google user can later still be found by email", async () => {
    const users = createMemoryUserStore();
    const auth = buildService({ users });
    await auth.loginGoogle("heidi");
    expect(await users.findByEmail("heidi@gmail.com")).not.toBeNull();
  });
});
