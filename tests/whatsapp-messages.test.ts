import { describe, it, expect, vi } from 'vitest'
import { log } from '@/lib/log'
import { BaileysWhatsAppPort } from '@/lib/channels/whatsapp'
import type { ChannelContact } from '@/lib/channels/port'
import type { DeleteRef, IncomingMessage } from '@/lib/services/ingest'
import { FakeWaSocket, fakeWaDeps, flush, testAuthRoot, waitForSocket } from './helpers/fake-wa-socket'

const GROUP = '12345-67890@g.us'
const DM_LID = '9988776655@lid'
const DM_PN = '15551230000@s.whatsapp.net'

type Collected = {
  socket: FakeWaSocket
  messages: IncomingMessage[]
  edits: IncomingMessage[]
  deletes: DeleteRef[]
  listContacts(): Promise<ChannelContact[]>
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
  const deletes: DeleteRef[] = []
  session.onMessage(m => messages.push(m))
  session.onEdit(m => edits.push(m))
  session.onDelete(r => deletes.push(r))
  return {
    socket: h.sockets[0], messages, edits, deletes,
    listContacts: () => session.listContacts(),
    close: () => session.close(),
  }
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

  it('names a DM after the contact, saved name first, before the push name', async () => {
    const c = await connect('msg-contact-name')
    c.socket.emit('contacts.upsert', [{ id: DM_PN, lid: DM_LID, name: 'Bo Saved', notify: 'Bo' }])
    c.socket.emit('messages.upsert', {
      // Arrives on the LID; the contact's own pairing resolves it without the resolver.
      messages: [{ key: { remoteJid: DM_LID, id: 'D1', fromMe: false }, messageTimestamp: 1_700_000_000, pushName: 'Bo', message: { conversation: 'hi' } }],
      type: 'notify',
    })
    await flush(20)
    expect(c.messages[0]).toMatchObject({ externalChatId: DM_PN, chatKind: 'dm', chatTitle: 'Bo Saved' })
    await c.close()
  })

  it('a history batch names its DMs from contacts[] before replaying the messages', async () => {
    const c = await connect('msg-history-contacts')
    c.socket.emit('messaging-history.set', {
      chats: [],
      contacts: [{ id: DM_PN, notify: 'Bo Push' }],
      lidPnMappings: [{ lid: DM_LID, pn: DM_PN }],
      messages: [
        // Owner-sent, no push name for the counterparty anywhere in the message.
        { key: { remoteJid: DM_LID, id: 'H1', fromMe: true }, messageTimestamp: 1_700_000_000, message: { conversation: 'sent by me' } },
      ],
      progress: 50,
    })
    await flush(20)
    expect(c.messages.map(m => [m.externalChatId, m.chatTitle])).toEqual([[DM_PN, 'Bo Push']])
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

  // Baileys throws with the JID inside the message (lib/Socket/chats.js:291),
  // and this catch block is where it lands. Spec invariant 6.
  it('scrubs the JID out of a failed LID lookup before logging it', async () => {
    const c = await connect('msg-lid-throws')
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => log)
    try {
      c.socket.signalRepository.lidMapping.getPNForLID = async () => {
        throw new Error(`Unable to resolve PN JID for LID: ${DM_LID}`)
      }
      c.socket.emit('messages.upsert', {
        messages: [{ key: { remoteJid: DM_LID, id: 'D9', fromMe: false }, messageTimestamp: 1_700_000_000, message: { conversation: 'hi' } }],
        type: 'notify',
      })
      await flush(20)
      const call = warn.mock.calls.find(c2 => c2[1] === 'whatsapp lid resolution failed')
      expect(call).toBeDefined()
      const payload = JSON.stringify(call![0])
      expect(payload).not.toContain('9988776655')
      expect(payload).not.toContain('@lid')
      expect(payload).toContain('Unable to resolve PN JID for LID')
    } finally {
      warn.mockRestore()
    }
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
  // Every revoke and edit names who sent it, canonicalised like a message's
  // sender, so ingest can refuse one from anyone but the message's author.
  it('turns a revoke into onDelete, naming the participant who sent it', async () => {
    const c = await connect('proto-delete')
    c.socket.emit('messages.upsert', {
      messages: [{ key: { remoteJid: GROUP, id: 'R1', fromMe: false, participant: '15559990000@s.whatsapp.net' }, messageTimestamp: 1_700_000_100, message: { protocolMessage: { type: 0, key: { id: 'M1' } } } }],
      type: 'notify',
    })
    await flush(20)
    expect(c.deletes).toEqual([{ externalChatId: GROUP, externalMessageId: 'M1', actor: { fromOwner: false, senderExternalId: '15559990000@s.whatsapp.net' } }])
    expect(c.messages).toEqual([])
    await c.close()
  })

  it('names the DM counterparty, resolved to the phone JID, as the actor of a revoke', async () => {
    const c = await connect('proto-delete-dm')
    c.socket.lidToPn.set(DM_LID, DM_PN)
    c.socket.emit('messages.upsert', {
      messages: [
        { key: { remoteJid: DM_LID, id: 'R2', fromMe: false }, messageTimestamp: 1_700_000_100, message: { protocolMessage: { type: 0, key: { id: 'M1' } } } },
        { key: { remoteJid: DM_LID, id: 'R3', fromMe: true }, messageTimestamp: 1_700_000_100, message: { protocolMessage: { type: 0, key: { id: 'M2' } } } },
      ],
      type: 'notify',
    })
    await flush(20)
    expect(c.deletes).toEqual([
      { externalChatId: DM_PN, externalMessageId: 'M1', actor: { fromOwner: false, senderExternalId: DM_PN } },
      { externalChatId: DM_PN, externalMessageId: 'M2', actor: { fromOwner: true, senderExternalId: null } },
    ])
    await c.close()
  })

  it('turns an edit into onEdit with the new text', async () => {
    const c = await connect('proto-edit')
    c.socket.emit('groups.update', [{ id: GROUP, subject: 'Weeknotes' }])
    c.socket.emit('messages.upsert', {
      messages: [{
        key: { remoteJid: GROUP, id: 'E1', fromMe: false, participant: '15559990000@s.whatsapp.net' },
        messageTimestamp: 1_700_000_200,
        message: { editedMessage: { message: { protocolMessage: { type: 14, key: { id: 'M1' }, editedMessage: { conversation: 'corrected' } } } } },
      }],
      type: 'notify',
    })
    await flush(20)
    expect(c.edits).toHaveLength(1)
    expect(c.edits[0]).toMatchObject({
      externalChatId: GROUP, chatTitle: 'Weeknotes', externalMessageId: 'M1', type: 'text', text: 'corrected',
      fromOwner: false, senderExternalId: '15559990000@s.whatsapp.net',
      actor: { fromOwner: false, senderExternalId: '15559990000@s.whatsapp.net' },
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
      messages: [{ key: { remoteJid: GROUP, id: 'R2', fromMe: false }, participant: '15559990000@s.whatsapp.net', messageTimestamp: 1_700_000_400, message: { protocolMessage: { type: 0, key: { id: 'M9' } } } }],
    })
    await flush(30)
    expect(c.deletes).toEqual([{ externalChatId: GROUP, externalMessageId: 'M9', actor: { fromOwner: false, senderExternalId: '15559990000@s.whatsapp.net' } }])
    await c.close()
  })
})

// The address book's WhatsApp side. No new call to WhatsApp: the port answers
// out of the contacts the phone already pushes at it, keyed by the phone JID
// because that is the identity the archive files a person under, and it is the
// only form that carries a number (people design decision 2 and 3).
describe('listContacts', () => {
  it('lists a contact learned from contacts.upsert, with the number from its JID', async () => {
    const c = await connect('contacts-upsert')
    c.socket.emit('contacts.upsert', [{ id: DM_PN, lid: DM_LID, name: 'Bo Saved', notify: 'Bo' }])
    await flush(20)
    expect(await c.listContacts()).toEqual([
      { externalId: DM_PN, displayName: 'Bo Saved', phone: '+15551230000' },
    ])
    await c.close()
  })

  it('lists the contacts that arrive with a history batch', async () => {
    const c = await connect('contacts-history')
    c.socket.emit('messaging-history.set', {
      chats: [], messages: [], progress: 50,
      contacts: [{ id: DM_PN, notify: 'Bo Push' }],
      lidPnMappings: [],
    })
    await flush(20)
    expect(await c.listContacts()).toEqual([
      { externalId: DM_PN, displayName: 'Bo Push', phone: '+15551230000' },
    ])
    await c.close()
  })

  it('files a LID-only contact under the phone JID once the mapping is known', async () => {
    const c = await connect('contacts-lid')
    c.socket.emit('messaging-history.set', {
      chats: [], messages: [], progress: 50,
      contacts: [{ id: DM_LID, name: 'Bo Saved' }],
      lidPnMappings: [{ lid: DM_LID, pn: DM_PN }],
    })
    await flush(20)
    expect(await c.listContacts()).toEqual([
      { externalId: DM_PN, displayName: 'Bo Saved', phone: '+15551230000' },
    ])
    await c.close()
  })

  // The same deferral across two events, which is how WhatsApp actually sends
  // it: contacts.upsert names a LID, and the mapping that turns it into a
  // number arrives in its own event later. Holding the name until then is the
  // difference between a contact and a contact silently dropped.
  it('files a LID-only contact when its mapping arrives in a later event', async () => {
    const c = await connect('contacts-lid-later')
    c.socket.emit('contacts.upsert', [{ id: DM_LID, name: 'Bo Saved' }])
    await flush(20)
    // Nothing to show yet: a LID is an identity with no number behind it.
    expect(await c.listContacts()).toEqual([])

    c.socket.emit('messaging-history.set', {
      chats: [], messages: [], progress: 100,
      contacts: [],
      lidPnMappings: [{ lid: DM_LID, pn: DM_PN }],
    })
    await flush(20)
    expect(await c.listContacts()).toEqual([
      { externalId: DM_PN, displayName: 'Bo Saved', phone: '+15551230000' },
    ])
    await c.close()
  })

  it('lists neither a nameless contact nor a LID whose mapping never arrives', async () => {
    // Both would be an identity the address book could show nothing for: a
    // nameless row, or a LID it cannot match a phone number to.
    const c = await connect('contacts-skipped')
    c.socket.emit('contacts.upsert', [{ id: DM_PN }, { id: '5544332211@lid', name: 'Unknown' }])
    await flush(20)
    expect(await c.listContacts()).toEqual([])
    await c.close()
  })

  it('is empty before any contact arrives', async () => {
    const c = await connect('contacts-empty')
    expect(await c.listContacts()).toEqual([])
    await c.close()
  })
})
