import { useEffect, useMemo, useState } from "react";
import { deleteSkill, getPublicSkills, listSkills, type PublicSkill, saveSkill, type Skill } from "../lib/api.ts";

/**
 * Skills — two sections:
 *  • Your skills: saved, parameterized prompt workflows (per workspace, synced).
 *    A skill is a stored template like "Enrich {email}: find name, title, …".
 *    Running one prompts for each `{var}`, fills the template, and hands the
 *    finished prompt to `onRun` (wired to chat send() by the parent).
 *  • Public skills: a read-only catalog from GET /api/skills/public. "Use" runs
 *    the skill's SKILL.md `content` (or `description` if content is huge) as a
 *    prompt so the agent executes that workflow.
 *
 * Reuses the .settings / .settings-scrim modal shell (mirrors DiscoverModal).
 */

/** Cap a public skill's content before sending it as a prompt. Matches the server's
 *  MAX_PUBLIC_SKILL_CONTENT so the full SKILL.md (longest catalog skill is ~22k) runs. */
const MAX_PUBLIC_PROMPT_CHARS = 25000;

/** Extract unique `{var}` placeholder names from a template, in first-seen order. */
export function extractVars(template: string): string[] {
  const out: string[] = [];
  const re = /\{([a-zA-Z0-9_ -]+)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(template))) {
    const name = m[1]!.trim();
    if (name && !out.includes(name)) out.push(name);
  }
  return out;
}

/** Replace every `{var}` with its provided value (missing values become ""). */
export function fillTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/\{([a-zA-Z0-9_ -]+)\}/g, (_, raw: string) => values[raw.trim()] ?? "");
}

/** Build the prompt run when a public skill is "used": the SKILL.md content, capped. */
export function publicSkillPrompt(skill: Pick<PublicSkill, "content" | "description">): string {
  const body = (skill.content || skill.description || "").trim();
  return body.length > MAX_PUBLIC_PROMPT_CHARS ? body.slice(0, MAX_PUBLIC_PROMPT_CHARS) : body;
}

interface Props {
  open: boolean;
  onClose: () => void;
  /** Run a skill: sends the prompt to the model. `displayText` is the short label shown
   *  in the chat bubble (so the long SKILL.md never floods the conversation). */
  onRun: (prompt: string, displayText?: string) => void;
  /** Fired whenever the saved-skill set changes (create / install / delete) so the
   *  host can refresh its `/` slash commands. */
  onSkillsChanged?: (skills: Skill[]) => void;
}

type Tab = "yours" | "public";
type View = { mode: "list" } | { mode: "create" };

