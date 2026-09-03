import { describe, it, expect } from 'vitest'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { BaileysWhatsAppPort } from '@/lib/channels/whatsapp'
import type { ChannelSession } from '@/lib/channels/port'
import { FakeWaSocket, fakeWaDeps, flush, testAuthRoot, waitForSocket } from './helpers/fake-wa-socket'

async function connect(name: string, over: { staleMs?: number; reconnectMinMs?: number; download?: (m: unknown) => Promise<Buffer> } = {}) {
  const h = fakeWaDeps({ download: over.download })
  const authRoot = testAuthRoot(name)
  const port = new BaileysWhatsAppPort({
    authRoot, deps: h.deps, openTimeoutMs: 500,
    reconnectMinMs: over.reconnectMinMs ?? 10_000, reconnectMaxMs: 20_000, staleMs: over.staleMs ?? 60_000,
  })
  const pending = port.open('wa-c1', { connectionId: 'c1' })
  await waitForSocket(h)
  h.sockets[0].emitOpen()
  const session: ChannelSession = await pending
  return { h, authRoot, session, socket: (): FakeWaSocket => h.last() }
}

describe('downloadMedia', () => {
  it('revives the JSON buffers, wires reuploadRequest, and reports the mime type', async () => {
    const c = await connect('media-ok', { download: async () => Buffer.from('jpeg-bytes') })
    const raw = {
      key: { remoteJid: '12345-67890@g.us', id: 'M1', fromMe: false, participant: '15559990000@s.whatsapp.net' },
      messageTimestamp: 1_700_000_000,
      message: { imageMessage: { mimetype: 'image/jpeg', mediaKey: { type: 'Buffer', data: [1, 2, 3] } } },
    }

    const result = await c.session.downloadMedia(raw)
    expect(result.mimeType).toBe('image/jpeg')
    expect(result.data.toString()).toBe('jpeg-bytes')

    const handed = c.h.downloads()[0] as { message: { imageMessage: { mediaKey: Buffer } } }
    expect(Buffer.isBuffer(handed.message.imageMessage.mediaKey)).toBe(true)
    // The port hands Baileys sock.updateMediaMessage as the reupload path.
    expect(c.socket().reuploaded).toHaveLength(1)
    await c.session.close()
  })

  it('reports a failed download as ChannelError(other)', async () => {
    const c = await connect('media-fail', { download: async () => { throw new Error('gone') } })
    await expect(c.session.downloadMedia({ message: {} })).rejects.toMatchObject({ name: 'ChannelError', kind: 'other' })
    await c.session.close()
  })

  it('rejects after close() — there is no live socket to download from', async () => {
    const c = await connect('media-after-close')
    await c.session.close()
    await expect(c.session.downloadMedia({ message: {} })).rejects.toMatchObject({ name: 'ChannelError', kind: 'other' })
  })

  it('rejects during a reconnect gap, then succeeds again once the reconnect opens', async () => {
    const c = await connect('media-reconnect-gap', { reconnectMinMs: 5 })
    c.socket().emitClose(500) // non-terminal: a reconnect gets scheduled, socket is down
    await expect(c.session.downloadMedia({ message: {} })).rejects.toMatchObject({ name: 'ChannelError', kind: 'other' })

    await flush(30)
    expect(c.h.sockets.length).toBeGreaterThan(1) // the reconnect actually happened
    c.socket().emitOpen()

    const result = await c.session.downloadMedia({ message: {} })
    expect(result.data.toString()).toBe('media-bytes')
    await c.session.close()
  })
})

describe('ping', () => {
  it('is quiet while connected', async () => {
    const c = await connect('ping-ok')
    await expect(c.session.ping()).resolves.toBeUndefined()
    await c.session.close()
  })

  it('throws auth_invalidated after a loggedOut close', async () => {
    const c = await connect('ping-401')
    c.socket().emitClose(401)
    await flush()
    await expect(c.session.ping()).rejects.toMatchObject({ kind: 'auth_invalidated' })
    await c.session.close()
  })

  it('throws other when the socket is closed and silent', async () => {
    const c = await connect('ping-stale', { staleMs: 0 })
    c.socket().emitClose(500)
    await flush(5)
    await expect(c.session.ping()).rejects.toMatchObject({ kind: 'other' })
    await c.session.close()
  })

  it('goes quiet again once the reconnect lands', async () => {
    const c = await connect('ping-reconnect', { staleMs: 0, reconnectMinMs: 5 })
    c.socket().emitClose(500)
    await flush(30)
    // A fresh socket exists; its connection.update refreshed lastEventAt only
    // once it emits, so this asserts the reconnect actually happened.
    expect(c.h.sockets.length).toBeGreaterThan(1)
    c.socket().emitOpen()
    await expect(c.session.ping()).resolves.toBeUndefined()
    await c.session.close()
  })
})

describe('logOut and close', () => {
  it('unlinks this device and removes the auth directory', async () => {
    const c = await connect('logout')
    const dir = path.join(c.authRoot, 'wa-c1')
    expect(existsSync(dir)).toBe(true)

    await c.session.logOut()
    expect(c.socket().logoutCalls).toBe(1)
    expect(c.socket().endCalls).toBe(1)
    expect(existsSync(dir)).toBe(false)
    await expect(c.session.ping()).rejects.toMatchObject({ kind: 'auth_invalidated' })
  })

  it('still removes local auth state when the unlink call fails', async () => {
    const c = await connect('logout-fail')
    const dir = path.join(c.authRoot, 'wa-c1')
    c.socket().logout = async () => { throw new Error('socket already dead') }

    await c.session.logOut()
    expect(existsSync(dir)).toBe(false)
  })

  it('delivers nothing once logOut() has been called', async () => {
    const c = await connect('logout-message-gate')
    const got: unknown[] = []
    c.session.onMessage(m => got.push(m))

    await c.session.logOut()
    c.socket().emit('messages.upsert', {
      messages: [{
        key: { remoteJid: '7777@lid', id: 'M1', fromMe: false },
        messageTimestamp: 1_700_000_000,
        pushName: 'Someone',
        message: { conversation: 'hi' },
      }],
    })
    await flush(20)
    expect(got).toEqual([])
  })

  it('close ends the socket and stops reconnecting', async () => {
    const c = await connect('close', { reconnectMinMs: 5 })
    await c.session.close()
    expect(c.h.sockets[0].endCalls).toBe(1)
    // close() is teardown only: no unlink call, and the auth dir survives.
    expect(c.h.sockets[0].logoutCalls).toBe(0)
    expect(existsSync(path.join(c.authRoot, 'wa-c1'))).toBe(true)

    c.h.sockets[0].emitClose(500)
    await flush(30)
    expect(c.h.sockets).toHaveLength(1)
  })
})
