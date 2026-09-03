import { describe, it, expect, vi } from 'vitest'
import { buildPorts } from '@/lib/channels/ports'

describe('worker port registry', () => {
  it('registers Telegram when both credentials are set', () => {
    const ports = buildPorts({ apiId: 12345, apiHash: 'abc' })
    expect([...ports.keys()]).toEqual(['telegram', 'whatsapp'])
    expect(ports.get('telegram')!.channel).toBe('telegram')
    expect(ports.get('whatsapp')!.channel).toBe('whatsapp')
  })

  it('skips Telegram and warns exactly once when the credentials are unset', () => {
    // The project defaults ship empty until the owner registers the app, so
    // "no credentials" is the normal first-run state, not a crash: the worker
    // must still start and keep purging sessions.
    const warn = vi.fn()
    expect([...buildPorts({ apiId: 0, apiHash: '' }, warn).keys()]).toEqual(['whatsapp'])
    expect([...buildPorts({ apiId: 12345, apiHash: '' }, warn).keys()]).toEqual(['whatsapp'])
    expect([...buildPorts({ apiId: 0, apiHash: 'abc' }, warn).keys()]).toEqual(['whatsapp'])
    expect(warn).toHaveBeenCalledTimes(3) // once per call, never per tick
  })
})
