import { describe, it, expect, afterEach, vi } from 'vitest'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { BaileysWhatsAppPort } from '@/lib/channels/whatsapp'
import type { IncomingMessage } from '@/lib/channels/port'
import { fakeWaDeps, flush, testAuthRoot, waitForSocket, type FakeWaHarness } from './helpers/fake-wa-socket'

const FAST = { openTimeoutMs: 500, reconnectMinMs: 20, reconnectMaxMs: 80, staleMs: 60_000 }

// Captured before any vi.useFakeTimers(): open() does real fs work (mkdir for
// the auth dir, stat for the history marker), and a faked clock cannot advance
// that. This is the only way to hand the real event loop back to it.
const realSetTimeout = globalThis.setTimeout
const realTick = (ms = 0): Promise<void> => new Promise(resolve => { realSetTimeout(resolve, ms) })

async function waitForSockets(h: FakeWaHarness, n: number): Promise<void> {
  for (let i = 0; i < 500 && h.sockets.length < n; i++) {
    await realTick(1)
    await vi.advanceTimersByTimeAsync(0)
  }
}

// Real timers: for everything whose subject is behaviour, not the clock.
async function opened(authRoot: string, over: Partial<typeof FAST> = {}) {
  const h = fakeWaDeps()
  const port = new BaileysWhatsAppPort({ authRoot, deps: h.deps, ...FAST, ...over })
  const pending = port.open('wa-c1', { connectionId: 'c1' })
  await waitForSocket(h)
  h.sockets[0].emitOpen()
  const session = await pending
  return { h, port, session }
}

// Fake timers, installed before open() so every Date.now() in the port reads
// the same faked clock. For everything whose subject IS the clock: backoff
// delays, the open timeout, and the staleness window.
async function openedFake(authRoot: string, over: Partial<typeof FAST> = {}) {
  vi.useFakeTimers()
  const h = fakeWaDeps()
  const port = new BaileysWhatsAppPort({ authRoot, deps: h.deps, ...FAST, ...over })
  const pending = port.open('wa-c1', { connectionId: 'c1' })
  await waitForSockets(h, 1)
  h.sockets[0].emitOpen()
  const session = await pending
  return { h, port, session }
}

const dm = (id: string, over: Record<string, unknown> = {}) => ({
  key: { remoteJid: '7777@lid', id, fromMe: false },
  messageTimestamp: 1_700_000_000,
  pushName: 'Someone',
  message: { conversation: 'hi' },
  ...over,
})

