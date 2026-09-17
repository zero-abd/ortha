// Ortha monogram: a neutral "O" ring on a rounded tile. The spinner reuses the
// ring as a rotating three-quarter arc.

/** Brand tile: light rounded square + an ink "O" ring. */
export function Logo({ size = 24 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" className="logo" aria-hidden="true">
      <rect x="0.5" y="0.5" width="31" height="31" rx="8" fill="#efeeec" stroke="rgba(0,0,0,0.06)" />
      <circle cx="16" cy="16" r="8" fill="none" stroke="#18181b" strokeWidth="3.5" />
    </svg>
  );
}

/** Loading spinner: the monogram ring as an accent-colored rotating arc. */
export function Spinner({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" className="ortha-spin" aria-hidden="true" style={{ color: "var(--accent)" }}>
      <circle cx="16" cy="16" r="10" fill="none" stroke="currentColor" strokeOpacity="0.2" strokeWidth="4" />
      <path d="M16 6 A10 10 0 0 1 26 16" fill="none" stroke="currentColor" strokeWidth="4" strokeLinecap="round" />
    </svg>
  );
}
