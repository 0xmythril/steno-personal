import { describe, it, expect, vi, afterEach } from 'vitest'
import pino from 'pino'
import { log } from '@/lib/log'
import { waLogger } from '@/lib/channels/whatsapp'

// Captures what the wrapper actually writes, by standing a real pino logger on
// a collecting destination in place of the child it asks `log` for.
function captureSink() {
  const lines: string[] = []
  const dest = { write: (chunk: string) => { lines.push(chunk) } }
  const captured = pino({ level: 'trace' }, dest as unknown as pino.DestinationStream)
  const spy = vi.spyOn(log, 'child').mockReturnValue(captured as unknown as ReturnType<typeof log.child>)
  return { lines, spy, text: () => lines.join('') }
}

afterEach(() => {
  vi.restoreAllMocks()
})

// Spec invariant 6. Baileys binds phone numbers, JIDs and raw binary nodes
// into its own log objects; none of that may reach our logs.
describe('the logger handed to Baileys', () => {
  it('drops bound identifiers but keeps the message and the error', () => {
    const cap = captureSink()
    const logger = waLogger()

    logger.warn({ pn: '+15551234567', jid: 'x@s.whatsapp.net', error: new Error('boom') }, 'Failed')

    const out = cap.text()
    expect(out).not.toContain('15551234567')
    expect(out).not.toContain('x@s.whatsapp.net')
    expect(out).not.toContain('"pn"')
    expect(out).not.toContain('"jid"')
    expect(out).toContain('Failed')
    expect(out).toContain('boom')
  })

  it('drops a whole binary node, keeping only the message', () => {
    const cap = captureSink()
    const logger = waLogger()

    logger.error(
      { fullErrorNode: { tag: 'stream:error', attrs: { from: '15551234567@s.whatsapp.net' } }, participant: 'y@lid' },
      'stream errored out',
    )

    const out = cap.text()
    expect(out).not.toContain('15551234567')
    expect(out).not.toContain('y@lid')
    expect(out).not.toContain('stream:error')
    expect(out).toContain('stream errored out')
  })

  it('accepts the bare-message form', () => {
    const cap = captureSink()
    waLogger().warn('closing open session')
    expect(cap.text()).toContain('closing open session')
  })

  it('stays silent below warn, however chatty the library gets', () => {
    const cap = captureSink()
    const logger = waLogger()
    logger.trace({ jid: 'x@s.whatsapp.net' }, 'recv')
    logger.debug({ jid: 'x@s.whatsapp.net' }, 'decrypt')
    logger.info({ jid: 'x@s.whatsapp.net' }, 'opened')
    expect(cap.text()).toBe('')
    expect(logger.level).toBe('warn')
  })

  it('carries no bindings across child()', () => {
    const cap = captureSink()
    const child = waLogger().child({ jid: 'x@s.whatsapp.net', pn: '+15551234567' })
    child.warn({}, 'still here')
    const out = cap.text()
    expect(out).not.toContain('15551234567')
    expect(out).not.toContain('x@s.whatsapp.net')
    expect(out).toContain('still here')
  })
})
