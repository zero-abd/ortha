import { extractSources } from "../lib/sources.ts";
import type { TraceStep } from "../types.ts";

interface Props {
  /** The assistant message's tool trace. */
  steps: TraceStep[];
}

/** Google's favicon service — small, cached, no key. */
function faviconUrl(domain: string): string {
  return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=32`;
}

/**
 * A compact "Sources" strip under an assistant message: one clickable chip per
 * unique web page the agent read, each linking out in a new tab. Renders nothing
 * when the turn used no web pages.
 */
export function Sources({ steps }: Props) {
  const sources = extractSources(steps);
  if (sources.length === 0) return null;

  return (
    <div className="sources">
      <div className="sources__label">Sources</div>
      <ul className="sources__list">
        {sources.map((s) => (
          <li key={s.url}>
            <a className="sources__chip" href={s.url} target="_blank" rel="noopener noreferrer" title={s.url}>
              <img className="sources__favicon" src={faviconUrl(s.domain)} alt="" width={14} height={14} loading="lazy" />
              <span className="sources__domain">{s.domain}</span>
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}
