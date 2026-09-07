import { describe, it, expect, beforeEach } from 'vitest'
import { resetDb } from './helpers/db'
import { mintAccessKey, verifyAccessKey, revokeAccessKeyAndPurge, messagesPushedByKey } from '@/lib/services/access-keys'
import { importBatch, parseBatch, FORMAT } from '@/lib/services/import'
import { listSources } from '@/lib/services/connections'
import { searchMessages } from '@/lib/services/queries'
import { db } from '@/lib/db/client'
import { messages } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'

async function pushKey(label: string): Promise<{ id: string; raw: string }> {
  const r = await mintAccessKey(label, { read: false, push: true })
  if (!r.ok) throw new Error(r.reason)
  return { id: r.id, raw: r.rawKey }
}

const message = (over: Record<string, unknown> = {}) => ({
  externalChatId: 'C01', chatKind: 'group', chatTitle: '#eng', externalMessageId: 'm1',
  senderExternalId: 'U01', senderName: 'Ada', fromOwner: false, sentAt: '2026-09-05T10:00:00Z',
  type: 'text', text: 'the vendor agreed to net 30', ...over,
})

const batch = (over: Record<string, unknown> = {}): unknown => ({
  format: FORMAT,
  source: { type: 'slack', id: 'shared', label: 'Shared' },
  messages: [message()],
  ...over,
})

function parsed(input: unknown) {
  const r = parseBatch(input)
  if (!r.ok) throw new Error(JSON.stringify(r.problems))
  return r.batch
}

