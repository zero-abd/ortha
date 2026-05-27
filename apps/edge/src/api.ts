import { asWorkspaceId, SettingsSchema, type KeyProvider, type Session } from "@ortha/contracts";
import { createKeyVault } from "@ortha/auth";
import { d1Adapter, DEFAULT_SETTINGS } from "@ortha/db";
import type { Env } from "./env.js";
import { deviceOf, json } from "./http.js";
import { kvStore } from "./kv.js";

const VALID_PROVIDERS = new Set<KeyProvider>(["orthogonal", "anthropic", "openai", "openrouter", "gemini"]);

/** A saved, parameterized prompt workflow. Workspace-scoped (syncs). */
export interface Skill {
  id: string;
  name: string;
  template: string;
  createdAt: number;
}

// Big enough to hold an installed public skill's SKILL.md (capped at
// MAX_PUBLIC_SKILL_CONTENT), not just a short hand-written template. The longest
// skill in the orthogonal.com catalog is ~22k chars; keep headroom above that.
const MAX_TEMPLATE = 30000;
const MAX_NAME = 120;

/** Cap on the SKILL.md body we surface for a public catalog skill — they can be large. */
// Bring in the FULL SKILL.md for every catalog skill (longest is ~22k chars), not a
// truncated head — so installed/used skills carry their complete instructions.
const MAX_PUBLIC_SKILL_CONTENT = 25000;
/** KV cache key + TTL for the transformed public skills catalog. */
// v2: full SKILL.md content (was truncated at 6000 under v1). Bumping the key
// invalidates the stale truncated cache without waiting for its TTL.
const PUBLIC_SKILLS_CACHE_KEY = "public-skills:v2";
const PUBLIC_SKILLS_TTL_SECONDS = 3600;
/** Public, no-auth Orthogonal skills catalog (discover mode). */
const PUBLIC_SKILLS_URL = "https://api.orthogonal.com/api/skills?discover=true";

/** A trimmed public-catalog skill, as returned by `GET /api/skills/public`. */
export interface PublicSkill {
  id: string;
  name: string;
  slug: string;
  description: string;
  highlighted: boolean;
  installCount: number;
  verified: boolean;
  tags: string[];
  content: string;
}

/** One skill as the upstream discover catalog returns it (only the fields we read). */
interface RawCatalogSkill {
  id?: unknown;
  name?: unknown;
  slug?: unknown;
  description?: unknown;
  highlighted?: unknown;
  installCount?: unknown;
  verified?: unknown;
  tags?: unknown;
  files?: unknown;
}

/**
 * Transform the upstream discover catalog into our trimmed `PublicSkill[]`:
 *   - `content` = the `SKILL.md` file's body, capped at MAX_PUBLIC_SKILL_CONTENT chars.
 *   - sorted featured (`highlighted`) first, then by `installCount` desc.
 * Pure (no I/O) so it's unit-testable. Tolerates missing/oddly-typed fields.
 */
export function transformPublicSkills(raw: unknown): PublicSkill[] {
  const skills = (raw as { skills?: unknown } | null)?.skills;
  if (!Array.isArray(skills)) return [];
  const mapped: PublicSkill[] = skills.map((s) => {
    const sk = (s ?? {}) as RawCatalogSkill;
    const files = Array.isArray(sk.files) ? (sk.files as { filePath?: unknown; content?: unknown }[]) : [];
    const skillMd = files.find((f) => f?.filePath === "SKILL.md");
    const content = typeof skillMd?.content === "string" ? skillMd.content.slice(0, MAX_PUBLIC_SKILL_CONTENT) : "";
    return {
      id: typeof sk.id === "string" ? sk.id : "",
      name: typeof sk.name === "string" ? sk.name : "",
      slug: typeof sk.slug === "string" ? sk.slug : "",
      description: typeof sk.description === "string" ? sk.description : "",
      highlighted: sk.highlighted === true,
      installCount: typeof sk.installCount === "number" ? sk.installCount : 0,
      verified: sk.verified === true,
      tags: Array.isArray(sk.tags) ? sk.tags.filter((t): t is string => typeof t === "string") : [],
      content,
    };
  });
  // Featured first, then most-installed first.
  return mapped.sort((a, b) => Number(b.highlighted) - Number(a.highlighted) || b.installCount - a.installCount);
}

/** Read the workspace's skills from KV, tolerating a missing/corrupt blob. */
async function readSkills(env: Env, workspaceId: string): Promise<Skill[]> {
  const raw = await env.KV.get(`skills:${workspaceId}`);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as Skill[]) : [];
  } catch {
    return [];
  }
}

/**
 * Validate + normalize an incoming skill payload (name + template). Returns the
 * trimmed fields on success or an error string. Shared by add (POST) and replace (PUT).
 */
