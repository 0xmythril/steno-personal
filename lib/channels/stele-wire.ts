import { z } from 'zod'
// Stele v1 wire subset, independently validated at this consumer's network edge.
const id = z.string().min(1).max(1024)
export const stateSchema = z.object({ sourceId: id, accountId: id, cursor: id.nullable() })
export type SteleState = z.infer<typeof stateSchema>
export const statusSchema = z.object({ sourceId: id.nullable(), session: z.string().max(40), capture: z.string().max(40), readable: z.boolean(), reason: z.string().max(80).nullable(), capabilities: z.object({ text: z.boolean(), contacts: z.boolean(), recalls: z.boolean() }) })
export const chatSchema = z.object({ id, revision: z.number().int().positive(), kind: z.enum(['dm', 'group', 'channel']), title: z.string().max(10000) })
export type SteleChat = z.infer<typeof chatSchema>
export const messageSchema = z.object({ id, chatId: id, revision: z.number().int().positive(), sender: z.object({ externalId: id.nullable(), displayName: z.string().max(10000).nullable(), isSelf: z.boolean() }), sentAt: z.iso.datetime(), kind: z.literal('text'), text: z.string().max(1_000_000) })
export type SteleMessage = z.infer<typeof messageSchema>
export const contactSchema = z.object({ externalId: id, displayName: z.string().max(10000).nullable(), remark: z.string().max(10000).nullable(), phone: z.string().max(100).nullable() })
export const loginSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('qr'), qrDataUrl: z.string().max(128 * 1024).regex(/^data:image\/png;base64,[A-Za-z0-9+/=]+$/), expiresAt: z.iso.datetime() }),
  z.object({ type: z.enum(['status', 'phone_confirm']), message: z.string().max(1000) }),
  z.object({ type: z.literal('login_success'), sourceId: id, account: z.object({ externalAccountId: id, displayName: z.string().max(10000).nullable() }) }),
  z.object({ type: z.literal('login_timeout') }),
  z.object({ type: z.literal('error'), error: z.object({ code: z.string().max(80) }) }),
])
export const eventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.enum(['message', 'edit', 'delete']), cursor: id, data: z.object({ chatId: id, messageId: id, revision: z.number().int().positive() }) }),
  z.object({ type: z.enum(['chat', 'contact']), cursor: id, data: z.object({ id, revision: z.number().int().positive() }) }),
  z.object({ type: z.literal('caught_up'), cursor: id }),
  z.object({ type: z.literal('state'), readable: z.boolean() }),
  z.object({ type: z.literal('error'), error: z.object({ code: z.string().max(80) }) }),
])
export type SteleChange = { type: 'chat'; chat: SteleChat } | { type: 'upsert'; chat: SteleChat; message: SteleMessage } | { type: 'delete'; chatId: string; messageId: string }
