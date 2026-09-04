// The one line of text a reader wants from content that is not text, shared
// by both channel parsers so a WhatsApp pin and a Telegram pin read the same
// in a transcript, a snippet and the search index. No channel library is
// imported here (CONTRIBUTING.md ground rule 2).

export const nonEmpty = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null)

// A place reads as its name, else its address, else its coordinates to five
// decimals (about a metre): a pin with no label is still a pin.
export function locationLabel(node: { name?: unknown; address?: unknown; lat?: unknown; lng?: unknown }): string | null {
  const label = nonEmpty(node.name) ?? nonEmpty(node.address)
  if (label) return label
  const lat = Number(node.lat)
  const lng = Number(node.lng)
  return Number.isFinite(lat) && Number.isFinite(lng) && node.lat != null && node.lng != null
    ? `${lat.toFixed(5)}, ${lng.toFixed(5)}`
    : null
}
