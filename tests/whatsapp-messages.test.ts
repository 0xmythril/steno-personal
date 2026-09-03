import { describe, it, expect } from 'vitest'
import { BaileysWhatsAppPort } from '@/lib/channels/whatsapp'
import type { IncomingMessage } from '@/lib/services/ingest'
import { FakeWaSocket, fakeWaDeps, flush, testAuthRoot, waitForSocket } from './helpers/fake-wa-socket'

const GROUP = '12345-67890@g.us'
const DM_LID = '9988776655@lid'
const DM_PN = '15551230000@s.whatsapp.net'

type Collected = {
  socket: FakeWaSocket
  messages: IncomingMessage[]
  edits: IncomingMessage[]
  deletes: Array<{ externalChatId?: string; externalMessageId: string }>
  close(): Promise<void>
}

async function connect(name: string): Promise<Collected> {
  const h = fakeWaDeps()
  const port = new BaileysWhatsAppPort({
    authRoot: testAuthRoot(name), deps: h.deps,
    openTimeoutMs: 500, reconnectMinMs: 10_000, reconnectMaxMs: 20_000, staleMs: 60_000,
  })
  const pending = port.open('wa-c1', { connectionId: 'c1' })
  await waitForSocket(h)
  h.sockets[0].emitOpen()
  const session = await pending
  const messages: IncomingMessage[] = []
  const edits: IncomingMessage[] = []
  const deletes: Array<{ externalChatId?: string; externalMessageId: string }> = []
  session.onMessage(m => messages.push(m))
  session.onEdit(m => edits.push(m))
  session.onDelete(r => deletes.push(r))
  return { socket: h.sockets[0], messages, edits, deletes, close: () => session.close() }
}

function textMessage(remoteJid: string, id: string, text: string, extra: Record<string, unknown> = {}) {
  return {
    key: { remoteJid, id, fromMe: false, participant: '15559990000@s.whatsapp.net' },
    messageTimestamp: 1_700_000_000,
    pushName: 'Ada',
    message: { conversation: text },
    ...extra,
  }
}

describe('live message flow', () => {
  it('archives a group message with the title from groups.upsert', async () => {
    const c = await connect('msg-group')
    c.socket.emit('groups.upsert', [{ id: GROUP, subject: 'Weeknotes' }])
    c.socket.emit('messages.upsert', { messages: [textMessage(GROUP, 'M1', 'hello')], type: 'notify' })
    await flush(20)

    expect(c.messages).toHaveLength(1)
    expect(c.messages[0]).toMatchObject({
      externalChatId: GROUP,
      chatKind: 'group',
      chatTitle: 'Weeknotes',
      externalMessageId: 'M1',
      senderExternalId: '15559990000@s.whatsapp.net',
      senderName: 'Ada',
      fromOwner: false,
      type: 'text',
      text: 'hello',
      media: null,
    })
    // The title was already known, so no network round-trip.
    expect(c.socket.groupMetadataCalls).toEqual([])
    await c.close()
  })

  it('reads an unknown group title lazily, exactly once', async () => {
    const c = await connect('msg-lazy-title')
    c.socket.groupSubjects.set(GROUP, 'Book club')
    c.socket.emit('messages.upsert', { messages: [textMessage(GROUP, 'M1', 'one')], type: 'notify' })
    await flush(20)
    c.socket.emit('messages.upsert', { messages: [textMessage(GROUP, 'M2', 'two')], type: 'notify' })
    await flush(20)

    expect(c.messages.map(m => m.chatTitle)).toEqual(['Book club', 'Book club'])
    expect(c.socket.groupMetadataCalls).toEqual([GROUP])
    await c.close()
  })

  it('does not retry a group whose metadata is unavailable', async () => {
    const c = await connect('msg-title-fail')
    c.socket.emit('messages.upsert', { messages: [textMessage(GROUP, 'M1', 'one')], type: 'notify' })
    await flush(20)
    c.socket.emit('messages.upsert', { messages: [textMessage(GROUP, 'M2', 'two')], type: 'notify' })
    await flush(20)

    expect(c.messages.map(m => m.chatTitle)).toEqual([null, null])
    expect(c.socket.groupMetadataCalls).toEqual([GROUP])
    await c.close()
  })

  it('resolves a LID DM onto the phone-number JID, chat and sender alike', async () => {
    const c = await connect('msg-lid')
    c.socket.lidToPn.set(DM_LID, DM_PN)
    c.socket.emit('messages.upsert', {
      messages: [{ key: { remoteJid: DM_LID, id: 'D1', fromMe: false }, messageTimestamp: 1_700_000_000, pushName: 'Bo', message: { conversation: 'hi' } }],
      type: 'notify',
    })
    await flush(20)

    expect(c.messages[0]).toMatchObject({
      externalChatId: DM_PN,
      senderExternalId: DM_PN,
      chatKind: 'dm',
      chatTitle: 'Bo', // a DM has no subject; the push name is the only title
    })
    await c.close()
  })

  it('leaves an unresolvable LID alone', async () => {
    const c = await connect('msg-lid-unresolved')
    c.socket.emit('messages.upsert', {
      messages: [{ key: { remoteJid: DM_LID, id: 'D1', fromMe: false }, messageTimestamp: 1_700_000_000, message: { conversation: 'hi' } }],
      type: 'notify',
    })
    await flush(20)
    expect(c.messages[0].externalChatId).toBe(DM_LID)
    await c.close()
  })

  it('archives the owner’s own message with fromOwner', async () => {
    const c = await connect('msg-own')
    c.socket.emit('messages.upsert', {
      messages: [{ key: { remoteJid: DM_PN, id: 'D2', fromMe: true }, messageTimestamp: 1_700_000_000, message: { conversation: 'mine' } }],
      type: 'notify',
    })
    await flush(20)
    expect(c.messages[0]).toMatchObject({ fromOwner: true, senderExternalId: null, externalChatId: DM_PN })
    await c.close()
  })

  it('skips status@broadcast', async () => {
    const c = await connect('msg-status')
    c.socket.emit('messages.upsert', { messages: [textMessage('status@broadcast', 'S1', 'story')], type: 'notify' })
    await flush(20)
    expect(c.messages).toEqual([])
    await c.close()
  })
})

