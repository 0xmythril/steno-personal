import { beforeEach, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '@/lib/db/client'
import { connections } from '@/lib/db/schema'
import { resetDb } from './helpers/db'
import { createConnection, revokeConnection, submitLoginPassword } from '@/lib/services/connections'
import { makeConnection } from './helpers/fixtures'
import { historyPage } from '@/lib/services/history'
beforeEach(resetDb)
it('records connection creation and revocation once at their actual transitions', async () => {
  const result = await createConnection('telegram'); if (!result.ok) throw Error()
  expect(historyPage({ kind: 'connection' }).events.map(e => e.operation)).toEqual(['source_created'])
  await revokeConnection(result.id, 'Owner disconnected'); await revokeConnection(result.id, 'Repeated request')
  expect(historyPage({ kind: 'connection' }).events.filter(e => e.operation === 'source_revoked')).toHaveLength(1)
})
it('submitting a login password does not claim that a source was revoked', async () => {
  const source = await makeConnection({ status: 'pending' })
  db.update(connections).set({ loginNeedsPassword: true }).where(eq(connections.id, source.id)).run()
  await submitLoginPassword(source.id, 'fictional-password')
  expect(historyPage({ kind: 'connection' }).events).toHaveLength(0)
})
