import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, expect, it, vi } from 'vitest'
import { db } from '@/lib/db/client'
import { messages } from '@/lib/db/schema'
import { mintAccessKey, revokeAccessKey } from '@/lib/services/access-keys'
import { importBatch, parseBatch } from '@/lib/services/import'
import { updateSettings } from '@/lib/services/settings'
import { resetDb } from './helpers/db'
import DisputePage from '@/app/history/disputes/[id]/page'
import PurgePage from '@/app/history/keys/[id]/page'
import HistoryPage from '@/app/history/page'

vi.stubGlobal('React', React)
vi.mock('@/lib/auth', () => ({ requireSession: async () => ({ via: 'key', label: 'Owner', keyId: null }) }))

beforeEach(resetDb)
async function fixture() {
  const key = await mintAccessKey('Importer', { read: true, push: true })
  if (!key.ok) throw new Error('key creation failed')
  for (const text of ['Stored words', 'Incoming words']) {
    const parsed = parseBatch({ format: 'steno/1', source: { type: 'slack', id: 'studio', label: 'Studio' }, messages: [
      { externalChatId: 'chat', externalMessageId: 'one', chatKind: 'group', sentAt: '2026-09-01T00:00:00Z', text },
    ] })
    if (!parsed.ok) throw new Error('invalid batch')
    await importBatch(key.id, parsed.batch)
  }
  await revokeAccessKey(key.id)
  return { keyId: key.id, messageId: db.select().from(messages).get()!.id }
}

it('keeps History, CSV export and comparisons readable while hiding mutation controls when off', async () => {
  const { keyId, messageId } = await fixture()
  const history = renderToStaticMarkup(await HistoryPage({ searchParams: Promise.resolve({}) }))
  expect(history).toContain('href="/history"')
  expect(history).toContain('Export CSV')
  expect(history).toContain('Studio')
  const dispute = renderToStaticMarkup(await DisputePage({ params: Promise.resolve({ id: messageId }), searchParams: Promise.resolve({}) }))
  expect(dispute).toContain('Stored version')
  expect(dispute).toContain('Incoming version')
  expect(dispute).toContain('Stored')
  expect(dispute).toContain('Incoming')
  expect(dispute).toContain('/settings#advanced-mode')
  expect(dispute).not.toMatch(/Keep stored|Accept incoming|Delete message/)
  const purge = renderToStaticMarkup(await PurgePage({ params: Promise.resolve({ id: keyId }), searchParams: Promise.resolve({}) }))
  expect(purge).toContain('Importer')
  expect(purge).toContain('/settings#advanced-mode')
  expect(purge).not.toContain('Remove contributions')
})

it('reveals resolution and removal controls only while Advanced mode is enabled', async () => {
  const { keyId, messageId } = await fixture()
  for (const enabled of [true, false]) {
    await updateSettings({ advancedMode: enabled })
    const dispute = renderToStaticMarkup(await DisputePage({ params: Promise.resolve({ id: messageId }), searchParams: Promise.resolve({}) }))
    const purge = renderToStaticMarkup(await PurgePage({ params: Promise.resolve({ id: keyId }), searchParams: Promise.resolve({}) }))
    for (const label of ['Keep stored', 'Accept incoming', 'Delete message']) expect(dispute.includes(label)).toBe(enabled)
    expect(purge.includes('Remove contributions')).toBe(enabled)
  }
})
