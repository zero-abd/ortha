import { useEffect, useState } from "react";
import { deleteKey, getSettings, listKeys, putKey, putSettings, type ApiSettings, type KeyMeta } from "../lib/api.ts";
import { PROVIDERS, defaultModelOf, providerOfModel } from "../lib/providers.ts";
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
  model: "gemini-2.0-flash",
  theme: "system",
  cacheTtlSeconds: 300,
};

const toDollars = (cents: number): string => (cents / 100).toString();
const toCents = (dollars: string): number => Math.max(0, Math.round(Number(dollars) * 100));

export function SettingsModal({ open, onClose, onSaved }: { open: boolean; onClose: () => void; onSaved?: (s: ApiSettings) => void }) {
  const [keys, setKeys] = useState<KeyMeta[]>([]);
  const [settings, setSettings] = useState<ApiSettings>(DEFAULTS);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

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

  if (!open) return null;

  const active = (provider: string) => keys.find((k) => k.provider === provider && k.status === "active");
  const currentProvider = providerOfModel(settings.model);

  const saveKey = async (provider: string) => {
    const v = drafts[provider]?.trim();
    if (!v) return;
    setBusy(true);
    await putKey(provider, v);
    setDrafts((d) => ({ ...d, [provider]: "" }));
    setKeys(await listKeys());
    setBusy(false);
  };
  const removeKey = async (provider: string) => {
    setBusy(true);
    await deleteKey(provider);
    setKeys(await listKeys());
    setBusy(false);
  };
  const saveSettings = async () => {
    setBusy(true);
    await putSettings(settings);
    setBusy(false);
    setSaved(true);
    onSaved?.(settings);
    setTimeout(() => setSaved(false), 1600);
  };

  return (
    <div className="settings-scrim" onClick={onClose}>
      <div className="settings settings--lg" role="dialog" aria-modal="true" aria-label="Settings" onClick={(e) => e.stopPropagation()}>
        <div className="settings__head">
          <span className="settings__title">Settings · BYOK</span>
          <button className="iconbtn" onClick={onClose} aria-label="Close settings">✕</button>
        </div>

        <div className="settings__body">
          {/* ── Model & provider ─────────────────────────────────────── */}
          <div className="settings__section">
            <span className="settings__label">Model &amp; provider</span>
            <Dropdown
              value={currentProvider}
              options={PROVIDERS.map((p) => ({ value: p.id, label: p.label }))}
              onChange={(v) => setSettings((s) => ({ ...s, model: defaultModelOf(v) }))}
              ariaLabel="Provider"
              block
            />
            <span className="settings__help">Default model: <span className="mono">{defaultModelOf(currentProvider)}</span></span>
          </div>

          <div className="settings__divider" />

          {/* ── Spending limits ──────────────────────────────────────── */}
          <div className="settings__section">
            <span className="settings__label">Spending limits</span>
            <div className="field">
              <span className="settings__sublabel">Session cap ($)</span>
              <input
                className="input"
                type="number"
                min={0}
                step="0.25"
                value={toDollars(settings.sessionCapCents)}
                onChange={(e) => setSettings((s) => ({ ...s, sessionCapCents: toCents(e.target.value) }))}
              />
              <span className="settings__help">Max spend per conversation before Ortha pauses to ask permission.</span>
            </div>
            <div className="field">
              <span className="settings__sublabel">Per-call warn ($)</span>
              <input
                className="input"
                type="number"
                min={0}
                step="0.01"
                value={toDollars(settings.perCallWarnCents)}
                onChange={(e) => setSettings((s) => ({ ...s, perCallWarnCents: toCents(e.target.value) }))}
              />
              <span className="settings__help">Ask before any single tool call priced at or above this amount.</span>
            </div>
            <div className="field">
              <span className="settings__sublabel">Monthly cap ($)</span>
              <input
                className="input"
                type="number"
                min={0}
                step="1"
                value={toDollars(settings.monthlyCapCents)}
                onChange={(e) => setSettings((s) => ({ ...s, monthlyCapCents: toCents(e.target.value) }))}
              />
              <span className="settings__help">Hard ceiling across every conversation this month. Ortha stops when reached.</span>
            </div>
          </div>

          <div className="settings__divider" />

          {/* ── Provider keys ────────────────────────────────────────── */}
          <div className="settings__section">
            <span className="settings__label">Provider keys</span>
            <span className="muted" style={{ fontSize: 12.5 }}>
              Bring your own keys — encrypted at rest, never shown again. Live mode needs an Orthogonal key + a key for your selected model's provider. No keys = safe demo mode.
            </span>
            {KEY_PROVIDERS.map((p) => {
              const set = active(p.id);
              return (
                <div className="field" key={p.id}>
                  <span className="settings__label" style={{ textTransform: "none", letterSpacing: 0, color: "var(--muted)" }}>
                    {p.label} {set && <span className="tag-ok">· set ••••{set.hint}</span>}
                  </span>
                  <div className="field__row">
                    <input className="input" type="password" placeholder={p.placeholder} value={drafts[p.id] ?? ""} onChange={(e) => setDrafts((d) => ({ ...d, [p.id]: e.target.value }))} />
                    <button className="btn-sm" disabled={busy} onClick={() => saveKey(p.id)}>Save</button>
                    {set && <button className="btn-sm" disabled={busy} onClick={() => removeKey(p.id)}>Remove</button>}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        <div className="settings__foot">
          <button className="btn-sm btn-sm--accent" disabled={busy} onClick={saveSettings}>{saved ? "Saved ✓" : "Save settings"}</button>
        </div>
      </div>
    </div>
  );
}
