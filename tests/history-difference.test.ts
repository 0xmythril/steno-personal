import { expect, it } from 'vitest'
import { splitDifference } from '@/app/history/difference'
it('renders changed emoji as whole characters instead of splitting surrogate pairs across elements', () => {
  const parts = splitDifference('Meet 😀 at 3 pm', 'Meet 😃 at 3 pm')
  expect(parts).toEqual({ before: 'Meet ', changed: '😀', after: ' at 3 pm' })
  expect(Object.values(parts).every(s => s.isWellFormed())).toBe(true)
})
it('preserves multilingual text, removals and identical versions', () => {
  for (const [text, other] of [['週五見 👋', '週四見 👋'], ['', 'removed'], ['same', 'same']]) {
    const p = splitDifference(text, other)
    expect(p.before + p.changed + p.after).toBe(text)
  }
})
