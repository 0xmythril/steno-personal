// The passkey glyph: a person and a key, the shape every platform now uses for
// this, so the button is recognised before it is read. DESIGN.md's icon gap is
// deliberate — text labels everywhere else — and this is the one exception,
// because a passkey is a thing people learn to look for rather than to read.
//
// Strokes follow currentColor, as the mark does, so it renders on the primary
// button in both palettes. Drawn for 18px; do not add detail. A second tooth on
// the key closes up below 20px.
export function PasskeyIcon({ size = 18 }: { size?: number }) {
  return (
    <svg
      width={size} height={size} viewBox="0 0 24 24" aria-hidden focusable="false"
      fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
    >
      <circle cx="7.4" cy="6.8" r="3.9" />
      <path d="M1.6 20.8c0-4 2.7-6.2 5.8-6.2 1.2 0 2.3.3 3.2.9" />
      <circle cx="18" cy="10.2" r="3.3" />
      <path d="M18 13.5v7.7" />
      <path d="M18 17.6h3.1" />
    </svg>
  )
}
