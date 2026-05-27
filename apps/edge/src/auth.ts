// Auth wiring: build the real AuthService on D1/KV stores, route /api/auth/*, and
// resolve a caller's session from the bearer token.
import { createAuthService } from "@ortha/auth";
import { ErrorCode, isOrthaError, type AuthService, type Session } from "@ortha/contracts";
import { d1Adapter } from "@ortha/db";
import { d1UserStore, d1WorkspaceStore, kvSessionStore } from "./auth-stores.js";
import type { Env } from "./env.js";
import { makeGoogleExchanger } from "./google-oauth.js";
import { bearer, json } from "./http.js";

const googleUnconfigured = async (): Promise<{ email: string }> => {
  throw new Error("google sign-in not configured");
};

/** AuthService backed by D1 (users/workspaces) + KV (sessions). `googleRedirectUri` enables Google. */
export function buildAuthService(env: Env, googleRedirectUri?: string): AuthService {
  const db = d1Adapter(env.DB);
  const exchanger = googleRedirectUri ? makeGoogleExchanger(env, googleRedirectUri) : null;
  return createAuthService({
    users: d1UserStore(db),
    sessions: kvSessionStore(env.KV),
    workspaces: d1WorkspaceStore(db),
    exchangeGoogleCode: exchanger ?? googleUnconfigured,
  });
}

/** Resolve the caller's session from the Authorization bearer token (null if absent/expired). */
export async function resolveSession(request: Request, env: Env): Promise<Session | null> {
  const token = bearer(request);
  if (!token) return null;
  return buildAuthService(env).session(token);
}

const sessionJson = (s: Session): Response =>
  json({ token: s.token, userId: s.userId, workspaceId: s.workspaceId, expiresAt: s.expiresAt });

function authErr(e: unknown): Response {
  if (isOrthaError(e)) {
    const status = e.code === ErrorCode.AUTH ? 401 : e.code === ErrorCode.BAD_REQUEST ? 400 : 500;
    return json({ error: e.message, code: e.code }, status);
  }
  return json({ error: e instanceof Error ? e.message : "auth failed" }, 400);
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  return ((await request.json().catch(() => null)) as Record<string, unknown> | null) ?? {};
}
const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);

/** Auth routes — reachable without a session. Returns null when the path isn't /api/auth/*. */
export async function handleAuth(request: Request, env: Env, url: URL): Promise<Response | null> {
  if (!url.pathname.startsWith("/api/auth/")) return null;
  const route = url.pathname.slice("/api/auth/".length);

  if (request.method === "POST" && route === "signup") {
    const b = await readJson(request);
    const email = str(b["email"]);
    const password = str(b["password"]);
    if (!email || !password) return json({ error: "email and password required" }, 400);
    try {
      return sessionJson(await buildAuthService(env).signupEmail(email, password));
    } catch (e) {
      return authErr(e);
    }
  }

  if (request.method === "POST" && route === "login") {
    const b = await readJson(request);
    const email = str(b["email"]);
    const password = str(b["password"]);
    if (!email || !password) return json({ error: "email and password required" }, 400);
    try {
      return sessionJson(await buildAuthService(env).loginEmail(email, password));
    } catch (e) {
      return authErr(e);
    }
  }

  if (request.method === "POST" && route === "google") {
    if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) return json({ error: "google sign-in not configured" }, 501);
    const b = await readJson(request);
    const code = str(b["code"]);
    const redirectUri = str(b["redirectUri"]);
    if (!code || !redirectUri) return json({ error: "code and redirectUri required" }, 400);
    try {
      return sessionJson(await buildAuthService(env, redirectUri).loginGoogle(code));
    } catch (e) {
      return authErr(e);
    }
  }

  if (request.method === "POST" && route === "logout") {
    const token = bearer(request);
    if (token) await kvSessionStore(env.KV).del(token);
    return json({ ok: true });
  }

  if (request.method === "GET" && route === "me") {
    const session = await resolveSession(request, env);
    if (!session) return json({ error: "unauthorized" }, 401);
    const user = await d1UserStore(d1Adapter(env.DB)).findById(session.userId);
    return json({
      userId: session.userId,
      workspaceId: session.workspaceId,
      email: user?.email ?? null,
      displayName: user?.displayName ?? null,
    });
  }

  return json({ error: "not found" }, 404);
}