export function SkillsModal({ open, onClose, onRun, onSkillsChanged }: Props) {
  const [tab, setTab] = useState<Tab>("yours");
  const [skills, setSkills] = useState<Skill[]>([]);
  const [publicSkills, setPublicSkills] = useState<PublicSkill[] | null>(null);
  const [view, setView] = useState<View>({ mode: "list" });
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState("");
  const [template, setTemplate] = useState("");
  const [error, setError] = useState("");
  // Tracks which public skill was just added (for the "Added ✓" flash). Declared here
  // with the other hooks — NOT after the `if (!open) return null` below — or the hook
  // count changes when the modal opens and React crashes the app to a black screen.
  const [added, setAdded] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setTab("yours");
    setView({ mode: "list" });
    setName("");
    setTemplate("");
    setError("");
    setPublicSkills(null);
    void listSkills().then(setSkills);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  // Lazily fetch the public catalog the first time the user opens that tab.
  useEffect(() => {
    if (!open || tab !== "public" || publicSkills !== null) return;
    void getPublicSkills().then(setPublicSkills);
  }, [open, tab, publicSkills]);

  if (!open) return null;

  const create = async () => {
    const n = name.trim();
    const t = template.trim();
    if (!n) return setError("Name is required.");
    if (!t) return setError("Template is required.");
    if (t.length > 2000) return setError("Template is too long (max 2000 characters).");
    setBusy(true);
    const next = await saveSkill({ name: n, template: t });
    setBusy(false);
    if (!next) return setError("Couldn't save the skill. Try again.");
    setSkills(next);
    onSkillsChanged?.(next);
    setName("");
    setTemplate("");
    setError("");
    setView({ mode: "list" });
  };

  const remove = async (id: string) => {
    if (!window.confirm("Delete this skill? This cannot be undone.")) return;
    setBusy(true);
    const next = await deleteSkill(id);
    setSkills(next);
    onSkillsChanged?.(next);
    setBusy(false);
  };

  const usePublic = (skill: PublicSkill) => {
    onRun(publicSkillPrompt(skill), `Run skill: ${skill.name}`);
    onClose();
  };

  // Add a public skill to "Your skills" so it persists and shows up as a `/`
  // command. The SKILL.md content becomes the skill's template (runs as-is).
  const installPublic = async (skill: PublicSkill) => {
    setBusy(true);
    const next = await saveSkill({ name: skill.name, template: publicSkillPrompt(skill) });
    setBusy(false);
    if (!next) return;
    setSkills(next);
    onSkillsChanged?.(next);
    setAdded(skill.id);
    setTimeout(() => setAdded((cur) => (cur === skill.id ? null : cur)), 1800);
  };

  const title = view.mode === "create" ? "New skill" : "Skills";
  // Names already in "Your skills" — so a public card can show "Added" instead of "Add".
  const installedNames = new Set(skills.map((s) => s.name));
  // Widen the modal on the public tab so its catalog lays out as a multi-column grid
  // (easier to scan/search than one-per-row).
  const wide = view.mode === "list" && tab === "public";

  return (
    <div className="settings-scrim" onClick={onClose}>
      <div className={`settings${wide ? " settings--lg" : ""}`} role="dialog" aria-modal="true" aria-label="Skills" onClick={(e) => e.stopPropagation()}>
        <div className="settings__head">
          <span className="settings__title">{title}</span>
          <button className="iconbtn" onClick={onClose} aria-label="Close Skills">✕</button>
        </div>

        {view.mode === "list" && (
          <div className="skill__tabs" role="tablist" aria-label="Skill sections">
            <button
              type="button"
              role="tab"
              aria-selected={tab === "yours"}
              className={`skill__tab${tab === "yours" ? " skill__tab--active" : ""}`}
              onClick={() => setTab("yours")}
            >
              Your skills
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === "public"}
              className={`skill__tab${tab === "public" ? " skill__tab--active" : ""}`}
              onClick={() => setTab("public")}
            >
              Public skills
            </button>
          </div>
        )}

        <div className="settings__body">
          {view.mode === "list" && tab === "yours" && (
            <SkillList
              skills={skills}
              busy={busy}
              onNew={() => {
                setError("");
                setView({ mode: "create" });
              }}
              onRun={(s) => { onRun(s.template, `Run skill: ${s.name}`); onClose(); }}
              onDelete={remove}
            />
          )}

          {view.mode === "list" && tab === "public" && (
            <PublicSkillList skills={publicSkills} onUse={usePublic} onInstall={installPublic} addedId={added} busy={busy} installedNames={installedNames} />
          )}

          {view.mode === "create" && (
            <div className="settings__section">
              <div className="field">
                <span className="settings__sublabel">Name</span>
                <input
                  className="input"
                  placeholder="Lead enrich"
                  value={name}
                  autoFocus
                  onChange={(e) => setName(e.target.value)}
                />
              </div>
              <div className="field">
                <span className="settings__sublabel">Template</span>
                <textarea
                  className="input skill__template"
                  placeholder="Enrich {email}: find name, title, company, and recent news."
                  value={template}
                  rows={5}
                  maxLength={2000}
                  onChange={(e) => setTemplate(e.target.value)}
                />
                <span className="settings__help">
                  A saved prompt you can run anytime — from here or as a <span className="mono">/command</span>. Ortha runs it and asks for any details it needs.
                </span>
              </div>
              {error && <span className="skill__error">{error}</span>}
              <div className="skill__formfoot">
                <button className="btn-sm" disabled={busy} onClick={() => setView({ mode: "list" })}>Cancel</button>
                <button className="btn-sm btn-sm--accent" disabled={busy} onClick={() => void create()}>
                  {busy ? "Saving…" : "Save skill"}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function SkillList({
  skills,
  busy,
  onNew,
  onRun,
  onDelete,
}: {
  skills: Skill[];
  busy: boolean;
  onNew: () => void;
  onRun: (s: Skill) => void;
  onDelete: (id: string) => void;
}) {
  return (
    <div className="settings__section">
      <div className="skill__listhead">
        <span className="settings__help">Saved prompt workflows. Run one to fill in its fields and send it as a message.</span>
        <button className="btn-sm btn-sm--accent" onClick={onNew}>+ New skill</button>
      </div>
      {skills.length === 0 ? (
        <div className="skill__empty">No skills yet. Create one to save a reusable prompt.</div>
      ) : (
        <div className="skill__list">
          {skills.map((s) => (
            <article className="skillcard" key={s.id}>
              <div className="skillcard__main">
                <span className="skillcard__name">{s.name}</span>
                <p className="skillcard__template">{s.template}</p>
              </div>
              <div className="skillcard__actions">
                <button className="btn-sm btn-sm--accent" onClick={() => onRun(s)}>Run</button>
                <button className="btn-sm" disabled={busy} onClick={() => onDelete(s.id)} aria-label={`Delete ${s.name}`}>
                  Delete
                </button>
              </div>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}

function PublicSkillList({
  skills,
  onUse,
  onInstall,
  addedId,
  busy,
  installedNames,
}: {
  skills: PublicSkill[] | null;
  onUse: (s: PublicSkill) => void;
  onInstall: (s: PublicSkill) => void;
  addedId: string | null;
  busy: boolean;
  installedNames: Set<string>;
}) {
  const [query, setQuery] = useState("");

  const { featured, rest } = useMemo(() => {
    const all = skills ?? [];
    const featured = all.filter((s) => s.highlighted);
    const q = query.trim().toLowerCase();
    const rest = all.filter((s) => {
      if (!q) return true;
      return s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q);
    });
    return { featured, rest };
  }, [skills, query]);

  if (skills === null) {
    return <div className="settings__section"><div className="skill__empty">Loading public skills…</div></div>;
  }
  if (skills.length === 0) {
    return (
      <div className="settings__section">
        <div className="skill__empty">No public skills available yet. Check back soon.</div>
      </div>
    );
  }

  return (
    <div className="settings__section">
      <input
        className="input"
        type="search"
        placeholder="Search public skills by name or description…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        aria-label="Search public skills"
      />
      {featured.length > 0 && !query.trim() && (
        <section className="skill__pubgroup">
          <span className="settings__label">Featured</span>
          <div className="skill__pubgrid">
            {featured.map((s) => (
              <PublicSkillCard key={s.id} skill={s} onUse={onUse} onInstall={onInstall} added={addedId === s.id} busy={busy} installed={installedNames.has(s.name)} />
            ))}
          </div>
        </section>
      )}
      <section className="skill__pubgroup">
        <span className="settings__label">All</span>
        {rest.length === 0 ? (
          <div className="skill__empty">No public skills match your search.</div>
        ) : (
          <div className="skill__pubgrid">
            {rest.map((s) => (
              <PublicSkillCard key={s.id} skill={s} onUse={onUse} onInstall={onInstall} added={addedId === s.id} busy={busy} installed={installedNames.has(s.name)} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function PublicSkillCard({
  skill,
  onUse,
  onInstall,
  added,
  busy,
  installed,
}: {
  skill: PublicSkill;
  onUse: (s: PublicSkill) => void;
  onInstall: (s: PublicSkill) => void;
  added: boolean;
  busy: boolean;
  installed: boolean;
}) {
  const isAdded = added || installed; // already in "Your skills" (or just added)
  return (
    <article className="skillcard skillcard--pub">
      <div className="skillcard__main">
        <span className="skillcard__name">
          {skill.name}
          {skill.verified && (
            <span className="apicard__verified" title="Verified" aria-label="Verified">✓</span>
          )}
        </span>
        <p className="skillcard__template">{skill.description}</p>
        <div className="skill__pubmeta">
          <span className="skill__installs" title="Installs">
            {skill.installCount.toLocaleString()} {skill.installCount === 1 ? "install" : "installs"}
          </span>
          {skill.tags.slice(0, 2).map((t) => (
            <span key={t} className="skill__tag">{t}</span>
          ))}
        </div>
      </div>
      <div className="skillcard__actions">
        <button className="btn-sm btn-sm--accent" onClick={() => onUse(skill)}>Use</button>
        {isAdded ? (
          <button className="btn-sm" disabled title="Already in Your skills">✓ Added</button>
        ) : (
          <button className="btn-sm" disabled={busy} onClick={() => onInstall(skill)} title="Add to Your skills (then run it with /)">
            Add
          </button>
        )}
      </div>
    </article>
  );
}

// (Skills run directly now — no per-field form. `extractVars`/`fillTemplate` remain
// exported for callers/tests that still compose templates.)
