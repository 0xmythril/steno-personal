// The icon set. Three glyphs, no more: passkey (app/passkey-icon.tsx) and the
// two below. Each is `currentColor` so it renders on any surface in both
// palettes, each `aria-hidden` because the control around it carries the
// accessible name, and each drawn for the one size it is actually used at
// rather than scaled down from a generic set. Adding a fourth glyph here is
// a design decision — the same weight as adding a colour token — not a
// convenience for the next button that would rather show a picture than a
// word.
export function PencilIcon({ size = 16 }: { size?: number }) {
  return (
    <svg
      width={size} height={size} viewBox="0 0 24 24" aria-hidden focusable="false"
      fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
    >
      <path d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" />
    </svg>
  )
}

// Drawn at 14px, beside the conflict count in a transcript's provenance
// line. The triangle is redundant with, not a substitute for, the marker's
// --warn text and its full-sentence aria-label — colour and shape and text
// all say the same thing, so no one of them is load-bearing alone.
export function AlertIcon({ size = 14 }: { size?: number }) {
  return (
    <svg
      width={size} height={size} viewBox="0 0 24 24" aria-hidden focusable="false"
      fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
    >
      <path d="M12 3.5 2 20.5h20L12 3.5z" />
      <path d="M12 10v4" />
      <path d="M12 17h.01" />
    </svg>
  )
}
