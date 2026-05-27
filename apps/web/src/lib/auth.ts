// Client-side session + auth API. The session token lives in localStorage: the SPA
// and worker are cross-origin, so a Bearer token is simpler than cross-site cookies.
import { API } from "./config.ts";

const TOKEN_KEY = "ortha.token";

export const getToken = (): string | null => (typeof localStorage === "undefined" ? null : localStorage.getItem(TOKEN_KEY));
export const setToken = (t: string): void => localStorage.setItem(TOKEN_KEY, t);
export const clearToken = (): void => localStorage.removeItem(TOKEN_KEY);

export interface AuthUser {
  userId: string;
  workspaceId: string;
  email: string | null;
  displayName: string | null;
}

async function postAuth(path: string, body: unknown): Promise<string> {
  const r = await fetch(`${API}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await r.json().catch(() => ({}))) as { token?: string; error?: string };
  if (!r.ok || !data.token) throw new Error(data.error || `request failed (${r.status})`);
  return data.token;
}

export async function signup(email: string, password: string): Promise<void> {
  setToken(await postAuth("/api/auth/signup", { email, password }));
}
export async function login(email: string, password: string): Promise<void> {
  setToken(await postAuth("/api/auth/login", { email, password }));
}
export async function loginGoogle(code: string, redirectUri: string): Promise<void> {
  setToken(await postAuth("/api/auth/google", { code, redirectUri }));
}
export async function me(): Promise<AuthUser | null> {
  const token = getToken();
  if (!token) return null;
  const r = await fetch(`${API}/api/auth/me`, { headers: { authorization: `Bearer ${token}` } });
  if (!r.ok) return null;
  return (await r.json()) as AuthUser;
}
export async function logout(): Promise<void> {
  const token = getToken();
  if (token) {
    await fetch(`${API}/api/auth/logout`, { method: "POST", headers: { authorization: `Bearer ${token}` } }).catch(() => undefined);
  }
  clearToken();
}
