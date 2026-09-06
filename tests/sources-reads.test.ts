import { describe, it, expect, beforeEach } from 'vitest'
import { resetDb } from './helpers/db'
import { makeConnection, makeChat, addMessage } from './helpers/fixtures'
import { mintAccessKey } from '@/lib/services/access-keys'
import { importBatch, parseBatch, FORMAT } from '@/lib/services/import'
import { listChats, pageChats, getMessages, recentMessages, searchMessages } from '@/lib/services/queries'
import { listSources } from '@/lib/services/connections'

// Provenance reads: who pushed what, and the source filter across the four
// chat/message queries. One shared push source ('slack/acme') fed by two
// keys proves pushers accumulate and sort; a second source ('slack/other')
// proves the source filter actually scopes.

async function pushKey(label: string): Promise<string> {
  const r = await mintAccessKey(label, { read: false, push: true })
  if (!r.ok) throw new Error(r.reason)
  return r.id
}

const message = (over: Record<string, unknown> = {}) => ({
  externalChatId: 'C01', chatKind: 'group', chatTitle: '#eng', externalMessageId: 'm1',
  senderExternalId: 'U01', senderName: 'Ada', fromOwner: false, sentAt: '2026-09-05T10:00:00Z',
  type: 'text', text: 'the vendor agreed to net 30', ...over,
})

const batch = (over: Record<string, unknown> = {}): unknown => ({
  format: FORMAT,
  source: { type: 'slack', id: 'acme', label: 'Slack (Acme)' },
  messages: [message()],
  ...over,
})

function parsed(input: unknown) {
  const r = parseBatch(input)
  if (!r.ok) throw new Error(JSON.stringify(r.problems))
  return r.batch
}

describe('provenance reads and the source filter', () => {
  beforeEach(resetDb)

  it('carries pushers on chats and pushedBy on messages, and scopes every read by sourceId', async () => {
    const cron = await pushKey('cron')
    const agent = await pushKey('agent')

    // Two keys push into the same shared chat in one source.
    const first = await importBatch(cron, parsed(batch({ messages: [message({ externalMessageId: 'm1' })] })))
    await importBatch(agent, parsed(batch({ messages: [message({ externalMessageId: 'm2', text: 'second' })] })))
    const sharedSourceId = first.source.id

    // A second source, fed by cron alone.
    const other = await importBatch(cron, parsed(batch({
      source: { type: 'slack', id: 'other', label: 'Other' },
      messages: [message({ externalChatId: 'C02', externalMessageId: 'm3' })],
    })))
    const otherSourceId = other.source.id

    // A live telegram chat: never pushed, pushers is empty.
    const tg = await makeConnection({ channel: 'telegram' })
    const tgChat = await makeChat(tg, { title: 'Live chat' })
    await addMessage(tgChat, { text: 'hi' })

    const all = await listChats()
    const sharedChat = all.find(c => c.connectionId === sharedSourceId)!
    const otherChat = all.find(c => c.connectionId === otherSourceId)!
    const liveChat = all.find(c => c.id === tgChat.id)!
    expect(sharedChat.pushers).toEqual(['agent', 'cron'])
    expect(otherChat.pushers).toEqual(['cron'])
    expect(liveChat.pushers).toEqual([])

    // listChats scoped by source
    expect((await listChats({ sourceId: sharedSourceId })).map(c => c.id)).toEqual([sharedChat.id])

    // pageChats scoped by source
    const paged = await pageChats({ sourceId: otherSourceId })
    expect(paged.chats.map(c => c.id)).toEqual([otherChat.id])

    // recentMessages scoped by source
    const recent = await recentMessages({ sourceId: sharedSourceId })
    expect(recent.messages.every(m => m.chatId === sharedChat.id)).toBe(true)
    expect(recent.messages).toHaveLength(2)

    // searchMessages scoped by source
    const found = await searchMessages('vendor', { sourceId: sharedSourceId })
    expect(found.hits.every(h => h.chatId === sharedChat.id)).toBe(true)
    expect(found.hits).toHaveLength(1)
    const foundOther = await searchMessages('vendor', { sourceId: otherSourceId })
    expect(foundOther.hits.every(h => h.chatId === otherChat.id)).toBe(true)
    expect(foundOther.hits).toHaveLength(1)
    const notFound = await searchMessages('second', { sourceId: otherSourceId })
    expect(notFound.hits).toEqual([])

    // getMessages carries pushedBy per message: the delivering key's label,
    // null for a live message.
    const transcript = await getMessages(sharedChat.id)
    const byText = new Map(transcript!.messages.map(m => [m.text, m.pushedBy]))
    expect(byText.get('the vendor agreed to net 30')).toBe('cron')
    expect(byText.get('second')).toBe('agent')

    const liveTranscript = await getMessages(tgChat.id)
    expect(liveTranscript!.messages[0].pushedBy).toBeNull()

    // listSources: two pushed sources, sorted pushedBy, createdBy, counts,
    // lastPushAt set, lastImportConflicts 0 until a push disagrees.
    const sources = await listSources()
    expect(sources).toHaveLength(2)
    const shared = sources.find(s => s.id === sharedSourceId)!
    const otherSrc = sources.find(s => s.id === otherSourceId)!
    expect(shared).toMatchObject({
      id: sharedSourceId, channel: 'slack', createdBy: 'cron',
      pushedBy: ['agent', 'cron'], messageCount: 2, lastImportConflicts: 0,
    })
    expect(shared.lastPushAt).toBeInstanceOf(Date)
    expect(otherSrc).toMatchObject({
      id: otherSourceId, createdBy: 'cron', pushedBy: ['cron'], messageCount: 1, lastImportConflicts: 0,
    })

    // A conflicting push updates lastImportConflicts to the last import's count.
    await importBatch(agent, parsed(batch({
      messages: [message({ externalMessageId: 'm1', text: 'a disagreeing rewrite' })],
    })))
    const afterConflict = await listSources()
    expect(afterConflict.find(s => s.id === sharedSourceId)!.lastImportConflicts).toBe(1)
  })
})
