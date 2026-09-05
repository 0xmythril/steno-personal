import { describe, it, expect, beforeEach } from 'vitest'
import { resetDb } from './helpers/db'
import { makeConnection } from './helpers/fixtures'
import { listConnections } from '@/lib/services/connections'
import { db } from '@/lib/db/client'
import { connections } from '@/lib/db/schema'

async function pushedSource(type: string, id: string) {
  const [row] = await db.insert(connections).values({
    channel: type, mode: 'push', status: 'active', purpose: 'archive',
    externalAccountId: id, displayName: `${type} (${id})`,
  }).returning()
  return row
}

describe('a pushed source is invisible to the connections page', () => {
  beforeEach(resetDb)

  it('is not in the live list, even when its type is a live channel', async () => {
    const live = await makeConnection({ channel: 'whatsapp' })
    await pushedSource('whatsapp', 'export-2026')
    const listed = await listConnections()
    expect(listed.map(c => c.id)).toEqual([live.id])
  })
})
