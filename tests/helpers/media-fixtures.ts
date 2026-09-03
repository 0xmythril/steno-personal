import { db } from '@/lib/db/client'
import { connections, chats, messages, media } from '@/lib/db/schema'
import { encryptSecret } from '@/lib/services/crypto'

// Row builders shared by every M4 suite. Deliberately thin: they insert the
// minimum a media test needs and return the row, so a test that cares about a
// column sets it explicitly instead of reading it out of a helper.

// An 'active' row without a session ciphertext is a row SessionManager skips
// (M1's reconcileActive treats a missing session as corrupt and leaves it
// alone), so the default matches what M1's tests/helpers/fixtures.ts produces:
// a decryptable placeholder. Pass null for the corrupt-row case.
export async function makeConnection(
  channel: 'telegram' | 'whatsapp' = 'telegram',
  sessionCiphertext: string | null = encryptSecret('S'),
) {
  const [row] = await db.insert(connections).values({
    channel, status: 'active', externalAccountId: `acct-${channel}`, displayName: 'Owner',
    sessionCiphertext,
  }).returning()
  return row
}

export async function makeChat(connectionId: string, channel: 'telegram' | 'whatsapp' = 'telegram') {
  const [row] = await db.insert(chats).values({
    connectionId, channel, externalChatId: `chat-${Math.random()}`, kind: 'group', title: 'A group',
  }).returning()
  return row
}

export async function makeMessage(chatId: string, opts: {
  type?: 'text' | 'image' | 'audio' | 'video' | 'document' | 'sticker'
  text?: string | null; raw?: unknown; sentAt?: Date; deletedAt?: Date | null
} = {}) {
  const [row] = await db.insert(messages).values({
    chatId, externalMessageId: `msg-${Math.random()}`,
    sentAt: opts.sentAt ?? new Date(), type: opts.type ?? 'image',
    text: opts.text ?? null, hasMedia: (opts.type ?? 'image') !== 'text',
    deletedAt: opts.deletedAt ?? null,
    raw: opts.raw ?? { id: 'raw' },
  }).returning()
  return row
}

export async function makeMedia(messageId: string, connectionId: string, values: Partial<{
  mimeType: string | null; sizeBytes: number | null; storagePath: string | null
  status: 'pending' | 'done' | 'failed'; isVoiceNote: boolean | null; durationSeconds: number | null
}> = {}) {
  const [row] = await db.insert(media).values({ messageId, connectionId, ...values }).returning()
  return row
}

// One connection + one chat + one message + one media row, the shape almost
// every test starts from.
export async function makeAttachment(opts: Parameters<typeof makeMedia>[2] & {
  type?: 'image' | 'audio' | 'document'; text?: string | null
} = {}) {
  const { type, text, ...mediaValues } = opts
  const connection = await makeConnection()
  const chat = await makeChat(connection.id)
  const message = await makeMessage(chat.id, { type: type ?? 'image', text: text ?? null })
  const md = await makeMedia(message.id, connection.id, mediaValues)
  return { connection, chat, message, media: md }
}
