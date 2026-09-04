import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { db } from '@/lib/db/client'
import { chats, connections, messages } from '@/lib/db/schema'

type Channel = 'telegram' | 'whatsapp'

// One live connection per channel is enforced by the partial unique index
// `connections_live_channel`, so a test that wants two live ones must use
// two different channels.
export async function seedConnection(opts: {
  channel?: Channel
  displayName?: string | null
  status?: 'pending' | 'active' | 'revoked' | 'error'
  externalAccountId?: string
} = {}): Promise<string> {
  const id = randomUUID()
  const status = opts.status ?? 'active'
  await db.insert(connections).values({
    id,
    channel: opts.channel ?? 'telegram',
    status,
    externalAccountId: opts.externalAccountId ?? `acct-${id.slice(0, 8)}`,
    displayName: opts.displayName === undefined ? 'Test Account' : opts.displayName,
    revokedAt: status === 'revoked' ? new Date() : null,
  })
  return id
}

export async function seedChat(connectionId: string, opts: {
  channel?: Channel
  title?: string | null
  kind?: 'dm' | 'group' | 'channel'
  externalChatId?: string
} = {}): Promise<string> {
  const id = randomUUID()
  await db.insert(chats).values({
    id,
    connectionId,
    channel: opts.channel ?? 'telegram',
    externalChatId: opts.externalChatId ?? `x-${id.slice(0, 8)}`,
    kind: opts.kind ?? 'dm',
    title: opts.title === undefined ? 'Mum' : opts.title,
    lastMessageAt: null,
  })
  return id
}

export async function seedMessage(chatId: string, opts: {
  text?: string | null
  sentAt?: Date
  senderName?: string | null
  senderExternalId?: string
  fromOwner?: boolean
  deletedAt?: Date | null
  type?: 'text' | 'image' | 'video' | 'audio' | 'document' | 'sticker' | 'reaction' | 'poll' | 'location' | 'contact' | 'system' | 'unknown'
} = {}): Promise<string> {
  const id = randomUUID()
  const sentAt = opts.sentAt ?? new Date()
  await db.insert(messages).values({
    id,
    chatId,
    externalMessageId: `m-${id.slice(0, 8)}`,
    // '' means "no sender id", the shape of an owner's own direct message.
    senderExternalId: opts.senderExternalId === '' ? null : opts.senderExternalId ?? 'sender-1',
    senderName: opts.senderName === undefined ? 'Mum' : opts.senderName,
    fromOwner: opts.fromOwner ?? false,
    sentAt,
    type: opts.type ?? 'text',
    text: opts.text === undefined ? 'hello' : opts.text,
    deletedAt: opts.deletedAt ?? null,
    raw: {},
  })
  await db.update(chats).set({ lastMessageAt: sentAt }).where(eq(chats.id, chatId))
  return id
}
