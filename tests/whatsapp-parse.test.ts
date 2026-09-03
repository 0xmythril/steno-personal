import { describe, it, expect } from 'vitest'
import {
  chatKindForJid, parseProtocolEvent, parseWaMessage, phoneFromPnJid,
  resolveContactIdentity, reviveRawMessage, textOf, toIncoming, tsToDate, unwrapContent,
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
  it('reads a revoke', () => {
    const ev = parseProtocolEvent({
      key: { remoteJid: GROUP, id: 'REV', fromMe: false },
      messageTimestamp: 1_700_000_500,
      message: { protocolMessage: { type: 0, key: { id: 'WA1' } } },
    })
    expect(ev).toEqual({ kind: 'delete', remoteJid: GROUP, waId: 'WA1', sentAt: new Date(1_700_000_500_000) })
  })
  it('reads an edit wrapped in editedMessage', () => {
    const ev = parseProtocolEvent({
      key: { remoteJid: GROUP, id: 'ED', fromMe: false },
      messageTimestamp: 1_700_000_600,
      message: { editedMessage: { message: { protocolMessage: { type: 14, key: { id: 'WA1' }, editedMessage: { conversation: 'fixed' } } } } },
    })
    expect(ev).toEqual({ kind: 'edit', remoteJid: GROUP, waId: 'WA1', newText: 'fixed' })
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
    expect(parseWaMessage(groupText({ message: { pollCreationMessage: {} } }))!.type).toBe('unknown')
  })

  it('rejects an absurd audio duration rather than trusting it', () => {
    const p = parseWaMessage(groupText({ message: { audioMessage: { mimetype: 'audio/ogg', ptt: false, seconds: 2 ** 31 } } }))!
    expect(p.media).toEqual({ mimeType: 'audio/ogg', sizeBytes: null, isVoiceNote: false, durationSeconds: null })
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

describe('reviveRawMessage', () => {
  it('turns both JSON buffer shapes back into buffers', () => {
    const revived = reviveRawMessage({
      message: {
        imageMessage: {
          mediaKey: { type: 'Buffer', data: [1, 2, 3] },
          fileSha256: { '0': 9, '1': 8 },
          url: 'https://example.invalid/x',
        },
      },
    }) as { message: { imageMessage: { mediaKey: Buffer; fileSha256: Buffer; url: string } } }
    expect(Buffer.isBuffer(revived.message.imageMessage.mediaKey)).toBe(true)
    expect([...revived.message.imageMessage.mediaKey]).toEqual([1, 2, 3])
    expect([...revived.message.imageMessage.fileSha256]).toEqual([9, 8])
    expect(revived.message.imageMessage.url).toBe('https://example.invalid/x')
  })
})
