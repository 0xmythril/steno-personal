import { describe, it, expect } from 'vitest'
import { processesToStart, isOn, resolvePort } from '../scripts/start.mjs'

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
  it('treats an empty or blank PORT as unset', () => {
    expect(resolvePort(undefined)).toBe('3000')
    expect(resolvePort('')).toBe('3000')
    expect(resolvePort('   ')).toBe('3000')
    expect(resolvePort(' 8080 ')).toBe('8080')
    expect(processesToStart(true, false, resolvePort(''))[0][2]).toEqual(
      ['node_modules/next/dist/bin/next', 'start', '-p', '3000'],
    )
  })
})
