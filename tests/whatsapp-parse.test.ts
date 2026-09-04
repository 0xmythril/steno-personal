import { describe, it, expect } from 'vitest'
import {
  chatKindForJid, hasTrustedMediaSource, parseProtocolEvent, parseWaMessage, phoneFromPnJid,
  resolveContactIdentity, textOf, toIncoming, tsToDate, unwrapContent, WA_MEDIA_HOST,
} from '@/lib/channels/whatsapp-parse'

const GROUP = '12345-67890@g.us'
const DM = '15551230000@s.whatsapp.net'

function groupText(overrides: Record<string, unknown> = {}) {
  return {
    key: { remoteJid: GROUP, id: 'WA1', fromMe: false, participant: '15559990000@s.whatsapp.net' },
    messageTimestamp: 1_700_000_000,
    pushName: 'Ada',
    message: { conversation: 'hello there' },
    ...overrides,
  }
}

describe('chatKindForJid', () => {
  it('maps each suffix', () => {
    expect(chatKindForJid(GROUP)).toBe('group')
    expect(chatKindForJid('12345@newsletter')).toBe('channel')
    expect(chatKindForJid(DM)).toBe('dm')
    expect(chatKindForJid('99999@lid')).toBe('dm')
    expect(chatKindForJid('15551230000@c.us')).toBe('dm')
  })
  it('skips broadcast and the unknown', () => {
    expect(chatKindForJid('status@broadcast')).toBeNull()
    expect(chatKindForJid('12345@broadcast')).toBeNull()
    expect(chatKindForJid('someone@call')).toBeNull()
    expect(chatKindForJid(null)).toBeNull()
    expect(chatKindForJid(undefined)).toBeNull()
  })
})

describe('unwrapContent and textOf', () => {
  it('peels the future-proof wrappers', () => {
    const wrapped = { ephemeralMessage: { message: { viewOnceMessageV2: { message: { conversation: 'inner' } } } } }
    expect(unwrapContent(wrapped)).toEqual({ conversation: 'inner' })
  })
  it('reads conversation, extended text and captions', () => {
    expect(textOf({ conversation: 'a' })).toBe('a')
    expect(textOf({ extendedTextMessage: { text: 'b' } })).toBe('b')
    expect(textOf({ imageMessage: { caption: 'c' } })).toBe('c')
    expect(textOf({ stickerMessage: {} })).toBeNull()
  })
})

describe('tsToDate', () => {
  it('accepts number, string and the Long shape', () => {
    expect(tsToDate(1_700_000_000).getTime()).toBe(1_700_000_000_000)
    expect(tsToDate('1700000000').getTime()).toBe(1_700_000_000_000)
    expect(tsToDate({ low: 1_700_000_000, high: 0 }).getTime()).toBe(1_700_000_000_000)
    expect(tsToDate(undefined).getTime()).toBe(0)
  })
})

describe('identity', () => {
  it('prefers the phone-number JID and keeps the LID as a secondary key', () => {
    const id = resolveContactIdentity({ participant: '999@lid', participantAlt: DM })
    expect(id).toEqual({ jid: DM, lidJid: '999@lid', phone: '+15551230000' })
  })
  it('falls back to the LID when no PN is known', () => {
    expect(resolveContactIdentity({ participant: '999@lid' })).toEqual({ jid: '999@lid', lidJid: '999@lid', phone: null })
  })
  it('returns null with nothing to go on', () => {
    expect(resolveContactIdentity({})).toBeNull()
  })
  it('strips a device suffix from the phone', () => {
    expect(phoneFromPnJid('15551230000:12@s.whatsapp.net')).toBe('+15551230000')
    expect(phoneFromPnJid('not-a-number@s.whatsapp.net')).toBeNull()
  })
})

