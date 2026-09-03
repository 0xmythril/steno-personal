import { describe, it, expect } from 'vitest'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { BaileysWhatsAppPort } from '@/lib/channels/whatsapp'
import type { WaDeps } from '@/lib/channels/whatsapp'
import { ChannelError } from '@/lib/channels/port'
import type { LoginDriver } from '@/lib/channels/port'
import { fakeWaDeps, flush, testAuthRoot, waitForSocket } from './helpers/fake-wa-socket'

function recordingDriver() {
  const qrs: string[] = []
  const calls: string[] = []
  const driver: LoginDriver = {
    async publishQr(url) { qrs.push(url) },
    async requestPassword() { calls.push('requestPassword') },
    async getPassword() { calls.push('getPassword'); return null },
    async passwordRejected() { calls.push('passwordRejected') },
  }
  return { driver, qrs, calls }
}

describe('BaileysWhatsAppPort.login', () => {
  it('publishes every QR and resolves on open', async () => {
    const authRoot = testAuthRoot('login-ok')
    const h = fakeWaDeps()
    const port = new BaileysWhatsAppPort({ authRoot, deps: h.deps })
    const { driver, qrs, calls } = recordingDriver()

    const pending = port.login(driver, { timeoutMs: 5_000, connectionId: 'conn-1' })
    await waitForSocket(h)
    h.last().emitQr('qr-one')
    h.last().emitQr('qr-two')
    await flush()
    h.last().emitOpen({ id: '15551234567@s.whatsapp.net', name: 'Owner' })

    const result = await pending
    expect(qrs).toEqual(['qr-one', 'qr-two'])
    expect(result.sessionString).toBe('wa-conn-1')
    expect(result.account).toEqual({ channel: 'whatsapp', externalAccountId: '15551234567@s.whatsapp.net', displayName: 'Owner' })
    // The password callbacks belong to Telegram's 2FA step and are never used.
    expect(calls).toEqual([])
    // syncFullHistory rides the REGISTRATION node, so pairing is the only
    // chance to ask for full history at all.
    expect(h.sockets[0].opts.syncFullHistory).toBe(true)
    // The manager owns the live socket: login hands back a session string and
    // closes its own.
    await flush()
    expect(h.last().endCalls).toBe(1)
    expect(existsSync(path.join(authRoot, 'wa-conn-1'))).toBe(true)
  })

  it('tolerates the post-pairing restart Baileys demands', async () => {
    const h = fakeWaDeps()
    const port = new BaileysWhatsAppPort({ authRoot: testAuthRoot('login-515'), deps: h.deps })
    const { driver } = recordingDriver()

    const pending = port.login(driver, { timeoutMs: 5_000, connectionId: 'conn-2' })
    await waitForSocket(h)
    h.sockets[0].emitClose(515) // DisconnectReason.restartRequired
    await waitForSocket(h, 2)
    expect(h.sockets).toHaveLength(2)
    h.sockets[1].emitOpen()

    await expect(pending).resolves.toMatchObject({ sessionString: 'wa-conn-2' })
  })

  it('gives up after a second restart rather than looping', async () => {
    const h = fakeWaDeps()
    const port = new BaileysWhatsAppPort({ authRoot: testAuthRoot('login-515-twice'), deps: h.deps })
    const { driver } = recordingDriver()

    const pending = port.login(driver, { timeoutMs: 5_000, connectionId: 'conn-3' })
    await waitForSocket(h)
    h.sockets[0].emitClose(515)
    await waitForSocket(h, 2)
    h.sockets[1].emitClose(515)

    await expect(pending).rejects.toMatchObject({ name: 'ChannelError', kind: 'other' })
    expect(h.sockets).toHaveLength(2)
  })

  it('reports a rejected pairing as auth_invalidated', async () => {
    const h = fakeWaDeps()
    const port = new BaileysWhatsAppPort({ authRoot: testAuthRoot('login-401'), deps: h.deps })
    const { driver } = recordingDriver()

    const pending = port.login(driver, { timeoutMs: 5_000, connectionId: 'conn-4' })
    await waitForSocket(h)
    h.sockets[0].emitClose(401) // DisconnectReason.loggedOut

    await expect(pending).rejects.toBeInstanceOf(ChannelError)
    await expect(pending).rejects.toMatchObject({ kind: 'auth_invalidated' })
    await flush()
    expect(h.sockets[0].endCalls).toBe(1)
  })

  it('times out', async () => {
    const h = fakeWaDeps()
    const port = new BaileysWhatsAppPort({ authRoot: testAuthRoot('login-timeout'), deps: h.deps })
    const { driver } = recordingDriver()

    await expect(port.login(driver, { timeoutMs: 20, connectionId: 'conn-5' }))
      .rejects.toMatchObject({ kind: 'timed_out' })
    // A socket the timeout orphaned is closed, not left open.
    await waitForSocket(h)
    await flush()
    expect(h.last().endCalls).toBe(1)
  })

  it('closes a socket that finished connecting after the timeout fired', async () => {
    const h = fakeWaDeps()
    // makeSocket outlives the timeout, so the socket lands on a promise that
    // has already rejected.
    const slow: WaDeps = { ...h.deps, async makeSocket(o) { await flush(40); return await h.deps.makeSocket(o) } }
    const port = new BaileysWhatsAppPort({ authRoot: testAuthRoot('login-late-socket'), deps: slow })
    const { driver } = recordingDriver()

    await expect(port.login(driver, { timeoutMs: 10, connectionId: 'conn-8' }))
      .rejects.toMatchObject({ kind: 'timed_out' })

    await flush(80)
    expect(h.sockets).toHaveLength(1)
    expect(h.sockets[0].endCalls).toBe(1)
  })

  it('persists creds the pairing socket emits', async () => {
    const h = fakeWaDeps()
    const port = new BaileysWhatsAppPort({ authRoot: testAuthRoot('login-creds'), deps: h.deps })
    const { driver } = recordingDriver()

    const pending = port.login(driver, { timeoutMs: 5_000, connectionId: 'conn-7' })
    await waitForSocket(h)
    expect(h.saveCredsCalls()).toBe(0)

    // pair-success emits creds.update; those keys are the whole session.
    h.last().emit('creds.update', {})
    await flush()
    expect(h.saveCredsCalls()).toBe(1)

    h.last().emitOpen()
    await pending
    // And once more on the way out, before the socket goes away.
    expect(h.saveCredsCalls()).toBe(2)
  })

  it('refuses a session string that is not ours', async () => {
    const h = fakeWaDeps()
    const port = new BaileysWhatsAppPort({ authRoot: testAuthRoot('traversal'), deps: h.deps })
    await expect(port.open('../../etc', { connectionId: 'conn-6' })).rejects.toMatchObject({ kind: 'other' })
  })
})