export function validateSkillInput(body: unknown): { name: string; template: string } | { error: string } {
  const b = body as { name?: unknown; template?: unknown } | null;
  const name = typeof b?.name === "string" ? b.name.trim() : "";
  const template = typeof b?.template === "string" ? b.template.trim() : "";
  if (!name) return { error: "name is required" };
  if (name.length > MAX_NAME) return { error: "name too long" };
  if (!template) return { error: "template is required" };
  if (template.length > MAX_TEMPLATE) return { error: `template too long (max ${MAX_TEMPLATE} chars)` };
  return { name, template };
}

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
  const skillMatch = url.pathname.match(/^\/api\/workspace\/skills(?:\/([^/]+))?$/);
  const isSettings = url.pathname === "/api/settings";
  const isUsage = url.pathname === "/api/workspace/usage";
  const isPublicSkills = url.pathname === "/api/skills/public";
  const isConnectors = url.pathname === "/api/connectors";
  const isGmailConnect = url.pathname === "/api/connectors/gmail/connect";
  if (!keyMatch && !skillMatch && !isSettings && !isUsage && !isPublicSkills && !isConnectors && !isGmailConnect) return null;

  // ── Public skills catalog — proxied from Orthogonal (public, no-auth upstream) so
  // the web app avoids CORS. Cached in KV for an hour; serves stale on upstream failure. ──
  if (isPublicSkills) {
    if (request.method !== "GET") return json({ error: "method not allowed" }, 405);
    const cached = await env.KV.get(PUBLIC_SKILLS_CACHE_KEY);
    if (cached) {
      try {
        return json({ skills: JSON.parse(cached) as PublicSkill[] });
      } catch {
        /* corrupt cache → fall through and refetch */
      }
    }
    try {
      const upstream = await fetch(PUBLIC_SKILLS_URL, { headers: { accept: "application/json" } });
      if (!upstream.ok) throw new Error(`upstream ${upstream.status}`);
      const skills = transformPublicSkills(await upstream.json());
      await env.KV.put(PUBLIC_SKILLS_CACHE_KEY, JSON.stringify(skills), { expirationTtl: PUBLIC_SKILLS_TTL_SECONDS });
      return json({ skills });
    } catch (err) {
      // No fresh data: serve stale cache if any (best effort), else an empty list so the UI still loads.
      console.error("public skills fetch failed", err);
      const stale = await env.KV.get(PUBLIC_SKILLS_CACHE_KEY);
      if (stale) {
        try {
          return json({ skills: JSON.parse(stale) as PublicSkill[] });
        } catch {
          /* fall through to empty */
        }
      }
      return json({ skills: [] });
    }
  }

  // ── Connectors — static scaffold; no real integration yet. ──
  if (isConnectors) {
    if (request.method !== "GET") return json({ error: "method not allowed" }, 405);
    return json({
      connectors: [
        {
          id: "gmail",
          name: "Gmail",
          description: "Connect your Gmail to let Ortha read and act on email.",
          status: "coming_soon",
        },
      ],
    });
  }
  if (isGmailConnect) {
    if (request.method !== "POST") return json({ error: "method not allowed" }, 405);
    return json({ status: "coming_soon", message: "Gmail connector is not available yet." });
  }

  // ── BYOK keys — device-local, encrypted at rest, never synced ──
  if (keyMatch) {
    const device = deviceOf(request);
    if (!device) return json({ error: "missing or invalid x-ortha-device header" }, 400);
    const scope = asWorkspaceId(device); // a per-device key namespace (not a workspace)
    const vault = await createKeyVault({ masterKeyBase64: env.KEY_ENCRYPTION_KEY, store: kvStore(env.KV) });
    const provider = keyMatch[1];

    if (request.method === "GET" && !provider) {
      // Build the list with per-provider get() (strongly consistent in the
      // caller's colo) rather than vault.listKeys() which scans KV.list — that
      // index is eventually consistent and can omit a just-saved key for up to a
      // minute, making the UI claim a key "didn't save" when it actually did.
      const metas: { provider: KeyProvider; version: number; status: "active"; hint: string }[] = [];
      for (const prov of VALID_PROVIDERS) {
        const plaintext = await vault.getKey(scope, prov);
        if (plaintext) metas.push({ provider: prov, version: 1, status: "active", hint: plaintext.length > 4 ? plaintext.slice(-4) : "" });
      }
      return json({ keys: metas });
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

  // ── Skills — saved parameterized prompts, per workspace (syncs) ──
  if (skillMatch) {
    const skillsKey = `skills:${session.workspaceId}`;
    const id = skillMatch[1];

    if (request.method === "GET" && !id) {
      return json({ skills: await readSkills(env, session.workspaceId) });
    }
    // Replace the whole list with the posted skills.
    if (request.method === "PUT" && !id) {
      const body = (await request.json().catch(() => null)) as { skills?: unknown } | null;
      if (!Array.isArray(body?.skills)) return json({ error: "skills array required" }, 400);
      const next: Skill[] = [];
      for (const raw of body.skills) {
        const v = validateSkillInput(raw);
        if ("error" in v) return json({ error: v.error }, 400);
        const r = raw as Partial<Skill>;
        next.push({
          id: typeof r.id === "string" && r.id ? r.id : crypto.randomUUID(),
          name: v.name,
          template: v.template,
          createdAt: typeof r.createdAt === "number" ? r.createdAt : Date.now(),
        });
      }
      await env.KV.put(skillsKey, JSON.stringify(next));
      return json({ skills: next });
    }
    // Add a single skill to the list — UPSERT by name so re-installing a skill
    // (e.g. the same public skill) replaces its entry instead of piling up duplicates
    // in the list and the `/` command picker.
    if (request.method === "POST" && !id) {
      const v = validateSkillInput(await request.json().catch(() => null));
      if ("error" in v) return json({ error: v.error }, 400);
      const list = await readSkills(env, session.workspaceId);
      const existing = list.find((s) => s.name === v.name);
      const skill: Skill = {
        id: existing?.id ?? crypto.randomUUID(),
        name: v.name,
        template: v.template,
        createdAt: existing?.createdAt ?? Date.now(),
      };
      const next = existing ? list.map((s) => (s.name === v.name ? skill : s)) : [...list, skill];
      await env.KV.put(skillsKey, JSON.stringify(next));
      return json({ skills: next });
    }
    // Delete a single skill by id.
    if (request.method === "DELETE" && id) {
      const list = await readSkills(env, session.workspaceId);
      const next = list.filter((s) => s.id !== id);
      await env.KV.put(skillsKey, JSON.stringify(next));
      return json({ skills: next });
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