describe('parseProtocolEvent', () => {
  // Who sent the revoke or edit is carried out with it: WhatsApp cannot check
  // authorship server-side (the payload is end-to-end encrypted), so the
  // archive has to, and it can only do that if the port tells it who acted.
  it('reads a revoke, with the group participant who sent it as the actor', () => {
    const ev = parseProtocolEvent({
      key: { remoteJid: GROUP, id: 'REV', fromMe: false, participant: '15559990000@s.whatsapp.net' },
      messageTimestamp: 1_700_000_500,
      message: { protocolMessage: { type: 0, key: { id: 'WA1' } } },
    })
    expect(ev).toEqual({
      kind: 'delete', remoteJid: GROUP, waId: 'WA1', sentAt: new Date(1_700_000_500_000),
      fromOwner: false, actor: { jid: '15559990000@s.whatsapp.net', lidJid: null, phone: '+15559990000' },
    })
  })
  it('reads an edit wrapped in editedMessage, with the actor', () => {
    const ev = parseProtocolEvent({
      key: { remoteJid: GROUP, id: 'ED', fromMe: false, participant: '15559990000@s.whatsapp.net' },
      messageTimestamp: 1_700_000_600,
      message: { editedMessage: { message: { protocolMessage: { type: 14, key: { id: 'WA1' }, editedMessage: { conversation: 'fixed' } } } } },
    })
    expect(ev).toEqual({
      kind: 'edit', remoteJid: GROUP, waId: 'WA1', newText: 'fixed',
      fromOwner: false, actor: { jid: '15559990000@s.whatsapp.net', lidJid: null, phone: '+15559990000' },
    })
  })
  it('takes the actor of a DM revoke from the remote JID, and none from the owner', () => {
    const contact = parseProtocolEvent({
      key: { remoteJid: DM, id: 'REV', fromMe: false },
      messageTimestamp: 1_700_000_500,
      message: { protocolMessage: { type: 0, key: { id: 'WA1' } } },
    })
    expect(contact).toMatchObject({ kind: 'delete', fromOwner: false, actor: { jid: DM, phone: '+15551230000' } })
    const own = parseProtocolEvent({
      key: { remoteJid: DM, id: 'REV2', fromMe: true },
      messageTimestamp: 1_700_000_500,
      message: { protocolMessage: { type: 0, key: { id: 'WA2' } } },
    })
    expect(own).toMatchObject({ kind: 'delete', fromOwner: true, actor: null })
  })
  it('reads the actor of a history-replayed revoke from the top level', () => {
    const ev = parseProtocolEvent({
      key: { remoteJid: GROUP, id: 'REV', fromMe: false },
      participant: '15559990000@s.whatsapp.net',
      messageTimestamp: 1_700_000_500,
      message: { protocolMessage: { type: 0, key: { id: 'WA1' } } },
    })
    expect(ev).toMatchObject({ fromOwner: false, actor: { jid: '15559990000@s.whatsapp.net' } })
  })
  it('ignores ordinary content and unknown protocol types', () => {
    expect(parseProtocolEvent(groupText())).toBeNull()
    expect(parseProtocolEvent({ key: { remoteJid: GROUP, id: 'X' }, message: { protocolMessage: { type: 3, key: { id: 'W' } } } })).toBeNull()
  })
})

