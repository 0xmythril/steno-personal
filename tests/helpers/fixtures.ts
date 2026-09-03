import { randomUUID } from 'node:crypto'
import { db } from '@/lib/db/client'
import { connections, chats, messages } from '@/lib/db/schema'

// Only ONE live (revoked_at IS NULL) row per channel exists, so a test that
// wants two connections at once must give the second a different channel or
// revoke the first. That is the product rule, not a fixture limitation.
export async function makeConnection(opts: {
  channel?: 'telegram' | 'whatsapp'
  purpose?: 'archive' | 'recovery'
  status?: 'pending' | 'active' | 'revoked' | 'error'
  externalAccountId?: string
  sessionCiphertext?: string
} = {}) {
  const status = opts.status ?? 'active'
  const [row] = await db.insert(connections).values({
    channel: opts.channel ?? 'telegram',
    purpose: opts.purpose ?? 'archive',
    status,
    externalAccountId: opts.externalAccountId ?? randomUUID(),
    sessionCiphertext: opts.sessionCiphertext,
    // A 'revoked' status without revoked_at is exactly the disagreement the
    // single revoke authority exists to prevent; never manufacture it.
    revokedAt: status === 'revoked' ? new Date() : undefined,
  }).returning()
  return row
}

export async function makeChat(connection: { id: string; channel: 'telegram' | 'whatsapp' }, opts: {
  kind?: 'dm' | 'group' | 'channel'; title?: string | null; externalChatId?: string; lastMessageAt?: Date
} = {}) {
  const [row] = await db.insert(chats).values({
    connectionId: connection.id, channel: connection.channel,
    externalChatId: opts.externalChatId ?? randomUUID(),
    kind: opts.kind ?? 'dm', title: opts.title === undefined ? 'Chat' : opts.title, lastMessageAt: opts.lastMessageAt,
  }).returning()
  return row
}

export async function addMessage(chat: { id: string }, opts: {
  text?: string | null; sentAt?: Date; senderName?: string | null; senderExternalId?: string | null; fromOwner?: boolean
  externalMessageId?: string; deletedAt?: Date; hasMedia?: boolean
  type?: 'text' | 'image' | 'video' | 'audio' | 'document' | 'sticker' | 'system' | 'unknown'
} = {}) {
  const [row] = await db.insert(messages).values({
    chatId: chat.id,
    externalMessageId: opts.externalMessageId ?? randomUUID(),
    senderName: opts.senderName === undefined ? 'Alice' : opts.senderName,
    senderExternalId: opts.senderExternalId ?? null,
    fromOwner: opts.fromOwner ?? false,
    sentAt: opts.sentAt ?? new Date(),
    type: opts.type ?? 'text',
    text: opts.text === undefined ? 'hello' : opts.text,
    hasMedia: opts.hasMedia ?? false,
    deletedAt: opts.deletedAt,
    raw: {},
  }).returning()
  return row
}