describe('history flow', () => {
  it('feeds pushed history to onMessage and takes titles from chats[]', async () => {
    const c = await connect('hist-basic')
    c.socket.emit('messaging-history.set', {
      chats: [{ id: GROUP, name: 'Old group' }, { id: DM_PN, name: 'Bo' }],
      messages: [textMessage(GROUP, 'H1', 'older'), textMessage(DM_PN, 'H2', 'dm history')],
    })
    await flush(30)

    expect(c.messages.map(m => [m.externalChatId, m.chatTitle, m.externalMessageId])).toEqual([
      [GROUP, 'Old group', 'H1'],
      [DM_PN, 'Bo', 'H2'],
    ])
    expect(c.socket.groupMetadataCalls).toEqual([])
    await c.close()
  })

  it('buffers anything that lands before the callbacks are registered', async () => {
    const h = fakeWaDeps()
    const port = new BaileysWhatsAppPort({ authRoot: testAuthRoot('hist-buffer'), deps: h.deps, openTimeoutMs: 500, reconnectMinMs: 10_000 })
    const pending = port.open('wa-c1', { connectionId: 'c1' })
    await waitForSocket(h)
    h.sockets[0].emitOpen()
    const session = await pending

    h.sockets[0].emit('messaging-history.set', { chats: [{ id: GROUP, name: 'Early' }], messages: [textMessage(GROUP, 'H1', 'early')] })
    await flush(30)

    const messages: IncomingMessage[] = []
    session.onMessage(m => messages.push(m))
    expect(messages.map(m => m.externalMessageId)).toEqual(['H1'])
    await session.close()
  })
})

describe('protocol events', () => {
  it('turns a revoke into onDelete', async () => {
    const c = await connect('proto-delete')
    c.socket.emit('messages.upsert', {
      messages: [{ key: { remoteJid: GROUP, id: 'R1', fromMe: false }, messageTimestamp: 1_700_000_100, message: { protocolMessage: { type: 0, key: { id: 'M1' } } } }],
      type: 'notify',
    })
    await flush(20)
    expect(c.deletes).toEqual([{ externalChatId: GROUP, externalMessageId: 'M1' }])
    expect(c.messages).toEqual([])
    await c.close()
  })

  it('turns an edit into onEdit with the new text', async () => {
    const c = await connect('proto-edit')
    c.socket.emit('groups.update', [{ id: GROUP, subject: 'Weeknotes' }])
    c.socket.emit('messages.upsert', {
      messages: [{
        key: { remoteJid: GROUP, id: 'E1', fromMe: false },
        messageTimestamp: 1_700_000_200,
        message: { editedMessage: { message: { protocolMessage: { type: 14, key: { id: 'M1' }, editedMessage: { conversation: 'corrected' } } } } },
      }],
      type: 'notify',
    })
    await flush(20)
    expect(c.edits).toHaveLength(1)
    expect(c.edits[0]).toMatchObject({
      externalChatId: GROUP, chatTitle: 'Weeknotes', externalMessageId: 'M1', type: 'text', text: 'corrected',
    })
    expect(c.messages).toEqual([])
    await c.close()
  })

  it('never blanks a row from an edit with no readable text', async () => {
    const c = await connect('proto-edit-empty')
    c.socket.emit('messages.upsert', {
      messages: [{
        key: { remoteJid: GROUP, id: 'E2', fromMe: false },
        messageTimestamp: 1_700_000_300,
        message: { protocolMessage: { type: 14, key: { id: 'M1' }, editedMessage: { stickerMessage: {} } } },
      }],
      type: 'notify',
    })
    await flush(20)
    expect(c.edits).toEqual([])
    expect(c.messages).toEqual([])
    await c.close()
  })

  it('applies revokes and edits replayed inside a history batch', async () => {
    const c = await connect('proto-history')
    c.socket.emit('messaging-history.set', {
      chats: [],
      messages: [{ key: { remoteJid: GROUP, id: 'R2', fromMe: false }, messageTimestamp: 1_700_000_400, message: { protocolMessage: { type: 0, key: { id: 'M9' } } } }],
    })
    await flush(30)
    expect(c.deletes).toEqual([{ externalChatId: GROUP, externalMessageId: 'M9' }])
    await c.close()
  })
})