afterEach(() => {
  vi.useRealTimers()
})

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
    const { h, session } = await openedFake(testAuthRoot('open-backoff'))

    h.sockets[0].emitClose(500)
    await vi.advanceTimersByTimeAsync(15)
    expect(h.sockets).toHaveLength(1) // 20 ms has not elapsed
    await vi.advanceTimersByTimeAsync(10)
    expect(h.sockets).toHaveLength(2)

    h.sockets[1].emitClose(500)
    await vi.advanceTimersByTimeAsync(25)
    expect(h.sockets).toHaveLength(2) // the second delay is 40 ms
    await vi.advanceTimersByTimeAsync(20)
    expect(h.sockets).toHaveLength(3)

    h.sockets[2].emitOpen() // a successful open resets the backoff to its floor
    h.sockets[2].emitClose(500)
    await vi.advanceTimersByTimeAsync(25)
    expect(h.sockets).toHaveLength(4)

    await session.close()
  })

  it('caps the backoff at reconnectMaxMs', async () => {
    const { h, session } = await openedFake(testAuthRoot('open-backoff-cap'))
    // 20, 40, 80, then 80 forever — never 160.
    for (const delay of [20, 40, 80, 80]) {
      h.sockets[h.sockets.length - 1].emitClose(500)
      await vi.advanceTimersByTimeAsync(delay - 1)
      const before = h.sockets.length
      await vi.advanceTimersByTimeAsync(1)
      expect(h.sockets.length).toBe(before + 1)
    }
    await session.close()
  })

  it('rejects with auth_invalidated when the device was unlinked', async () => {
    const h = fakeWaDeps()
    const port = new BaileysWhatsAppPort({ authRoot: testAuthRoot('open-401'), deps: h.deps, ...FAST })
    const pending = port.open('wa-c1', { connectionId: 'c1' })
    await waitForSocket(h)
    h.sockets[0].emitClose(401)
    await expect(pending).rejects.toMatchObject({ name: 'ChannelError', kind: 'auth_invalidated' })
  })

  // 403 forbidden and 440 connectionReplaced are as final as 401: nothing about
  // them heals by waiting, so reconnecting just hammers WhatsApp.
  for (const code of [403, 440]) {
    it(`treats close code ${code} as terminal during open`, async () => {
      const h = fakeWaDeps()
      const port = new BaileysWhatsAppPort({ authRoot: testAuthRoot(`open-${code}`), deps: h.deps, ...FAST })
      const pending = port.open('wa-c1', { connectionId: 'c1' })
      await waitForSocket(h)
      h.sockets[0].emitClose(code)
      await expect(pending).rejects.toMatchObject({ name: 'ChannelError', kind: 'auth_invalidated' })
    })

    it(`never reconnects after a live close code ${code}`, async () => {
      const { h, session } = await openedFake(testAuthRoot(`live-${code}`))
      h.sockets[0].emitClose(code)
      await vi.advanceTimersByTimeAsync(1_000)
      expect(h.sockets).toHaveLength(1)
      await expect(session.ping()).rejects.toMatchObject({ name: 'ChannelError', kind: 'auth_invalidated' })
      await session.close()
    })
  }

  it('times out when the socket never opens', async () => {
    vi.useFakeTimers()
    const h = fakeWaDeps()
    const port = new BaileysWhatsAppPort({ authRoot: testAuthRoot('open-timeout'), deps: h.deps, ...FAST, openTimeoutMs: 30 })
    const rejection = port.open('wa-c1', { connectionId: 'c1' }).catch((err: unknown) => err)
    await waitForSockets(h, 1)
    await vi.advanceTimersByTimeAsync(30)
    expect(await rejection).toMatchObject({ name: 'ChannelError', kind: 'timed_out' })
    expect(h.sockets[0].endCalls).toBe(1)
  })

  it('reports a reconnect loop that never reaches open as stale', async () => {
    const { h, session } = await openedFake(testAuthRoot('open-stale'), { staleMs: 200 })
    await expect(session.ping()).resolves.toBeUndefined()

    // Every reconnect closes again immediately: WhatsApp keeps answering, so
    // events keep arriving, but the session has not been OPEN for a full stale
    // window. That is the case a lastEventAt-based ping would call healthy.
    for (let i = 0; i < 6; i++) {
      h.sockets[h.sockets.length - 1].emitClose(500)
      await vi.advanceTimersByTimeAsync(100)
    }
    expect(h.sockets.length).toBeGreaterThan(1)
    await expect(session.ping()).rejects.toMatchObject({ name: 'ChannelError', kind: 'other' })

    // A socket that opens again clears it.
    h.sockets[h.sockets.length - 1].emitOpen()
    await expect(session.ping()).resolves.toBeUndefined()
    await session.close()
  })

  it('resolves a @lid to its phone JID without the device suffix', async () => {
    const { h, session } = await opened(testAuthRoot('open-lid'))
    const got: IncomingMessage[] = []
    session.onMessage(m => got.push(m))

    // getPNForLID answers with the device it resolved (lib/Signal/lid-mapping.js).
    h.sockets[0].lidToPn.set('7777@lid', '15551230000:0@s.whatsapp.net')
    h.sockets[0].emit('messages.upsert', { messages: [dm('M1')] })
    await flush(20)

    expect(got).toHaveLength(1)
    expect(got[0].externalChatId).toBe('15551230000@s.whatsapp.net')
    expect(got[0].senderExternalId).toBe('15551230000@s.whatsapp.net')
    await session.close()
  })

  it('retries a @lid the device has not mapped yet', async () => {
    const { h, session } = await opened(testAuthRoot('open-lid-null'))
    const got: IncomingMessage[] = []
    session.onMessage(m => got.push(m))

    // No mapping yet: null means "not learned", not "no such mapping".
    h.sockets[0].emit('messages.upsert', { messages: [dm('M1')] })
    await flush(20)
    expect(got[0].externalChatId).toBe('7777@lid')

    h.sockets[0].lidToPn.set('7777@lid', '15551230000:0@s.whatsapp.net')
    h.sockets[0].emit('messages.upsert', { messages: [dm('M2')] })
    await flush(20)
    expect(got[1].externalChatId).toBe('15551230000@s.whatsapp.net')
    await session.close()
  })

  it('delivers nothing once close() has been called', async () => {
    const { h, session } = await opened(testAuthRoot('open-close-gate'))
    const got: IncomingMessage[] = []
    session.onMessage(m => got.push(m))

    h.sockets[0].emit('messaging-history.set', { chats: [], messages: [dm('M1'), dm('M2')] })
    await session.close()

    expect(got).toEqual([])
    await flush(30)
    expect(got).toEqual([]) // and nothing lands afterwards either
  })
})
