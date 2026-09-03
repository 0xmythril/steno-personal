import { mkdtempSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// Called from tests/setup.ts BEFORE any app module is imported, so lib/env
// and lib/db/client see the temp dir on their first (lazy) access.
export function useTempDataDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'steno-personal-'))
  process.env.DATA_DIR = dir
  process.env.SECRET_KEY = 'test-secret-key-that-is-at-least-32-characters-long'
  return dir
}

export async function resetDb(): Promise<void> {
  const { db } = await import('@/lib/db/client')
  const s = await import('@/lib/db/schema')
  await db.delete(s.mediaAnalysis)
  await db.delete(s.media)
  await db.delete(s.messages)
  await db.delete(s.chats)
  await db.delete(s.channelContacts)
  await db.delete(s.dismissedSuggestions)
  await db.delete(s.personIdentities)
  await db.delete(s.people)
  await db.delete(s.connections)
  await db.delete(s.sessions)
  await db.delete(s.accessKeys)
  await db.update(s.settings).set({
    openrouterKeyCiphertext: null, analyzeImages: false, analyzeAudio: false,
    visionModel: null, transcriptionModel: null,
    telemetryEnabled: true, telemetryInstanceId: null, telemetryLastSentAt: null,
  })
}
