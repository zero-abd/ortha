// Orthogonal mark, recreated in code. A black disc split by orthogonal (perpendicular)
// cuts into a large sector + a detached quarter wedge. The same geometry powers the
// spinning loader (the disc revolves, Omnitrix-style). No image assets.

// Two opposite pie slices (top-right + bottom-left quarter wedges); the other two
// quarters are empty. Apexes meet at center — the Orthogonal mark.
const WEDGE_NE = "M16 16 L16 6 A10 10 0 0 1 26 16 Z";
const WEDGE_SW = "M16 16 L16 26 A10 10 0 0 1 6 16 Z";

function Mark({ fill }: { fill: string }) {
  return (
    <g fill={fill}>
      <path d={WEDGE_NE} />
      <path d={WEDGE_SW} />
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
