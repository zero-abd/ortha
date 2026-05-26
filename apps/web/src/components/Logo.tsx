// Orthogonal mark: two opposite pie slices (top-right + bottom-left quarter
// wedges), the other two quarters empty. The same geometry powers the spinner.
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

/** Brand tile: light rounded square + the black orthogonal two-slice mark. */
export function Logo({ size = 24 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" className="logo" aria-hidden="true">
      <rect x="0.5" y="0.5" width="31" height="31" rx="8" fill="#efeeec" stroke="rgba(0,0,0,0.06)" />
      <Mark fill="#18181b" />
    </svg>
  );
}

/** Loading spinner: the same two-slice mark, accent-colored, rotating. */
export function Spinner({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" className="ortha-spin" aria-hidden="true" style={{ color: "var(--accent)" }}>
      <Mark fill="currentColor" />
    </svg>
  );
}
