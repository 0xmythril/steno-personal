import { expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { sql } from 'drizzle-orm'
import { openDatabase } from '@/lib/db/client'
import { runMigrations } from '@/lib/db/migrate'
import { messages, historyEvents, messageDisputes, historyState } from '@/lib/db/schema'
it('upgrades a PR #7 database without inventing events, candidate text or edit provenance', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'history-upgrade-'))
  const folder = path.join(root, 'migrations'); mkdirSync(path.join(folder, 'meta'), { recursive: true })
  const journal = JSON.parse(readFileSync('drizzle/meta/_journal.json', 'utf8'))
  journal.entries = journal.entries.filter((e: { idx: number }) => e.idx < 14)
  writeFileSync(path.join(folder, 'meta/_journal.json'), JSON.stringify(journal))
  for (const entry of journal.entries) copyFileSync(`drizzle/${entry.tag}.sql`, path.join(folder, `${entry.tag}.sql`))
  const old = openDatabase(path.join(root, 'archive.db'))
  try {
    migrate(old, { migrationsFolder: folder })
    old.run(sql`insert into connections (id,channel,mode,purpose,status,created_at) values ('source','slack','push','archive','active',1)`)
    old.run(sql`insert into chats (id,connection_id,channel,external_chat_id,kind,created_at) values ('chat','source','slack','external','group',1)`)
    old.run(sql`insert into messages (id,chat_id,external_message_id,sent_at,type,text,raw,conflicted_at,edited_at,created_at) values ('message','chat','external',1,'text','kept','{}',2,3,1)`)
    runMigrations(old); runMigrations(old)
    const row = old.select().from(messages).get()!
    expect(row.text).toBe('kept'); expect(row.conflictedAt).not.toBeNull(); expect(row.contentActor).toBeNull(); expect(row.contentKeyId).toBeNull()
    expect(old.select().from(historyEvents).all()).toHaveLength(0); expect(old.select().from(messageDisputes).all()).toHaveLength(0)
    expect(old.select().from(historyState).all()).toHaveLength(1)
  } finally { old.$client.close(); rmSync(root, { recursive: true, force: true }) }
})
