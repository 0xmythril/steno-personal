import { sqliteTable, text } from 'drizzle-orm/sqlite-core'

// A query-only handle on the FTS5 virtual table created by hand in
// drizzle/0001_channels.sql. It deliberately lives OUTSIDE lib/db/schema.ts:
// drizzle-kit reads only that file, and a virtual table it could see is a
// table it would try to CREATE (and diff) as an ordinary one. Nothing writes
// through this handle — the three triggers own every row.
export const searchIndex = sqliteTable('search_index', {
  messageId: text('message_id').notNull(),
  body: text('body').notNull(),
})
