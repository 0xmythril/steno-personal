import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { db } from '@/lib/db/client'
import { media } from '@/lib/db/schema'
import { resetDb } from './helpers/db'
import { makeConnection, makeChat, makeMessage, makeMedia } from './helpers/media-fixtures'
import { SessionManager } from '@/lib/channels/session-manager'
import { FakePort } from '@/lib/channels/fake-port'
import type { Channel, ChannelPort } from '@/lib/channels/port'
import { mediaFilePath, processPendingMedia } from '@/lib/services/media'

describe('SessionManager.downloaders', () => {
  beforeEach(resetDb)

  it('is empty with nothing connected', async () => {
    // Annotated: a bare literal infers Map<string, FakePort>, and Map is
    // invariant in its key, so it is not assignable to Map<Channel, ChannelPort>.
    const mgr = new SessionManager(new Map<Channel, ChannelPort>([['telegram', new FakePort('telegram')]]))
    expect(mgr.downloaders().size).toBe(0)
  })

  it('exposes one downloader per live session, and the drain uses it', async () => {
    const port = new FakePort('telegram')
    port.scriptDownload({ data: Buffer.from('picture-bytes'), mimeType: 'image/png' })
    const connection = await makeConnection('telegram')
    const mgr = new SessionManager(new Map<Channel, ChannelPort>([['telegram', port]]))
    await mgr.tick()
    await mgr.whenIdle()

    const downloaders = mgr.downloaders()
    expect([...downloaders.keys()]).toEqual([connection.id])

    const chat = await makeChat(connection.id)
    const message = await makeMessage(chat.id)
    const md = await makeMedia(message.id, connection.id, { mimeType: 'image/png' })

    expect(await processPendingMedia(downloaders)).toEqual({ done: 1, failed: 0, skipped: 0 })
    const [after] = await db.select().from(media)
    expect(after.status).toBe('done')
    expect(after.storagePath).toBe(`${md.id}.png`)
    expect(readFileSync(mediaFilePath(after.storagePath!)).toString()).toBe('picture-bytes')

    await mgr.stopAll()
    expect(mgr.downloaders().size).toBe(0)
  })
})
