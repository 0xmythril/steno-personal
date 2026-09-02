import { describe, it, expect } from 'vitest'
import { processesToStart, isOn } from '../scripts/start.mjs'

describe('supervisor', () => {
  it('runs both by default', () => {
    expect(processesToStart(isOn(undefined), isOn(undefined)).map(p => p[0])).toEqual(['web', 'worker'])
  })
  it('honours the literal false only', () => {
    expect(isOn('false')).toBe(false)
    expect(isOn(' FALSE ')).toBe(false)
    expect(isOn('')).toBe(true)
    expect(isOn('0')).toBe(true)
    expect(processesToStart(true, false).map(p => p[0])).toEqual(['web'])
  })
})
