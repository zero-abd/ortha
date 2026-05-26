// Orthogonal mark, recreated in code. A black disc split by orthogonal (perpendicular)
// cuts into a large sector + a detached quarter wedge. The same geometry powers the
// spinning loader (the disc revolves, Omnitrix-style). No image assets.

// Clean 270° disc with the top-right (NE) quadrant removed — the pac-man body.
const SECTOR = "M16 16 L26 16 A10 10 0 1 1 16 6 Z";
// The removed NE quarter (90°) as a separate wedge, apex at center.
const WEDGE = "M16 16 L16 6 A10 10 0 0 1 26 16 Z";

function Mark({ fill }: { fill: string }) {
  return (
    <g>
      <path d={SECTOR} fill={fill} />
      {/* the quarter pulled out, up and to the right (thin clean gap) */}
      <g transform="translate(1.6 -1.6)">
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