describe('parseWaMessage', () => {
  it('parses a group text message', () => {
    const p = parseWaMessage(groupText())!
    expect(p.remoteJid).toBe(GROUP)
    expect(p.chatKind).toBe('group')
    expect(p.waId).toBe('WA1')
    expect(p.type).toBe('text')
    expect(p.text).toBe('hello there')
    expect(p.fromOwner).toBe(false)
    expect(p.senderName).toBe('Ada')
    expect(p.sender?.jid).toBe('15559990000@s.whatsapp.net')
    expect(p.sentAt).toEqual(new Date(1_700_000_000_000))
    expect(p.media).toBeNull()
  })

  it('takes the sender of a DM from the remote JID, and none from an own message', () => {
    const inbound = parseWaMessage({ ...groupText(), key: { remoteJid: DM, id: 'D1', fromMe: false } })!
    expect(inbound.chatKind).toBe('dm')
    expect(inbound.sender?.jid).toBe(DM)
    const own = parseWaMessage({ ...groupText(), key: { remoteJid: DM, id: 'D2', fromMe: true } })!
    expect(own.fromOwner).toBe(true)
    expect(own.sender).toBeNull()
  })

  it('reads the sender of a history message from the top level', () => {
    const p = parseWaMessage({
      key: { remoteJid: GROUP, id: 'H1', fromMe: false },
      participant: '15558880000@s.whatsapp.net',
      messageTimestamp: 1_700_000_000,
      message: { conversation: 'from history' },
    })!
    expect(p.sender?.jid).toBe('15558880000@s.whatsapp.net')
  })

  it('parses a voice note with its media metadata', () => {
    const p = parseWaMessage(groupText({
      message: { audioMessage: { mimetype: 'audio/ogg; codecs=opus', ptt: true, seconds: 7, fileLength: { low: 4096, high: 0 } } },
    }))!
    expect(p.type).toBe('audio')
    expect(p.media).toEqual({ mimeType: 'audio/ogg; codecs=opus', sizeBytes: 4096, isVoiceNote: true, durationSeconds: 7 })
  })

  it('parses an image caption and its size', () => {
    const p = parseWaMessage(groupText({ message: { imageMessage: { mimetype: 'image/jpeg', caption: 'a cat', fileLength: '2048' } } }))!
    expect(p.type).toBe('image')
    expect(p.text).toBe('a cat')
    expect(p.media).toEqual({ mimeType: 'image/jpeg', sizeBytes: 2048, isVoiceNote: null, durationSeconds: null })
  })

  it('unwraps a view-once image', () => {
    const p = parseWaMessage(groupText({ message: { viewOnceMessageV2: { message: { imageMessage: { mimetype: 'image/jpeg' } } } } }))!
    expect(p.type).toBe('image')
  })

  it('skips broadcast, protocol and id-less messages', () => {
    expect(parseWaMessage(groupText({ key: { remoteJid: 'status@broadcast', id: 'S1' } }))).toBeNull()
    expect(parseWaMessage(groupText({ message: { protocolMessage: { type: 3, key: { id: 'x' } } } }))).toBeNull()
    expect(parseWaMessage(groupText({ key: { remoteJid: GROUP } }))).toBeNull()
  })

  it('marks a stub message as system and anything else as unknown', () => {
    expect(parseWaMessage(groupText({ message: {}, messageStubType: 27 }))!.type).toBe('system')
    // A poll used to be the example here; it has a type of its own now.
    expect(parseWaMessage(groupText({ message: { someFutureMessage: {} } }))!.type).toBe('unknown')
  })

  it('rejects an absurd audio duration rather than trusting it', () => {
    const p = parseWaMessage(groupText({ message: { audioMessage: { mimetype: 'audio/ogg', ptt: false, seconds: 2 ** 31 } } }))!
    expect(p.media).toEqual({ mimeType: 'audio/ogg', sizeBytes: null, isVoiceNote: false, durationSeconds: null })
  })
})

describe('content that used to be unknown', () => {
  it('a reaction is its emoji', () => {
    const p = parseWaMessage(groupText({ message: { reactionMessage: { key: { id: 'WA0' }, text: '👍' } } }))!
    expect(p).toMatchObject({ type: 'reaction', text: '👍', media: null })
    // A removed reaction has empty text; it is still a reaction, with nothing to say.
    expect(parseWaMessage(groupText({ message: { reactionMessage: { key: { id: 'WA0' }, text: '' } } }))!)
      .toMatchObject({ type: 'reaction', text: null })
  })
  it('a poll is its question and its options, one per line', () => {
    const p = parseWaMessage(groupText({ message: { pollCreationMessageV3: { name: 'Lunch?', options: [{ optionName: 'Yes' }, { optionName: 'No' }] } } }))!
    expect(p).toMatchObject({ type: 'poll', text: 'Lunch?\nYes\nNo', media: null })
    expect(parseWaMessage(groupText({ message: { pollCreationMessage: { name: 'Old shape' } } }))!)
      .toMatchObject({ type: 'poll', text: 'Old shape' })
  })
  it('a location is its name or address, else its coordinates', () => {
    expect(parseWaMessage(groupText({ message: { locationMessage: { degreesLatitude: 22.2819, degreesLongitude: 114.1583, name: 'IFC' } } }))!)
      .toMatchObject({ type: 'location', text: 'IFC' })
    expect(parseWaMessage(groupText({ message: { locationMessage: { degreesLatitude: 22.2819, degreesLongitude: 114.1583, address: '8 Finance St' } } }))!)
      .toMatchObject({ type: 'location', text: '8 Finance St' })
    expect(parseWaMessage(groupText({ message: { liveLocationMessage: { degreesLatitude: 22.2819, degreesLongitude: 114.1583 } } }))!)
      .toMatchObject({ type: 'location', text: '22.28190, 114.15830' })
  })
  it('a contact card is its display name, never its vcard', () => {
    expect(parseWaMessage(groupText({ message: { contactMessage: { displayName: 'Ada L', vcard: 'BEGIN:VCARD\nTEL:+15551230000' } } }))!)
      .toMatchObject({ type: 'contact', text: 'Ada L' })
    const nameless = parseWaMessage(groupText({ message: { contactMessage: { vcard: 'BEGIN:VCARD\nTEL:+15551230000' } } }))!
    expect(nameless).toMatchObject({ type: 'contact', text: null })
    expect(parseWaMessage(groupText({ message: { contactsArrayMessage: { displayName: 'Team', contacts: [{}, {}] } } }))!)
      .toMatchObject({ type: 'contact', text: 'Team (2 contacts)' })
    expect(parseWaMessage(groupText({ message: { contactsArrayMessage: { contacts: [{}] } } }))!)
      .toMatchObject({ type: 'contact', text: '1 contact' })
  })
  it('anything else is still unknown, with no text', () => {
    expect(parseWaMessage(groupText({ message: { someFutureMessage: {} } }))!).toMatchObject({ type: 'unknown', text: null })
  })
})

