import { API, getWorkspaceId } from "./config.ts";

export interface KeyMeta {
  provider: string;
  status: "active" | "revoked";
  hint: string;
  version: number;
}

const headers = (): Record<string, string> => ({
  "content-type": "application/json",
  "x-ortha-workspace": getWorkspaceId(),
});

export async function listKeys(): Promise<KeyMeta[]> {
  const r = await fetch(`${API}/api/workspace/keys`, { headers: headers() });
  if (!r.ok) return [];
  return ((await r.json()) as { keys: KeyMeta[] }).keys;
}

export async function putKey(provider: string, key: string): Promise<void> {
  await fetch(`${API}/api/workspace/keys/${provider}`, { method: "PUT", headers: headers(), body: JSON.stringify({ key }) });
}

export async function deleteKey(provider: string): Promise<void> {
  await fetch(`${API}/api/workspace/keys/${provider}`, { method: "DELETE", headers: headers() });
}

export interface ApiSettings {
  sessionCapCents: number;
  perCallWarnCents: number;
  monthlyCapCents: number;
  model: string;
  theme: string;
  cacheTtlSeconds: number;
}

export async function getSettings(): Promise<ApiSettings | null> {
  const r = await fetch(`${API}/api/settings`, { headers: headers() });
  return r.ok ? ((await r.json()) as ApiSettings) : null;
}

export async function putSettings(s: ApiSettings): Promise<void> {
  await fetch(`${API}/api/settings`, { method: "PUT", headers: headers(), body: JSON.stringify(s) });
}
