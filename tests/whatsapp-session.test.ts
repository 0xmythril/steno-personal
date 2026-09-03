import { describe, it, expect } from 'vitest'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { BaileysWhatsAppPort } from '@/lib/channels/whatsapp'
import { fakeWaDeps, flush, testAuthRoot } from './helpers/fake-wa-socket'

const FAST = { openTimeoutMs: 500, reconnectMinMs: 20, reconnectMaxMs: 80, staleMs: 60_000 }

async function opened(authRoot: string, over: Partial<typeof FAST> = {}) {
  const h = fakeWaDeps()
  const port = new BaileysWhatsAppPort({ authRoot, deps: h.deps, ...FAST, ...over })
  const pending = port.open('wa-c1', { connectionId: 'c1' })
  await flush()
  h.sockets[0].emitOpen()
  const session = await pending
  return { h, port, session }
}

describe('BaileysWhatsAppPort.open', () => {
  it('connects and hands back a read-only session', async () => {
    const { h, session } = await opened(testAuthRoot('open-ok'))
    expect(h.sockets).toHaveLength(1)
    // Spec invariant 1: exactly the eight ChannelSession members, no test hook.
    expect(Object.keys(session).sort()).toEqual(
      ['backfill', 'close', 'downloadMedia', 'logOut', 'onDelete', 'onEdit', 'onMessage', 'ping'].sort(),
    )
    await session.close()
  })

  it('yields nothing from backfill — WhatsApp pushes history instead', async () => {
    const { session } = await opened(testAuthRoot('open-backfill'))
    const out = []
    for await (const m of session.backfill({ sinceDays: 30, maxDialogs: 10, maxPerChat: 10 })) out.push(m)
    expect(out).toEqual([])
    await session.close()
  })

  it('asks for full history only until the marker exists', async () => {
    const authRoot = testAuthRoot('open-marker')
    const markerPath = path.join(authRoot, 'wa-c1', 'history-synced')

    const first = await opened(authRoot)
    expect(first.h.sockets[0].opts.syncFullHistory).toBe(true)
    expect(existsSync(markerPath)).toBe(false)
    first.h.sockets[0].emit('messaging-history.set', { chats: [], messages: [] })
    await flush(30)
    expect(existsSync(markerPath)).toBe(true)
    await first.session.close()

    const second = await opened(authRoot)
    expect(second.h.sockets[0].opts.syncFullHistory).toBe(false)
    await second.session.close()
  })

  it('reconnects with an exponential backoff that resets on open', async () => {
    const { h, session } = await opened(testAuthRoot('open-backoff'))

    h.sockets[0].emitClose(500)
    await flush(15)
    expect(h.sockets).toHaveLength(1) // 20 ms has not elapsed
    await flush(30)
    expect(h.sockets).toHaveLength(2)

    h.sockets[1].emitClose(500)
    await flush(25)
    expect(h.sockets).toHaveLength(2) // the second delay is 40 ms
    await flush(40)
    expect(h.sockets).toHaveLength(3)

    h.sockets[2].emitOpen() // a successful open resets the backoff to its floor
    h.sockets[2].emitClose(500)
    await flush(35)
    expect(h.sockets).toHaveLength(4)

    await session.close()
  })

  it('rejects with auth_invalidated when the device was unlinked', async () => {
    const h = fakeWaDeps()
    const port = new BaileysWhatsAppPort({ authRoot: testAuthRoot('open-401'), deps: h.deps, ...FAST })
    const pending = port.open('wa-c1', { connectionId: 'c1' })
    await flush()
    h.sockets[0].emitClose(401)
    await expect(pending).rejects.toMatchObject({ name: 'ChannelError', kind: 'auth_invalidated' })
  })

  it('times out when the socket never opens', async () => {
    const h = fakeWaDeps()
    const port = new BaileysWhatsAppPort({ authRoot: testAuthRoot('open-timeout'), deps: h.deps, ...FAST, openTimeoutMs: 30 })
    await expect(port.open('wa-c1', { connectionId: 'c1' })).rejects.toMatchObject({ kind: 'timed_out' })
    await flush(60)
    expect(h.sockets[0].endCalls).toBe(1)
  })
})