describe('toIncoming', () => {
  it('builds the shared DTO, letting the context override the ids', () => {
    const p = parseWaMessage(groupText())!
    const m = toIncoming(p, { chatTitle: 'Team', externalChatId: GROUP, senderExternalId: '15559990000@s.whatsapp.net' })
    expect(m).toEqual({
      externalChatId: GROUP,
      chatKind: 'group',
      chatTitle: 'Team',
      externalMessageId: 'WA1',
      senderExternalId: '15559990000@s.whatsapp.net',
      senderName: 'Ada',
      fromOwner: false,
      sentAt: new Date(1_700_000_000_000),
      type: 'text',
      text: 'hello there',
      media: null,
      raw: p.raw,
    })
  })
})

// The media URL inside a message is written by whoever sent the message, and
// Baileys fetches whatever host it names. The archive only ever downloads
// from WhatsApp's own CDN, by direct path, so a crafted message cannot point
// the worker at a host of the sender's choosing.
describe('hasTrustedMediaSource', () => {
  const image = (node: Record<string, unknown>) => ({
    key: { remoteJid: GROUP, id: 'IMG', fromMe: false },
    message: { imageMessage: { mimetype: 'image/jpeg', mediaKey: 'AQID', ...node } },
  })
  it('accepts a direct path with WhatsApp’s own CDN URL, or with no URL at all', () => {
    expect(hasTrustedMediaSource(image({ directPath: '/v/t62.7118-24/abc', url: `https://${WA_MEDIA_HOST}/v/t62.7118-24/abc?ccb=11-4` }))).toBe(true)
    expect(hasTrustedMediaSource(image({ directPath: '/v/t62.7118-24/abc' }))).toBe(true)
  })
  it('rejects a URL on any other host or scheme', () => {
    expect(hasTrustedMediaSource(image({ directPath: '/v/x', url: 'http://127.0.0.1:3000/media/x' }))).toBe(false)
    expect(hasTrustedMediaSource(image({ directPath: '/v/x', url: 'https://attacker.example/beacon' }))).toBe(false)
    expect(hasTrustedMediaSource(image({ directPath: '/v/x', url: `http://${WA_MEDIA_HOST}/v/x` }))).toBe(false)
    expect(hasTrustedMediaSource(image({ directPath: '/v/x', url: `https://${WA_MEDIA_HOST}.attacker.example/v/x` }))).toBe(false)
    expect(hasTrustedMediaSource(image({ directPath: '/v/x', url: 'not a url' }))).toBe(false)
  })
  it('rejects a message with no direct path — the URL alone is the sender’s word', () => {
    expect(hasTrustedMediaSource(image({ url: `https://${WA_MEDIA_HOST}/v/x` }))).toBe(false)
    expect(hasTrustedMediaSource(image({}))).toBe(false)
  })
  it('looks through the future-proof wrappers and rejects a message with no media', () => {
    const wrapped = { key: { remoteJid: GROUP, id: 'V' }, message: { viewOnceMessage: { message: { imageMessage: { directPath: '/v/x' } } } } }
    expect(hasTrustedMediaSource(wrapped)).toBe(true)
    expect(hasTrustedMediaSource(groupText())).toBe(false)
    expect(hasTrustedMediaSource(null)).toBe(false)
  })
})
