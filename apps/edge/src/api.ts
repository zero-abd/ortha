import { asWorkspaceId, SettingsSchema, type KeyProvider } from "@ortha/contracts";
import { createKeyVault } from "@ortha/auth";
import { DEFAULT_SETTINGS } from "@ortha/db";
import type { Env } from "./env.js";
import { json, workspaceOf } from "./http.js";
import { kvStore } from "./kv.js";

const VALID_PROVIDERS = new Set<KeyProvider>(["orthogonal", "anthropic", "openai", "openrouter", "gemini"]);

/**
 * BYOK key management + per-workspace settings. Keys are AES-GCM encrypted at rest
 * (KeyVault over Cloudflare KV); plaintext never leaves the server or appears in
 * responses. Workspace scope is the client's anonymous id (x-ortha-workspace).
 * Returns null if the path isn't an API route this handler owns.
 */
export async function handleApi(request: Request, env: Env, url: URL): Promise<Response | null> {
  const keyMatch = url.pathname.match(/^\/api\/workspace\/keys(?:\/([^/]+))?$/);
  const isSettings = url.pathname === "/api/settings";
  if (!keyMatch && !isSettings) return null;

  const wsId = workspaceOf(request);
  if (!wsId) return json({ error: "missing or invalid x-ortha-workspace header" }, 400);
  const ws = asWorkspaceId(wsId);

  if (keyMatch) {
    const vault = await createKeyVault({ masterKeyBase64: env.KEY_ENCRYPTION_KEY, store: kvStore(env.KV) });
    const provider = keyMatch[1];

    if (request.method === "GET" && !provider) {
      return json({ keys: await vault.listKeys(ws) });
    }
    if (!provider || !VALID_PROVIDERS.has(provider as KeyProvider)) {
      return json({ error: "unknown provider" }, 400);
    }
    const p = provider as KeyProvider;
    if (request.method === "PUT") {
      const body = (await request.json().catch(() => null)) as { key?: unknown } | null;
      if (!body || typeof body.key !== "string" || body.key.length < 8) {
        return json({ error: "missing or too-short key" }, 400);
      }
      await vault.putKey(ws, p, body.key);
      return json({ ok: true });
    }
    if (request.method === "DELETE") {
      await vault.revoke(ws, p);
      return json({ ok: true });
    }
    return json({ error: "method not allowed" }, 405);
  }

  // /api/settings
  const settingsKey = `settings:${wsId}`;
  if (request.method === "GET") {
    const raw = await env.KV.get(settingsKey);
    return json(raw ? JSON.parse(raw) : DEFAULT_SETTINGS);
  }
  if (request.method === "PUT") {
    const parsed = SettingsSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return json({ error: "invalid settings" }, 400);
    await env.KV.put(settingsKey, JSON.stringify(parsed.data));
    return json({ ok: true });
  }
  return json({ error: "method not allowed" }, 405);
}
