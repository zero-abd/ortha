import { useEffect, useState } from "react";
import { deleteKey, getSettings, getUsage, listKeys, putKey, putSettings, type ApiSettings, type KeyMeta, type UsageData } from "../lib/api.ts";
import type { AuthUser } from "../lib/auth.ts";
import { PROVIDERS, defaultModelOf, modelInfo, modelsForProvider, providerOfModel } from "../lib/providers.ts";
import { DEFAULT_MODEL_ID } from "@ortha/contracts";
import { Dropdown } from "./Dropdown.tsx";

const KEY_PROVIDERS = [
  { id: "orthogonal", label: "Orthogonal API key", placeholder: "orth_live_…" },
  { id: "gemini", label: "Google Gemini key", placeholder: "AIza… (free tier)" },
  { id: "openrouter", label: "OpenRouter key", placeholder: "sk-or-… (free models)" },
  { id: "openai", label: "OpenAI key", placeholder: "sk-…" },
  { id: "anthropic", label: "Anthropic key", placeholder: "sk-ant-…" },
] as const;

const DEFAULTS: ApiSettings = {
  sessionCapCents: 500,
  perCallWarnCents: 25,
  monthlyCapCents: 10_000,
  model: DEFAULT_MODEL_ID,
  theme: "system",
  cacheTtlSeconds: 300,
};

const toDollars = (cents: number): string => (cents / 100).toString();
const toCents = (dollars: string): number => Math.max(0, Math.round(Number(dollars) * 100));
const fmt = (cents: number): string => `$${(cents / 100).toFixed(2)}`;

type Tab = "keys" | "defaults" | "usage" | "account";
const TABS: { id: Tab; label: string }[] = [
  { id: "keys", label: "API Keys" },
  { id: "defaults", label: "Defaults" },
  { id: "usage", label: "Usage" },
  { id: "account", label: "Account" },
];

interface Props {
  open: boolean;
  onClose: () => void;
  onSaved?: (s: ApiSettings) => void;
  user: AuthUser | null;
  onSignOut: () => void | Promise<void>;
}

