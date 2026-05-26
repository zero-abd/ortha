// Code-only brand mark. "Orthogonal" = perpendicular axes, so the glyph is a ring
// crossed by orthogonal axes on a gradient tile. No image assets.
export function Logo({ size = 26 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" aria-hidden="true" className="logo">
      <defs>
        <linearGradient id="ortha-grad" x1="0" y1="0" x2="32" y2="32" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#22D3EE" />
          <stop offset="0.45" stopColor="#6366F1" />
          <stop offset="1" stopColor="#D946EF" />
        </linearGradient>
      </defs>
      <rect x="0.5" y="0.5" width="31" height="31" rx="8.5" fill="url(#ortha-grad)" />
      <g stroke="#fff" strokeWidth="2.1" strokeLinecap="round" opacity="0.96">
        <circle cx="16" cy="16" r="6.4" fill="none" />
        <line x1="16" y1="4.6" x2="16" y2="27.4" />
        <line x1="4.6" y1="16" x2="27.4" y2="16" />
      </g>
    </svg>
  );
}

/** The mark + gradient wordmark, for the top bar. */
export function Brand() {
  return (
    <span className="brand">
      <Logo />
      <span className="brand__word">Ortha</span>
    </span>
  );
}
