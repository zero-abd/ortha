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
  /** Called with the filled prompt when a skill is run. Parent wires this to send(). */
  onRun: (prompt: string) => void;
  /** Fired whenever the saved-skill set changes (create / install / delete) so the
   *  host can refresh its `/` slash commands. */
  onSkillsChanged?: (skills: Skill[]) => void;
  /** When set on open, jump straight to this skill's run form (used by `/skill`
   *  commands whose template has fields to fill). */
  initialRunSkill?: Skill | null;
}

type Tab = "yours" | "public";
type View = { mode: "list" } | { mode: "create" } | { mode: "run"; skill: Skill };

export function SkillsModal({ open, onClose, onRun, onSkillsChanged, initialRunSkill }: Props) {
  const [tab, setTab] = useState<Tab>("yours");
  const [skills, setSkills] = useState<Skill[]>([]);
  const [publicSkills, setPublicSkills] = useState<PublicSkill[] | null>(null);
  const [view, setView] = useState<View>({ mode: "list" });
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState("");
  const [template, setTemplate] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open) return;
    setTab("yours");
    // Honor a requested run target (from a `/skill` command), else the list.
    setView(initialRunSkill ? { mode: "run", skill: initialRunSkill } : { mode: "list" });
    setName("");
    setTemplate("");
    setError("");
    setPublicSkills(null);
    void listSkills().then(setSkills);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose, initialRunSkill]);

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
    onRun(publicSkillPrompt(skill));
    onClose();
  };

  // Add a public skill to "Your skills" so it persists and shows up as a `/`
  // command. The SKILL.md content becomes the skill's template (runs as-is).
  const [added, setAdded] = useState<string | null>(null);
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

  const title =
    view.mode === "create" ? "New skill" : view.mode === "run" ? `Run · ${view.skill.name}` : "Skills";

  return (
    <div className="settings-scrim" onClick={onClose}>
      <div className="settings" role="dialog" aria-modal="true" aria-label="Skills" onClick={(e) => e.stopPropagation()}>
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
              onRun={(s) => setView({ mode: "run", skill: s })}
              onDelete={remove}
            />
          )}

          {view.mode === "list" && tab === "public" && (
            <PublicSkillList skills={publicSkills} onUse={usePublic} onInstall={installPublic} addedId={added} busy={busy} />
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
                  Wrap a word in braces — like <span className="mono">{"{email}"}</span> — to turn it into a field you fill in when you run the skill.
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

          {view.mode === "run" && (
            <RunSkill
              skill={view.skill}
              onCancel={() => setView({ mode: "list" })}
              onRun={(prompt) => {
                onRun(prompt);
                onClose();
              }}
            />
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
}: {
  skills: PublicSkill[] | null;
  onUse: (s: PublicSkill) => void;
  onInstall: (s: PublicSkill) => void;
  addedId: string | null;
  busy: boolean;
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
          <div className="skill__list">
            {featured.map((s) => (
              <PublicSkillCard key={s.id} skill={s} onUse={onUse} onInstall={onInstall} added={addedId === s.id} busy={busy} />
            ))}
          </div>
        </section>
      )}
      <section className="skill__pubgroup">
        <span className="settings__label">All</span>
        {rest.length === 0 ? (
          <div className="skill__empty">No public skills match your search.</div>
        ) : (
          <div className="skill__list">
            {rest.map((s) => (
              <PublicSkillCard key={s.id} skill={s} onUse={onUse} onInstall={onInstall} added={addedId === s.id} busy={busy} />
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
}: {
  skill: PublicSkill;
  onUse: (s: PublicSkill) => void;
  onInstall: (s: PublicSkill) => void;
  added: boolean;
  busy: boolean;
}) {
  return (
    <article className="skillcard">
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
          {skill.tags.slice(0, 3).map((t) => (
            <span key={t} className="skill__tag">{t}</span>
          ))}
        </div>
      </div>
      <div className="skillcard__actions">
        <button className="btn-sm btn-sm--accent" onClick={() => onUse(skill)}>Use</button>
        <button
          className="btn-sm"
          disabled={busy || added}
          onClick={() => onInstall(skill)}
          title="Add to Your skills (then run it with /)"
        >
          {added ? "Added ✓" : "Add to my skills"}
        </button>
      </div>
    </article>
  );
}

function RunSkill({ skill, onCancel, onRun }: { skill: Skill; onCancel: () => void; onRun: (prompt: string) => void }) {
  const vars = useMemo(() => extractVars(skill.template), [skill.template]);
  const [values, setValues] = useState<Record<string, string>>({});

  const filled = fillTemplate(skill.template, values);
  const ready = vars.every((v) => (values[v] ?? "").trim().length > 0);

  return (
    <div className="settings__section">
      {vars.length === 0 ? (
        <span className="settings__help">This skill has no fields — it runs exactly as written.</span>
      ) : (
        vars.map((v, i) => (
          <div className="field" key={v}>
            <span className="settings__sublabel">{v}</span>
            <input
              className="input"
              placeholder={`Value for ${v}`}
              value={values[v] ?? ""}
              autoFocus={i === 0}
              onChange={(e) => setValues((prev) => ({ ...prev, [v]: e.target.value }))}
            />
          </div>
        ))
      )}
      <div className="field">
        <span className="settings__sublabel">Preview</span>
        <div className="skill__preview">{filled}</div>
      </div>
      <div className="skill__formfoot">
        <button className="btn-sm" onClick={onCancel}>Back</button>
        <button className="btn-sm btn-sm--accent" disabled={!ready} onClick={() => onRun(filled)}>Run skill</button>
      </div>
    </div>
  );
}
