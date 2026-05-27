import { asWorkspaceId, SettingsSchema, type KeyProvider, type Session } from "@ortha/contracts";
import { createKeyVault } from "@ortha/auth";
import { d1Adapter, DEFAULT_SETTINGS } from "@ortha/db";
import type { Env } from "./env.js";
import { deviceOf, json } from "./http.js";
import { kvStore } from "./kv.js";

const VALID_PROVIDERS = new Set<KeyProvider>(["orthogonal", "anthropic", "openai", "openrouter", "gemini"]);

/** UTC 'YYYY-MM' for the current billing period (matches DurableSpendStore). */
function currentPeriod(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${(d.getUTCMonth() + 1).toString().padStart(2, "0")}`;
}

/**
 * Authenticated workspace API. The caller has already validated the `session`.
 *   - BYOK keys: **device-scoped** (the `x-ortha-device` header) — keys never sync.
 *   - Settings + usage: **workspace-scoped** (`session.workspaceId`) — they sync.
 * Returns null if the path isn't one this handler owns.
 */
export async function handleApi(request: Request, env: Env, url: URL, session: Session): Promise<Response | null> {
  const keyMatch = url.pathname.match(/^\/api\/workspace\/keys(?:\/([^/]+))?$/);
  const isSettings = url.pathname === "/api/settings";
  const isUsage = url.pathname === "/api/workspace/usage";
  if (!keyMatch && !isSettings && !isUsage) return null;

  // ── BYOK keys — device-local, encrypted at rest, never synced ──
  if (keyMatch) {
    const device = deviceOf(request);
    if (!device) return json({ error: "missing or invalid x-ortha-device header" }, 400);
    const scope = asWorkspaceId(device); // a per-device key namespace (not a workspace)
    const vault = await createKeyVault({ masterKeyBase64: env.KEY_ENCRYPTION_KEY, store: kvStore(env.KV) });
    const provider = keyMatch[1];

    if (request.method === "GET" && !provider) {
      return json({ keys: await vault.listKeys(scope) });
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
      await vault.putKey(scope, p, body.key);
      return json({ ok: true });
    }
    if (request.method === "DELETE") {
      await vault.revoke(scope, p);
      return json({ ok: true });
    }
    return json({ error: "method not allowed" }, 405);
  }

  // ── Usage — workspace monthly spend (account-level, syncs) ──
  if (isUsage) {
    if (request.method !== "GET") return json({ error: "method not allowed" }, 405);
    const rawSettings = await env.KV.get(`settings:${session.workspaceId}`);
    const monthlyCapCents =
      (rawSettings ? (JSON.parse(rawSettings) as { monthlyCapCents?: number }).monthlyCapCents : undefined) ??
      DEFAULT_SETTINGS.monthlyCapCents;
    const rows = await d1Adapter(env.DB)
      .all(`SELECT period, reserved_cents, settled_cents FROM workspace_spend WHERE workspace_id = ? ORDER BY period DESC`, [session.workspaceId])
      .catch(() => [] as Record<string, unknown>[]);
    const periods = rows.map((r) => ({ period: String(r["period"]), cents: Number(r["settled_cents"] ?? 0) }));
    const current = rows.find((r) => String(r["period"]) === currentPeriod());
    const monthCents = current ? Number(current["settled_cents"] ?? 0) + Number(current["reserved_cents"] ?? 0) : 0;
    return json({ monthCents, monthlyCapCents, remainingCents: Math.max(0, monthlyCapCents - monthCents), periods });
  }

  // ── Settings — per workspace (syncs) ──
  const settingsKey = `settings:${session.workspaceId}`;
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
