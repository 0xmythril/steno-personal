// Product mark, shared with the hosted Steno: a chat bubble with a pencil
// across it — "everything that was said, written down". Same geometry as
// the hosted Steno's mark so the two editions read as one family.
//
// Colours are the `mint` and `pencil` tokens from DESIGN.md, and the pencil
// outline follows `currentColor`, so the mark reads on paper and on dark.
//
// Mirrored in app/icon.svg and app/apple-icon.png with the palette inverted
// (dark glyph on a green tile) so a steno-personal tab is distinguishable
// from a hosted Steno tab (light glyph on a dark tile) when both are open.
export function BrandLogo({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 26 26" aria-hidden focusable="false">
      <path
        d="M11 2C6 2 2 5.8 2 10.4c0 2.1.8 4 2.2 5.4L3.2 19l4-1.3c1.2.4 2.5.7 3.8.7 5 0 9-3.8 9-8.4S16 2 11 2z"
        fill="var(--mint)"
      />
      <path
        d="M23.4 12.2 14 21.6l-3.6.9.9-3.6 9.4-9.4z"
        fill="var(--pencil)"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      {/* The ferrule. Without it the pencil reads as a plain arrow. */}
      <path d="m18.6 11.2 3.2 3.2" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  )
}

// The wordmark beside the mark, with the product label DESIGN.md specifies as
// the one visible difference between this edition and Steno Team.
export function Wordmark({ tag = true }: { tag?: boolean }) {
  return (
    <>
      <span className="word">Steno</span>
      {tag && <span className="tag">Personal</span>}
    </>
  )
}
