import type { RawArtifact } from "../types.ts";

interface Props {
  artifact: RawArtifact | null;
  onClose: () => void;
}

/** On-demand right panel for an expanded raw tool result (the expand_result handle). */
export function RightPanel({ artifact, onClose }: Props) {
  if (!artifact) return null;
  const loading = typeof artifact.data === "object" && artifact.data !== null && (artifact.data as { loading?: boolean }).loading === true;
  return (
    <aside className="panel" aria-label="Raw tool result">
      <div className="panel__head">
        <span className="panel__title mono">{artifact.title}</span>
        <button className="iconbtn" onClick={onClose} aria-label="Close panel">
          ✕
        </button>
      </div>
      <div className="panel__body">
        {loading ? <div className="panel__loading mono">Loading raw payload…</div> : <pre className="panel__raw mono">{JSON.stringify(artifact.data, null, 2)}</pre>}
      </div>
    </aside>
  );
}
