import { describe, it, expect, beforeEach } from 'vitest'
import { db } from '@/lib/db/client'
import { accessKeys, connections } from '@/lib/db/schema'
import { resetDb } from './helpers/db'
import { makeConnection } from './helpers/fixtures'
import { isSourceType, isLiveChannel, SOURCE_TYPE_RE } from '@/lib/services/sources'
import { sourceLabel } from '@/lib/format'
import { createConnection, hasActiveConnection, otherSetupClaimExists } from '@/lib/services/connections'

// A pushed source is a connections row the worker never opens: mode 'push',
// any slug as its channel, the pusher's source id as external_account_id.
const pushed = (type: string, id: string) => db.insert(connections).values({
  channel: type, mode: 'push', status: 'active', externalAccountId: id, displayName: `${type} ${id}`,
}).returning({ id: connections.id })

describe('sources in the schema', () => {
  beforeEach(resetDb)

  it('a pushed source may share a channel with a live connection', async () => {
    await makeConnection({ channel: 'telegram' })
    const [row] = await pushed('telegram', 'export-2026')
    expect(row.id).toBeTruthy()
  })

  it('two pushed sources of one type coexist, but one (type, id) is one row', async () => {
    await pushed('slack', 'acme')
    await pushed('slack', 'other')
    await expect(pushed('slack', 'acme')).rejects.toThrow()
  })

  it('still allows exactly one live row per channel', async () => {
    await makeConnection({ channel: 'whatsapp' })
    await expect(makeConnection({ channel: 'whatsapp' })).rejects.toThrow()
  })

  it('a new key is a read key unless told otherwise', async () => {
    const [row] = await db.insert(accessKeys)
      .values({ label: 'k', keyHash: 'h', keyCiphertext: 'c', prefix: 'p' }).returning()
    expect(row.canRead).toBe(true)
    expect(row.canPush).toBe(false)
  })
})

describe('source types', () => {
  it('accepts slugs and the two live channels, rejects everything else', () => {
    for (const ok of ['slack', 'telegram', 'whatsapp', 'chatgpt-work', 'a1', 'x'.repeat(32)]) {
      expect(isSourceType(ok), ok).toBe(true)
    }
    for (const bad of ['', 'S', 'Slack', '1slack', 'sla ck', 'sla_ck', 'x'.repeat(33), 'a', null, 3]) {
      expect(isSourceType(bad), String(bad)).toBe(false)
    }
    expect(SOURCE_TYPE_RE.source).toBe('^[a-z][a-z0-9-]{1,31}$')
  })

  it('knows which types the worker can open', () => {
    expect(isLiveChannel('telegram')).toBe(true)
    expect(isLiveChannel('whatsapp')).toBe(true)
    expect(isLiveChannel('slack')).toBe(false)
  })

  it('labels a live channel by its proper noun and a pushed type by its slug', () => {
    expect(sourceLabel('whatsapp')).toBe('WhatsApp')
    expect(sourceLabel('slack')).toBe('slack')
    expect(sourceLabel('constructor')).toBe('constructor')
  })
})

describe('a pushed source is not a live claim', () => {
  beforeEach(resetDb)

  it('does not block pairing the same channel live', async () => {
    await pushed('telegram', 'export-2026')
    const r = await createConnection('telegram')
    expect(r.ok).toBe(true)
  })

  it('does not look like somebody else\'s setup claim', async () => {
    await pushed('slack', 'acme')
    expect(await otherSetupClaimExists(null)).toBe(false)
  })

  it('does not count as a connected account', async () => {
    await pushed('slack', 'acme')
    expect(await hasActiveConnection()).toBe(false)
    await makeConnection({ channel: 'whatsapp' })
    expect(await hasActiveConnection()).toBe(true)
  })
})