export function SettingsModal({ open, onClose, onSaved, user, onSignOut }: Props) {
  const [tab, setTab] = useState<Tab>("keys");
  const [keys, setKeys] = useState<KeyMeta[]>([]);
  const [settings, setSettings] = useState<ApiSettings>(DEFAULTS);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [usage, setUsage] = useState<UsageData | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [keyError, setKeyError] = useState("");

  useEffect(() => {
    if (!open) return;
    void (async () => {
      setKeys(await listKeys());
      setSettings((await getSettings()) ?? DEFAULTS);
    })();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  useEffect(() => {
    if (open && tab === "usage") void getUsage().then(setUsage);
  }, [open, tab]);

  if (!open) return null;

  const active = (provider: string) => keys.find((k) => k.provider === provider && k.status === "active");
  const currentProvider = providerOfModel(settings.model);

  const saveKey = async (provider: string) => {
    const v = drafts[provider]?.trim();
    if (!v) return;
    setBusy(true);
    setKeyError("");
    try {
      await putKey(provider, v);
      // Optimistically reflect the save so the "· set" badge appears immediately
      // (and a real failure throws above, so we never show a false positive).
      const hint = v.length > 4 ? v.slice(-4) : "";
      setKeys((prev) => [...prev.filter((k) => k.provider !== provider), { provider, status: "active", hint, version: 1 }]);
      setDrafts((d) => ({ ...d, [provider]: "" }));
    } catch (e) {
      setKeyError(e instanceof Error ? e.message : "Couldn't save the key. Try again.");
    } finally {
      setBusy(false);
    }
  };
  const removeKey = async (provider: string) => {
    setBusy(true);
    setKeyError("");
    try {
      await deleteKey(provider);
      setKeys((prev) => prev.filter((k) => k.provider !== provider));
    } catch {
      setKeyError("Couldn't remove the key. Try again.");
    } finally {
      setBusy(false);
    }
  };
  const saveSettings = async () => {
    setBusy(true);
    await putSettings(settings);
    setBusy(false);
    setSaved(true);
    onSaved?.(settings);
    setTimeout(() => setSaved(false), 1600);
  };

  const usedRatio = usage && usage.monthlyCapCents > 0 ? Math.min(1, usage.monthCents / usage.monthlyCapCents) : 0;

  return (
    <div className="settings-scrim" onClick={onClose}>
      <div className="settings settings--tabbed" role="dialog" aria-modal="true" aria-label="Settings" onClick={(e) => e.stopPropagation()}>
        <aside className="settings__tabs">
          <div className="settings__tabs-title">Settings</div>
          {TABS.map((t) => (
            <button key={t.id} className={`settings__tab${tab === t.id ? " settings__tab--active" : ""}`} onClick={() => setTab(t.id)}>
              {t.label}
            </button>
          ))}
        </aside>

        <div className="settings__panel">
          <div className="settings__head">
            <span className="settings__title">{TABS.find((t) => t.id === tab)?.label}</span>
            <button className="iconbtn" onClick={onClose} aria-label="Close settings">✕</button>
          </div>

          <div className="settings__content">
            {/* ── API Keys (device-local) ─────────────────────────────── */}
            {tab === "keys" && (
              <div className="settings__section">
                <span className="settings__help">
                  Bring your own keys — encrypted at rest, never shown again. <strong>Stored on this device only — keys don't sync.</strong> Add them on each device you use.
                </span>
                {KEY_PROVIDERS.map((p) => {
                  const set = active(p.id);
                  return (
                    <div className="field" key={p.id}>
                      <span className="settings__sublabel">
                        {p.label} {set && <span className="tag-ok">· set ••••{set.hint}</span>}
                      </span>
                      <div className="field__row">
                        <input
                          className="input"
                          type="password"
                          placeholder={p.placeholder}
                          value={drafts[p.id] ?? ""}
                          onChange={(e) => setDrafts((d) => ({ ...d, [p.id]: e.target.value }))}
                        />
                        <button className="btn-sm" disabled={busy} onClick={() => void saveKey(p.id)}>Save</button>
                        {set && <button className="btn-sm" disabled={busy} onClick={() => void removeKey(p.id)}>Remove</button>}
                      </div>
                    </div>
                  );
                })}
                {keyError && <span className="skill__error">{keyError}</span>}
              </div>
            )}

            {/* ── Defaults: provider + spending limits ─────────────────── */}
            {tab === "defaults" && (
              <>
                <div className="settings__section">
                  <span className="settings__label">Provider &amp; model</span>
                  <Dropdown
                    value={currentProvider}
                    options={PROVIDERS.map((p) => ({ value: p.id, label: p.label }))}
                    onChange={(v) => setSettings((s) => ({ ...s, model: defaultModelOf(v) }))}
                    ariaLabel="Provider"
                    block
                  />
                  <div style={{ marginTop: 8 }}>
                    <Dropdown
                      value={settings.model}
                      options={modelsForProvider(currentProvider).map((m) => ({ value: m.id, label: m.displayName + (m.free ? "" : " · paid") }))}
                      onChange={(v) => setSettings((s) => ({ ...s, model: v }))}
                      ariaLabel="Model"
                      block
                    />
                  </div>
                  <span className="settings__help">
                    Using <span className="mono">{modelInfo(settings.model)?.displayName ?? settings.model}</span>. Switch to a Pro model here when you need more capability. Saved per account (syncs across devices).
                  </span>
                </div>
                <div className="settings__divider" />
                <div className="settings__section">
                  <span className="settings__label">Spending limits</span>
                  <div className="field">
                    <span className="settings__sublabel">Session cap ($)</span>
                    <input className="input" type="number" min={0} step="0.25" value={toDollars(settings.sessionCapCents)} onChange={(e) => setSettings((s) => ({ ...s, sessionCapCents: toCents(e.target.value) }))} />
                    <span className="settings__help">Max spend per conversation before Ortha pauses to ask permission.</span>
                  </div>
                  <div className="field">
                    <span className="settings__sublabel">Per-call warn ($)</span>
                    <input className="input" type="number" min={0} step="0.01" value={toDollars(settings.perCallWarnCents)} onChange={(e) => setSettings((s) => ({ ...s, perCallWarnCents: toCents(e.target.value) }))} />
                    <span className="settings__help">Ask before any single tool call priced at or above this amount.</span>
                  </div>
                  <div className="field">
                    <span className="settings__sublabel">Monthly cap ($)</span>
                    <input className="input" type="number" min={0} step="1" value={toDollars(settings.monthlyCapCents)} onChange={(e) => setSettings((s) => ({ ...s, monthlyCapCents: toCents(e.target.value) }))} />
                    <span className="settings__help">Hard ceiling across every conversation this month. Ortha stops when reached.</span>
                  </div>
                  <button className="btn-sm btn-sm--accent" style={{ alignSelf: "flex-start", marginTop: 4 }} disabled={busy} onClick={() => void saveSettings()}>
                    {saved ? "Saved ✓" : "Save settings"}
                  </button>
                </div>
              </>
            )}

            {/* ── Usage: monthly spend (syncs across devices) ──────────── */}
            {tab === "usage" && (
              <div className="settings__section">
                <span className="settings__label">This month</span>
                <div className="usage__headline">
                  <span className="usage__amt">{usage ? fmt(usage.monthCents) : "—"}</span>
                  <span className="muted"> of {usage ? fmt(usage.monthlyCapCents) : "—"} cap</span>
                </div>
                <span className="cost__bar" aria-hidden style={{ width: "100%" }}>
                  <span className={`cost__fill${usedRatio >= 1 ? " cost__fill--danger" : usedRatio >= 0.8 ? " cost__fill--warn" : ""}`} style={{ width: `${usedRatio * 100}%` }} />
                </span>
                <span className="settings__help">{usage ? `${fmt(usage.remainingCents)} remaining this month.` : "Loading usage…"} Spend is account-wide and syncs across your devices.</span>
                {usage && usage.periods.length > 0 && (
                  <div className="breakdown" style={{ marginTop: 8 }}>
                    {usage.periods.map((p) => (
                      <div className="breakdown__row" key={p.period}>
                        <span className="breakdown__api mono">{p.period}</span>
                        <span>{fmt(p.cents)}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* ── Account ──────────────────────────────────────────────── */}
            {tab === "account" && (
              <div className="settings__section">
                <span className="settings__label">Signed in as</span>
                <div className="acct-card">
                  <span className="acct__avatar">{(user?.displayName ?? user?.email ?? "U").charAt(0).toUpperCase()}</span>
                  <div>
                    <div className="settings__sublabel">{user?.displayName ?? user?.email ?? "Account"}</div>
                    {user?.email && <div className="muted" style={{ fontSize: 12.5 }}>{user.email}</div>}
                  </div>
                </div>
                <span className="settings__help">Your chats and settings sync to every device you sign in on. API keys stay on this device and are never synced.</span>
                <button className="btn-sm" style={{ alignSelf: "flex-start", marginTop: 4 }} onClick={() => void onSignOut()}>Sign out</button>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
