// Orthogonal mark, recreated in code. A black disc split by orthogonal (perpendicular)
// cuts into a large sector + a detached quarter wedge. The same geometry powers the
// spinning loader (the disc revolves, Omnitrix-style). No image assets.

// Big ~260° sector (gaps left near the east + north axes — the orthogonal cuts).
const SECTOR = "M16 16 L26.99 16.38 A11 11 0 1 1 14.47 5.11 Z";
// Detached NE quarter wedge, nudged out along the diagonal.
const WEDGE = "M16 16 L17.53 5.11 A11 11 0 0 1 26.89 14.47 Z";

function Mark({ fill }: { fill: string }) {
  return (
    <g>
      <path d={SECTOR} fill={fill} />
      <g transform="translate(1.25 -1.25)">
        <path d={WEDGE} fill={fill} />
      </g>
    </g>
  );
}

/** The brand tile: light rounded square + black orthogonal-split disc (the real logo). */
export function Logo({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" className="logo" aria-hidden="true">
      <rect x="0.5" y="0.5" width="31" height="31" rx="8" fill="#f1f1ee" stroke="rgba(0,0,0,0.06)" />
      <Mark fill="#15151b" />
    </svg>
  );
}

export function Brand() {
  return (
    <span className="brand">
      <Logo />
      <span className="brand__word">Ortha</span>
    </span>
  );
}

/**
 * Loading spinner built from the same mark — the orthogonal-split disc rotating.
 * Accent-gradient filled so it reads on the dark console. Used for in-flight tool
 * steps and the "thinking" state.
 */
export function Spinner({ size = 16 }: { size?: number }) {
  const gradId = "ortha-spin-grad";
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" className="ortha-spin" aria-hidden="true">
      <defs>
        <linearGradient id={gradId} x1="0" y1="0" x2="32" y2="32" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#22d3ee" />
          <stop offset="0.5" stopColor="#6366f1" />
          <stop offset="1" stopColor="#d946ef" />
        </linearGradient>
      </defs>
      <Mark fill={`url(#${gradId})`} />
    </svg>
  );
}
