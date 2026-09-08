// Split by Unicode code points, never between the UTF-16 halves of an emoji.
// Each piece is independently rendered as text, so every piece must be valid.
export function splitDifference(text: string, other: string) {
  const value = Array.from(text), base = Array.from(other)
  let start = 0, end = 0
  while (start < Math.min(value.length, base.length) && value[start] === base[start]) start++
  while (end < Math.min(value.length, base.length) - start && value[value.length - end - 1] === base[base.length - end - 1]) end++
  return {
    before: value.slice(0, start).join(''),
    changed: value.slice(start, value.length - end).join(''),
    after: end ? value.slice(-end).join('') : '',
  }
}
