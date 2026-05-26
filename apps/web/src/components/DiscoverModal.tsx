import { useEffect, useMemo, useState } from "react";
import { CATALOG_CATEGORIES, COMMUNITY_APIS, VERIFIED_APIS, type CatalogApi } from "../lib/apiCatalog.ts";

/**
 * Discover APIs browser. Large modal (reuses the .settings / .settings-scrim
 * pattern) listing the curated Orthogonal API catalog. Filters by free-text
 * search (name + description, case-insensitive) and by a single primary
 * category chip. Closes on Escape, scrim click, or the X button.
 */
export function DiscoverModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<string>("All");

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  // Reset filters each time the modal opens so it always starts clean.
  useEffect(() => {
    if (open) {
      setQuery("");
      setCategory("All");
    }
  }, [open]);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    const test = (a: CatalogApi): boolean => {
      if (category !== "All" && a.category !== category) return false;
      if (!q) return true;
      return a.name.toLowerCase().includes(q) || a.description.toLowerCase().includes(q);
    };
    return {
      verified: VERIFIED_APIS.filter(test),
      community: COMMUNITY_APIS.filter(test),
    };
  }, [query, category]);

  if (!open) return null;

  const total = matches.verified.length + matches.community.length;

  return (
    <div className="settings-scrim" onClick={onClose}>
      <div className="settings settings--lg" role="dialog" aria-modal="true" aria-label="Discover APIs" onClick={(e) => e.stopPropagation()}>
        <div className="settings__head">
          <span className="settings__title">Discover APIs</span>
          <button className="iconbtn" onClick={onClose} aria-label="Close Discover APIs">✕</button>
        </div>

        <div className="discover__controls">
          <input
            className="input"
            type="search"
            placeholder="Search APIs by name or description…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Search APIs"
            autoFocus
          />
          <div className="discover__chips" role="group" aria-label="Filter by category">
            {CATALOG_CATEGORIES.map((c) => (
              <button
                key={c}
                type="button"
                className={`discover__chip${category === c ? " discover__chip--active" : ""}`}
                aria-pressed={category === c}
                onClick={() => setCategory(c)}
              >
                {c}
              </button>
            ))}
          </div>
        </div>

        <div className="settings__body discover__body">
          {total === 0 ? (
            <div className="discover__empty">No APIs match your search.</div>
          ) : (
            <>
              <ApiGroup title="Verified APIs" apis={matches.verified} />
              <ApiGroup title="Community APIs" apis={matches.community} />
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function ApiGroup({ title, apis }: { title: string; apis: CatalogApi[] }) {
  if (apis.length === 0) return null;
  return (
    <section className="discover__section">
      <div className="discover__section-head">
        <span className="settings__label">{title}</span>
        <span className="discover__count">{apis.length}</span>
      </div>
      <div className="discover__grid">
        {apis.map((a) => (
          <ApiCard key={a.name} api={a} />
        ))}
      </div>
    </section>
  );
}

function ApiCard({ api }: { api: CatalogApi }) {
  return (
    <article className="apicard">
      <div className="apicard__top">
        <span className="apicard__name">
          {api.name}
          {api.tier === "verified" && (
            <span className="apicard__verified" title="Verified" aria-label="Verified">✓</span>
          )}
        </span>
        <span className="apicard__count">{api.endpoints} {api.endpoints === 1 ? "endpoint" : "endpoints"}</span>
      </div>
      <p className="apicard__desc">{api.description}</p>
    </article>
  );
}
