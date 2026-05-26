import { useEffect, useState } from "react";
import { deleteKey, getSettings, listKeys, putKey, putSettings, type ApiSettings, type KeyMeta } from "../lib/api.ts";

const PROVIDERS = [
  { id: "orthogonal", label: "Orthogonal API key", placeholder: "orth_live_…" },
  { id: "gemini", label: "Google Gemini key", placeholder: "AIza… (free tier)" },
  { id: "openrouter", label: "OpenRouter key", placeholder: "sk-or-… (free models)" },
  { id: "openai", label: "OpenAI key", placeholder: "sk-…" },
  { id: "anthropic", label: "Anthropic key", placeholder: "sk-ant-…" },
] as const;

const MODELS = [
  { id: "gemini-2.0-flash", label: "Gemini 2.0 Flash (free)" },
  { id: "gemini-1.5-flash", label: "Gemini 1.5 Flash (free)" },
  { id: "meta-llama/llama-3.3-70b-instruct:free", label: "Llama 3.3 70B via OpenRouter (free)" },
  { id: "gpt-4o-mini", label: "GPT-4o mini" },
  { id: "gpt-4o", label: "GPT-4o" },
  { id: "claude-3-5-haiku-latest", label: "Claude 3.5 Haiku" },
  { id: "claude-3-5-sonnet-latest", label: "Claude 3.5 Sonnet" },
];

const DEFAULTS: ApiSettings = {
  sessionCapCents: 500,
  perCallWarnCents: 25,
  monthlyCapCents: 10_000,
  model: "gemini-2.0-flash",
  theme: "system",
  cacheTtlSeconds: 300,
};

export function SettingsModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [keys, setKeys] = useState<KeyMeta[]>([]);
  const [settings, setSettings] = useState<ApiSettings>(DEFAULTS);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    void (async () => {
      setKeys(await listKeys());
      setSettings((await getSettings()) ?? DEFAULTS);
    })();
  }, [open]);

  if (!open) return null;

  const active = (provider: string) => keys.find((k) => k.provider === provider && k.status === "active");

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
  };

  return (
    <div className="modal-scrim" onClick={onClose}>
      <div className="modal" role="dialog" aria-modal="true" aria-label="Settings" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 520, width: "92%" }}>
        <div className="panel__head">
          <span className="panel__title">Settings · BYOK</span>
          <button className="iconbtn" onClick={onClose} aria-label="Close">✕</button>
        </div>

        <div className="modal__detail" style={{ display: "grid", gap: "var(--s-4)" }}>
          <div>
            <label className="msg__role">Model</label>
            <select className="select" value={settings.model} onChange={(e) => setSettings((s) => ({ ...s, model: e.target.value }))} style={{ width: "100%" }}>
              {MODELS.map((m) => (
                <option key={m.id} value={m.id}>{m.label}</option>
              ))}
            </select>
          </div>

          <div style={{ display: "flex", gap: "var(--s-3)" }}>
            <div style={{ flex: 1 }}>
              <label className="msg__role">Session cap ($)</label>
              <input className="composer__input" type="number" min={0} step="0.25" value={(settings.sessionCapCents / 100).toString()} onChange={(e) => setSettings((s) => ({ ...s, sessionCapCents: Math.round(Number(e.target.value) * 100) }))} />
            </div>
            <div style={{ flex: 1 }}>
              <label className="msg__role">Monthly cap ($)</label>
              <input className="composer__input" type="number" min={0} step="1" value={(settings.monthlyCapCents / 100).toString()} onChange={(e) => setSettings((s) => ({ ...s, monthlyCapCents: Math.round(Number(e.target.value) * 100) }))} />
            </div>
          </div>
          <button className="btn-sm btn-sm--accent" disabled={busy} onClick={saveSettings}>Save model + caps</button>

          <div className="trace__sep" />
          <div className="muted">Bring your own keys — encrypted at rest, never shown again. Live mode needs an Orthogonal key + a key for your selected model's provider. No keys = safe demo mode.</div>

          {PROVIDERS.map((p) => {
            const set = active(p.id);
            return (
              <div key={p.id} style={{ display: "grid", gap: "var(--s-1)" }}>
                <label className="msg__role">{p.label} {set && <span className="muted">· set ••••{set.hint}</span>}</label>
                <div style={{ display: "flex", gap: "var(--s-2)" }}>
                  <input className="composer__input" type="password" placeholder={p.placeholder} value={drafts[p.id] ?? ""} onChange={(e) => setDrafts((d) => ({ ...d, [p.id]: e.target.value }))} style={{ flex: 1 }} />
                  <button className="btn-sm" disabled={busy} onClick={() => saveKey(p.id)}>Save</button>
                  {set && <button className="btn-sm" disabled={busy} onClick={() => removeKey(p.id)}>Remove</button>}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
