import { useEffect, useMemo, useState } from "react";
import { deleteSkill, listSkills, saveSkill, type Skill } from "../lib/api.ts";

/**
 * Skills — saved, parameterized prompt workflows (per workspace, synced).
 * A skill is a stored template like "Enrich {email}: find name, title, company."
 * Running a skill prompts for each `{var}`, fills the template, and hands the
 * finished prompt to `onRun`, which the parent wires to the normal chat `send()`.
 *
 * Reuses the .settings / .settings-scrim modal shell (mirrors DiscoverModal).
 */

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

interface Props {
  open: boolean;
  onClose: () => void;
  /** Called with the filled prompt when a skill is run. Parent wires this to send(). */
  onRun: (prompt: string) => void;
}

type View = { mode: "list" } | { mode: "create" } | { mode: "run"; skill: Skill };

export function SkillsModal({ open, onClose, onRun }: Props) {
  const [skills, setSkills] = useState<Skill[]>([]);
  const [view, setView] = useState<View>({ mode: "list" });
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState("");
  const [template, setTemplate] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open) return;
    setView({ mode: "list" });
    setName("");
    setTemplate("");
    setError("");
    void listSkills().then(setSkills);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

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
    setName("");
    setTemplate("");
    setError("");
    setView({ mode: "list" });
  };

  const remove = async (id: string) => {
    if (!window.confirm("Delete this skill? This cannot be undone.")) return;
    setBusy(true);
    setSkills(await deleteSkill(id));
    setBusy(false);
  };

  return (
    <div className="settings-scrim" onClick={onClose}>
      <div className="settings" role="dialog" aria-modal="true" aria-label="Skills" onClick={(e) => e.stopPropagation()}>
        <div className="settings__head">
          <span className="settings__title">
            {view.mode === "create" ? "New skill" : view.mode === "run" ? `Run · ${view.skill.name}` : "Skills"}
          </span>
          <button className="iconbtn" onClick={onClose} aria-label="Close Skills">✕</button>
        </div>

        <div className="settings__body">
          {view.mode === "list" && (
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
