import { API, getDeviceId } from "./config.ts";
import { getToken } from "./auth.ts";

// Every authenticated call carries the session bearer token.
const authHeaders = (): Record<string, string> => {
  const t = getToken();
  return { "content-type": "application/json", ...(t ? { authorization: `Bearer ${t}` } : {}) };
};
// Key endpoints additionally carry the device id — BYOK keys are device-scoped (never synced).
const keyHeaders = (): Record<string, string> => ({ ...authHeaders(), "x-ortha-device": getDeviceId() });

export interface KeyMeta {
  provider: string;
  status: "active" | "revoked";
  hint: string;
  version: number;
}

export async function listKeys(): Promise<KeyMeta[]> {
  const r = await fetch(`${API}/api/workspace/keys`, { headers: keyHeaders() });
  if (!r.ok) return [];
  return ((await r.json()) as { keys: KeyMeta[] }).keys;
}

export async function putKey(provider: string, key: string): Promise<void> {
  const r = await fetch(`${API}/api/workspace/keys/${provider}`, { method: "PUT", headers: keyHeaders(), body: JSON.stringify({ key }) });
  if (!r.ok) {
    const msg = ((await r.json().catch(() => ({}))) as { error?: string }).error;
    throw new Error(msg || `Couldn't save key (${r.status})`);
  }
}

export async function deleteKey(provider: string): Promise<void> {
  await fetch(`${API}/api/workspace/keys/${provider}`, { method: "DELETE", headers: keyHeaders() });
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
  const r = await fetch(`${API}/api/settings`, { headers: authHeaders() });
  return r.ok ? ((await r.json()) as ApiSettings) : null;
}

export async function putSettings(s: ApiSettings): Promise<void> {
  await fetch(`${API}/api/settings`, { method: "PUT", headers: authHeaders(), body: JSON.stringify(s) });
}

export interface Conversation {
  id: string;
  title: string;
  updatedAt: number;
}

export async function listConversations(): Promise<Conversation[]> {
  const r = await fetch(`${API}/api/conversations`, { headers: authHeaders() });
  if (!r.ok) return [];
  return ((await r.json()) as { conversations: Conversation[] }).conversations ?? [];
}

export async function renameConversation(id: string, title: string): Promise<void> {
  await fetch(`${API}/api/conversations/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: authHeaders(),
    body: JSON.stringify({ title }),
  });
}

export async function deleteConversation(id: string): Promise<void> {
  await fetch(`${API}/api/conversations/${encodeURIComponent(id)}`, { method: "DELETE", headers: authHeaders() });
}

export interface Skill {
  id: string;
  name: string;
  template: string;
  createdAt: number;
}

export async function listSkills(): Promise<Skill[]> {
  const r = await fetch(`${API}/api/workspace/skills`, { headers: authHeaders() });
  if (!r.ok) return [];
  return ((await r.json()) as { skills: Skill[] }).skills ?? [];
}

/** Add a new skill; returns the updated list (or null on validation failure). */
export async function saveSkill(input: { name: string; template: string }): Promise<Skill[] | null> {
  const r = await fetch(`${API}/api/workspace/skills`, { method: "POST", headers: authHeaders(), body: JSON.stringify(input) });
  if (!r.ok) return null;
  return ((await r.json()) as { skills: Skill[] }).skills ?? [];
}

export async function deleteSkill(id: string): Promise<Skill[]> {
  const r = await fetch(`${API}/api/workspace/skills/${encodeURIComponent(id)}`, { method: "DELETE", headers: authHeaders() });
  if (!r.ok) return [];
  return ((await r.json()) as { skills: Skill[] }).skills ?? [];
}

export interface UsageData {
  monthCents: number;
  monthlyCapCents: number;
  remainingCents: number;
  periods: { period: string; cents: number }[];
}

export async function getUsage(): Promise<UsageData | null> {
  const r = await fetch(`${API}/api/workspace/usage`, { headers: authHeaders() });
  return r.ok ? ((await r.json()) as UsageData) : null;
}
