import { describe, it, expect } from 'vitest'
import { FakePort } from '@/lib/channels/fake-port'
import { ChannelError, type IncomingMessage, type LoginDriver } from '@/lib/channels/port'

const noopDriver: LoginDriver = {
  publishQr: async () => {}, requestPassword: async () => {},
  getPassword: async () => null, passwordRejected: async () => {},
}

const msg = (id: string): IncomingMessage => ({
  externalChatId: '1', chatKind: 'dm', chatTitle: 'A', externalMessageId: id,
  senderExternalId: null, senderName: 'A', fromOwner: false, sentAt: new Date(),
  type: 'text', text: 'hi', media: null, raw: {},
})

describe('FakePort (test double contract)', () => {
  it('publishes a QR, then resolves with the scripted account', async () => {
    const port = new FakePort('telegram')
    port.scriptLogin({ sessionString: 'SESS', account: { channel: 'telegram', externalAccountId: 'tg-1', displayName: 'Me' } })
    const published: string[] = []
    const res = await port.login({ ...noopDriver, publishQr: async u => { published.push(u) } }, { timeoutMs: 1000, connectionId: 'c1' })
    expect(published[0]).toContain('tg://login')
    expect(res).toEqual({ sessionString: 'SESS', account: { channel: 'telegram', externalAccountId: 'tg-1', displayName: 'Me' } })
  })

  it('can be scripted to reject with a classified error', async () => {
    const port = new FakePort('telegram')
    port.scriptLoginError(new ChannelError('timed out', 'timed_out'))
    await expect(port.login(noopDriver, { timeoutMs: 10, connectionId: 'c1' })).rejects.toMatchObject({ kind: 'timed_out' })
  })

  it('rejects a wrong password (calling passwordRejected), then accepts the right one', async () => {
    const port = new FakePort('telegram')
    port.scriptPasswordLogin({
      correctPassword: 'right',
      result: { sessionString: 'SESS2', account: { channel: 'telegram', externalAccountId: 'tg-2', displayName: 'Me' } },
    })
    const passwords = ['wrong', 'right']
    let attempt = 0
    const rejections: number[] = []
    const res = await port.login({
      ...noopDriver,
      getPassword: async () => passwords[attempt++] ?? null,
      passwordRejected: async () => { rejections.push(attempt) },
    }, { timeoutMs: 1000, connectionId: 'c1' })
    expect(rejections).toEqual([1]) // rejected exactly once, after the wrong password
    expect(res.sessionString).toBe('SESS2')
  })

  it('opens a session whose backfill yields the script and whose handlers fire', async () => {
    const port = new FakePort('telegram')
    port.scriptBackfill([msg('1')])
    const session = await port.open('SESS', { connectionId: 'c1' })
    const got: string[] = []
    for await (const m of session.backfill({ sinceDays: 30, maxDialogs: 200, maxPerChat: 500 })) got.push(m.externalMessageId)
    expect(got).toEqual(['1'])

    const live: string[] = []
    const edits: string[] = []
    const deletes: string[] = []
    session.onMessage(m => live.push(m.externalMessageId))
    session.onEdit(m => edits.push(m.externalMessageId))
    session.onDelete(r => deletes.push(r.externalMessageId))
    port.emitMessage(msg('2')); port.emitEdit(msg('3')); port.emitDelete({ externalMessageId: '4' })
    expect([live, edits, deletes]).toEqual([['2'], ['3'], ['4']])
  })

  it('records logOut and close, and serves a scripted download', async () => {
    const port = new FakePort('telegram')
    port.scriptDownload({ data: Buffer.from('bytes'), mimeType: 'image/jpeg' })
    const session = await port.open('SESS', { connectionId: 'c1' })
    expect(await session.downloadMedia({})).toEqual({ data: Buffer.from('bytes'), mimeType: 'image/jpeg' })
    expect(port.loggedOut).toBe(false)
    await session.logOut()
    expect(port.loggedOut).toBe(true)
    await session.close()
    expect(port.sessionClosed).toBe(true)
  })

  it('serves the contact list live, so it can change under an open session', async () => {
    // A contact sync runs on a manager tick against a session opened long
    // before it, and the address book has to see what the channel knows NOW.
    const port = new FakePort('telegram')
    const session = await port.open('SESS', { connectionId: 'c1' })
    expect(await session.listContacts()).toEqual([])
    port.contacts = [{ externalId: '777000', displayName: 'Ada', phone: '+447700900123' }]
    expect(await session.listContacts()).toEqual([
      { externalId: '777000', displayName: 'Ada', phone: '+447700900123' },
    ])
  })

  it('a scripted ping error surfaces from the already-open session', async () => {
    const port = new FakePort('telegram')
    const session = await port.open('SESS', { connectionId: 'c1' })
    await session.ping() // healthy
    port.scriptPingError(new ChannelError('auth invalidated', 'auth_invalidated'))
    await expect(session.ping()).rejects.toMatchObject({ kind: 'auth_invalidated' })
  })
})
