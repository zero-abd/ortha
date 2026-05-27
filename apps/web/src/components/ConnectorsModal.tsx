import { useEffect, useState } from "react";
import { type Connector, getConnectors } from "../lib/api.ts";

/**
 * Connectors — third-party integrations (Gmail, …) the agent can act through.
 * Scaffold: lists connectors from `GET /api/connectors`. Connectors marked
 * `coming_soon` render a disabled "Coming soon" button; `available` ones get a
 * live Connect button (wiring lands with the backend).
 *
 * Reuses the .settings / .settings-scrim modal shell (mirrors SkillsModal).
 */
export function ConnectorsModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [connectors, setConnectors] = useState<Connector[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    void getConnectors().then((c) => {
      setConnectors(c);
      setLoading(false);
    });
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="settings-scrim" onClick={onClose}>
      <div className="settings" role="dialog" aria-modal="true" aria-label="Connectors" onClick={(e) => e.stopPropagation()}>
        <div className="settings__head">
          <span className="settings__title">Connectors</span>
          <button className="iconbtn" onClick={onClose} aria-label="Close Connectors">✕</button>
        </div>

        <div className="settings__body">
          <div className="settings__section">
            <span className="settings__help">
              Connect the tools Ortha can act through. Once connected, the agent can read and send on your behalf within your limits.
            </span>
            {loading ? (
              <div className="skill__empty">Loading connectors…</div>
            ) : connectors.length === 0 ? (
              <div className="skill__empty">No connectors available yet. Check back soon.</div>
            ) : (
              <div className="skill__list">
                {connectors.map((c) => (
                  <article className="skillcard" key={c.id}>
                    <div className="skillcard__main">
                      <span className="skillcard__name">{c.name}</span>
                      <p className="skillcard__template">{c.description}</p>
                    </div>
                    <div className="skillcard__actions">
                      {c.status === "coming_soon" ? (
                        <button className="btn-sm" disabled aria-label={`${c.name} coming soon`}>Coming soon</button>
                      ) : (
                        <button className="btn-sm btn-sm--accent">Connect</button>
                      )}
                    </div>
                  </article>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
