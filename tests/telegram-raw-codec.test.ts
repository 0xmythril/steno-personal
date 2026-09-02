import { describe, it, expect } from 'vitest'
import { Long } from '@mtcute/node'
import type { tl } from '@mtcute/node'
import { decodeTlRaw, encodeTlRaw } from '@/lib/channels/telegram'

// IncomingMessage.raw goes into a JSON column and comes back out of one, so
// the ONLY thing that matters about the Telegram encoding is that it survives
// JSON.stringify -> JSON.parse byte for byte. The two values that a plain
// `raw: msg.raw` loses on that trip are the ones a download depends on:
// accessHash (a Long, which JSON flattens to {low, high, unsigned}) and
// fileReference (a Uint8Array, which JSON flattens to {"0":1,"1":2,…}).
// No network is involved: this is mtcute's TL codec against a hand-built
// message, exactly as the port stores and reads it.
const ACCESS_HASH = Long.fromString('-6620435977723033911')
const FILE_REFERENCE = new Uint8Array([0x02, 0x00, 0xff, 0x7f, 0x80, 0x41])

function buildMessage(): tl.RawMessage {
  const document: tl.RawDocument = {
    _: 'document',
    id: Long.fromString('5321465789123456789'),
    accessHash: ACCESS_HASH,
    fileReference: FILE_REFERENCE,
    date: 1_756_800_000,
    mimeType: 'audio/ogg',
    size: 4096, // mtcute maps the TL `long` size onto a plain number
    dcId: 2,
    attributes: [{ _: 'documentAttributeAudio', voice: true, duration: 7 }],
  }
  return {
    _: 'message',
    id: 4242,
    peerId: { _: 'peerUser', userId: 777_000 },
    date: 1_756_800_001,
    message: '',
    media: { _: 'messageMediaDocument', document },
  }
}

describe('the Telegram raw codec', () => {
  it('survives the SQLite JSON round trip with its Long and byte-array fields intact', () => {
    const stored = JSON.parse(JSON.stringify(encodeTlRaw(buildMessage()))) as unknown
    const decoded = decodeTlRaw(stored)

    expect(decoded?._).toBe('message')
    const media = (decoded as tl.RawMessage).media
    expect(media?._).toBe('messageMediaDocument')
    const doc = (media as tl.RawMessageMediaDocument).document
    expect(doc?._).toBe('document')
    const got = doc as tl.RawDocument

    // A Long is still a Long, and still the same 64-bit value — not the
    // {low, high, unsigned} object JSON would have left behind.
    expect(Long.isLong(got.accessHash)).toBe(true)
    expect(got.accessHash.toString()).toBe(ACCESS_HASH.toString())
    // The file reference is still bytes, not an integer-keyed object.
    expect(got.fileReference).toBeInstanceOf(Uint8Array)
    expect(Array.from(got.fileReference)).toEqual(Array.from(FILE_REFERENCE))
    expect(got.mimeType).toBe('audio/ogg')
    expect(got.dcId).toBe(2)
  })

  it('is plain JSON — no Long or byte array left in the stored value', () => {
    const encoded = encodeTlRaw(buildMessage())
    expect(Object.keys(encoded)).toEqual(['tl'])
    expect(typeof encoded.tl).toBe('string')
    // Byte-identical after a round trip through the column.
    expect(JSON.parse(JSON.stringify(encoded))).toEqual(encoded)
  })

  it('returns null for a value it did not write, rather than throwing', () => {
    expect(decodeTlRaw(null)).toBeNull()
    expect(decodeTlRaw(undefined)).toBeNull()
    expect(decodeTlRaw({ some: 'other port' })).toBeNull()
    expect(decodeTlRaw('not an object')).toBeNull()
  })
})