describe('revokeAccessKeyAndPurge', () => {
  beforeEach(resetDb)

  it("removes only the revoked key's messages, keeps a source another key still feeds, and deletes a source it fed alone", async () => {
    const keyA = await pushKey('keyA')
    const keyB = await pushKey('keyB')

    // keyB creates the shared source and keyA also pushes into it. keyB's
    // creator credit is unconditional (listSources.createdBy), so purging
    // keyA must not disturb it; keyA's own credit is a live-message tally
    // and must drop once its messages here are gone.
    const shared = await importBatch(keyB.id, parsed(batch({
      messages: [message({ externalMessageId: 'b1', text: 'keyB shared text' })],
    })))
    await importBatch(keyA.id, parsed(batch({
      messages: [message({ externalMessageId: 'a1', text: 'keyA shared text' })],
    })))
    const sharedSourceId = shared.source.id

    // keyA alone feeds a second, solo source.
    const solo = await importBatch(keyA.id, parsed(batch({
      source: { type: 'slack', id: 'solo', label: 'Solo' },
      messages: [message({ externalChatId: 'C02', externalMessageId: 'a2', text: 'keyA solo text' })],
    })))
    const soloSourceId = solo.source.id

    expect(await messagesPushedByKey(keyA.id)).toBe(2)

    const result = await revokeAccessKeyAndPurge(keyA.id)
    expect(result).toEqual({ revoked: true, messagesDeleted: 2, sourcesDeleted: 1 })

    // keyA can no longer push.
    expect(await verifyAccessKey(keyA.raw, 'push')).toBeNull()

    // The shared source survives, holding only keyB's message.
    const sources = await listSources()
    expect(sources.find(s => s.id === sharedSourceId)).toMatchObject({ messageCount: 1, pushedBy: ['keyB'] })

    // The solo source, fed only by keyA, is gone entirely.
    expect(sources.find(s => s.id === soloSourceId)).toBeUndefined()

    // keyA's text is no longer findable anywhere, including in the surviving source.
    expect((await searchMessages('keyA shared text')).hits).toEqual([])
    expect((await searchMessages('keyA solo text')).hits).toEqual([])
    expect((await searchMessages('keyB shared text')).hits).toHaveLength(1)
  })

  it('is a no-op on messages and sources when the key never pushed anything', async () => {
    const key = await pushKey('lonely')
    const result = await revokeAccessKeyAndPurge(key.id)
    expect(result).toEqual({ revoked: true, messagesDeleted: 0, sourcesDeleted: 0 })
    expect(await verifyAccessKey(key.raw, 'push')).toBeNull()
  })

  it("never touches a source a different key registered, even one still empty of messages", async () => {
    const keyA = await pushKey('keyA')
    const keyB = await pushKey('keyB')

    // keyA pushes into its own source with a real message.
    await importBatch(keyA.id, parsed(batch({
      source: { type: 'slack', id: 'a-source', label: 'A source' },
      messages: [message({ externalMessageId: 'a1', text: 'keyA text' })],
    })))

    // keyB registers a source but has not pushed any message into it yet —
    // a batch may carry {format, source} with no messages, which is how an
    // empty source exists.
    const bSource = await importBatch(keyB.id, parsed(batch({
      source: { type: 'slack', id: 'b-source', label: 'B source' },
      messages: [],
    })))

    const result = await revokeAccessKeyAndPurge(keyA.id)
    expect(result).toEqual({ revoked: true, messagesDeleted: 1, sourcesDeleted: 1 })

    // keyB's still-empty source is untouched collateral-free.
    const sources = await listSources()
    expect(sources.find(s => s.id === bSource.source.id)).toBeDefined()
  })

  it('never resurrects a message someone deleted, even after the pushing key is purged', async () => {
    const keyA = await pushKey('keyA')
    const keyB = await pushKey('keyB')

    const original = batch({
      source: { type: 'slack', id: 'shared', label: 'Shared' },
      messages: [message({ externalMessageId: 'm1', text: 'original text' })],
    })
    await importBatch(keyA.id, parsed(original))

    // The owner deletes the message: a tombstone, not a row removal.
    await importBatch(keyA.id, parsed(batch({
      source: { type: 'slack', id: 'shared', label: 'Shared' },
      messages: [],
      deletes: [{ externalChatId: 'C01', externalMessageId: 'm1' }],
    })))
    expect((await searchMessages('original text')).hits).toEqual([])

    // Purging keyA must not remove the tombstone: it is what keeps the
    // deletion enforced.
    const result = await revokeAccessKeyAndPurge(keyA.id)
    expect(result.messagesDeleted).toBe(0)
    const [tombstone] = await db.select({ deletedAt: messages.deletedAt })
      .from(messages).where(eq(messages.externalMessageId, 'm1'))
    expect(tombstone).toBeDefined()
    expect(tombstone!.deletedAt).not.toBeNull()

    // A later push of the exact same batch, under a different key, must not
    // bring the message back.
    await importBatch(keyB.id, parsed(original))
    expect((await searchMessages('original text')).hits).toEqual([])
    const [stillTombstoned] = await db.select({ deletedAt: messages.deletedAt })
      .from(messages).where(eq(messages.externalMessageId, 'm1'))
    expect(stillTombstoned).toBeDefined()
    expect(stillTombstoned!.deletedAt).not.toBeNull()
  })
})

// A tombstone-only source must survive cleanup even when this purge removes
// its final live message; another active key can still resend old history.
it.each(['same key', 'another key'])('preserves %s tombstones when purging the last live message', async (owner) => {
  await resetDb()
  const a = await pushKey('A'), b = await pushKey('B')
  const tombstoneKey = owner === 'same key' ? a.id : b.id
  const original = parsed(batch({ messages: [message({ externalMessageId: 'deleted', text: 'deletedmessage' })] }))
  const source = await importBatch(tombstoneKey, original)
  await importBatch(tombstoneKey, parsed(batch({ messages: [], deletes: [{ externalChatId: 'C01', externalMessageId: 'deleted' }] })))
  await importBatch(a.id, parsed(batch({ messages: [message({ externalMessageId: 'live' })] })))

  expect(await revokeAccessKeyAndPurge(a.id)).toEqual({ revoked: true, messagesDeleted: 1, sourcesDeleted: 0 })
  expect((await listSources()).find(s => s.id === source.source.id)).toMatchObject({ messageCount: 0 })
  expect(await importBatch(b.id, original)).toMatchObject({ inserted: 0, duplicates: 1 })
  expect((await searchMessages('deletedmessage')).hits).toHaveLength(0)
})
