import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { db } from '@/lib/db/client'
import { media } from '@/lib/db/schema'
import { resetDb } from './helpers/db'
import { makeConnection, makeChat, makeMessage, makeMedia } from './helpers/media-fixtures'
import { SessionManager } from '@/lib/channels/session-manager'
import { FakePort } from '@/lib/channels/fake-port'
import type { Channel, ChannelPort } from '@/lib/channels/port'
import { mediaFilePath, processPendingMedia, type MediaDrainSummary } from '@/lib/services/media'
import { buildDrains, singleFlight } from '@/worker/drains'

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

// The scheduling itself, with every dependency injected: no process, no
// signal, no real timer. Until this existed nothing exercised the wiring —
// not the single-flight that is the only guard against double-billing the
// analysis drain, not the post-productive-pass kick, not the stop check.
describe('buildDrains', () => {
  const noMedia: MediaDrainSummary = { done: 0, failed: 0, skipped: 0 }
  const off = { ran: false as const, reason: 'no_key' as const }
  const idleAnalysis = { ran: false as const, image: off, audio: off }

  // A promise a test resolves by hand, so two calls can genuinely overlap.
  function deferred<T>() {
    let resolve!: (v: T) => void
    const promise = new Promise<T>(r => { resolve = r })
    return { promise, resolve }
  }

  it('runs the analysis drain once for two overlapping calls', async () => {
    let calls = 0
    const gate = deferred<typeof idleAnalysis>()
    const { drainAnalysis } = buildDrains({
      downloaders: () => new Map(),
      runMediaAnalysis: () => { calls++; return gate.promise },
      // Zero interval: the interval gate is not what is under test here, the
      // single-flight is. With a real interval the second call would return at
      // the interval check and never reach it.
      analysisIntervalMs: 0,
    })

    const first = drainAnalysis()
    const second = drainAnalysis()
    expect(calls).toBe(1)
    gate.resolve(idleAnalysis)
    await Promise.all([first, second])
    expect(calls).toBe(1)

    // The in-flight promise is cleared, so a later call is a new pass.
    await drainAnalysis()
    expect(calls).toBe(2)
  })

  it('singleFlight joins, then releases', async () => {
    let calls = 0
    const gate = deferred<number>()
    const once = singleFlight(() => { calls++; return gate.promise })
    const a = once()
    const b = once()
    expect(calls).toBe(1)
    gate.resolve(7)
    expect(await a).toBe(7)
    expect(await b).toBe(7)
    expect(calls).toBe(1)
  })

  it('waits out the interval, then runs immediately after a productive media pass', async () => {
    let analyses = 0
    let downloaded = 0
    const clock = 1_000_000
    const { drainMedia, drainAnalysis } = buildDrains({
      downloaders: () => new Map(),
      processPendingMedia: async () => ({ ...noMedia, done: downloaded }),
      runMediaAnalysis: async () => { analyses++; return idleAnalysis },
      now: () => clock,
      analysisIntervalMs: 60_000,
    })

    await drainAnalysis()
    expect(analyses).toBe(1)
    // Inside the interval: a no-op, so a tick every 3 s does not bill every 3 s.
    await drainAnalysis()
    expect(analyses).toBe(1)

    // A media pass that downloaded nothing changes nothing.
    downloaded = 0
    await drainMedia()
    await drainAnalysis()
    expect(analyses).toBe(1)

    // A pass that actually landed bytes makes the next analysis due now, so a
    // new image becomes searchable in one provider call rather than in five
    // minutes.
    downloaded = 1
    await drainMedia()
    await drainAnalysis()
    expect(analyses).toBe(2)
  })

  it('starts nothing once the worker is stopping', async () => {
    let analyses = 0
    let mediaPasses = 0
    let stopping = false
    const { drainMedia, drainAnalysis } = buildDrains({
      downloaders: () => new Map(),
      stopping: () => stopping,
      processPendingMedia: async () => { mediaPasses++; return noMedia },
      runMediaAnalysis: async () => { analyses++; return idleAnalysis },
      analysisIntervalMs: 0,
    })

    await drainMedia()
    await drainAnalysis()
    expect([mediaPasses, analyses]).toEqual([1, 1])

    // A signal arrived: starting either drain now would only delay stopAll().
    stopping = true
    await drainMedia()
    await drainAnalysis()
    expect([mediaPasses, analyses]).toEqual([1, 1])
  })
})
