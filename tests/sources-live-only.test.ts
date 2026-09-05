import { describe, it, expect, beforeEach } from 'vitest'
import { db } from '@/lib/db/client'
import { chats, connections, messages, people } from '@/lib/db/schema'
import { resetDb } from './helpers/db'
import { makeConnection } from './helpers/fixtures'
import { activeConnections, claimPendingLogins } from '@/lib/services/login'
import { knownAccountChannels } from '@/lib/services/recovery'
import { populatePeople } from '@/lib/services/people'
import { listConnections } from '@/lib/services/connections'

async function pushedSource(type: string, id = 'src', status: 'active' | 'pending' = 'active'): Promise<string> {
  const [row] = await db.insert(connections).values({
    channel: type, mode: 'push', status, externalAccountId: id, displayName: `${type} ${id}`,
  }).returning({ id: connections.id })
  return row.id
}

describe('a pushed source is invisible to the worker', () => {
  beforeEach(resetDb)

  it('is never listed as active, even when its type is a live channel', async () => {
    const live = await makeConnection({ channel: 'telegram' })
    await pushedSource('telegram', 'export')
    await pushedSource('slack')
    expect((await activeConnections()).map(c => c.id)).toEqual([live.id])
  })

  it('is never claimed as a pending login', async () => {
    await pushedSource('whatsapp', 'x', 'pending')
    expect(await claimPendingLogins()).toEqual([])
  })

  it('does not make a channel recoverable', async () => {
    await pushedSource('telegram', 'export')
    expect(await knownAccountChannels()).toEqual([])
  })
})

describe('a pushed source is invisible to the address book', () => {
  beforeEach(resetDb)

  it('creates no person from a pushed direct chat or its senders', async () => {
    const source = await pushedSource('whatsapp', 'export')
    const [chat] = await db.insert(chats).values({
      connectionId: source, channel: 'whatsapp', externalChatId: '15550001@s.whatsapp.net', kind: 'dm', title: 'Zed',
    }).returning({ id: chats.id })
    await db.insert(messages).values({
      chatId: chat.id, externalMessageId: '1', senderExternalId: '15550001@s.whatsapp.net', senderName: 'Zed',
      fromOwner: false, sentAt: new Date(), type: 'text', text: 'hi', raw: {},
    })
    await populatePeople()
    const named = await db.select({ name: people.name }).from(people)
    expect(named.map(p => p.name)).not.toContain('Zed')
  })
})

describe('a pushed source is invisible to the connections page', () => {
  beforeEach(resetDb)

  it('is not in the live list, even when its type is a live channel', async () => {
    const live = await makeConnection({ channel: 'whatsapp' })
    await pushedSource('whatsapp', 'export-2026')
    const listed = await listConnections()
    expect(listed.map(c => c.id)).toEqual([live.id])
  })
})
