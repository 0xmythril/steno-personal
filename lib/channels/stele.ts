import { z } from 'zod'
import { ChannelError, type ChannelPort, type ChannelSession, type IncomingMessage } from './port'
import { SteleClient, SteleError } from './stele-client'
import { chatSchema, messageSchema, eventSchema, stateSchema, type SteleChat, type SteleMessage, type SteleChange } from './stele-wire'
import { commitSteleChanges, steleState } from '@/lib/services/stele'

const checkpointSchema = z.object({ sourceId: z.string(), cursor: z.string().min(1) })
const MAX_BASELINE = 50_000
export class SteleWechatPort implements ChannelPort {
  readonly channel = 'wechat' as const
  readonly loginManagedExternally = true
  async login(): Promise<never> { throw new ChannelError('Use the owner login panel.', 'other') }
  async open(sessionString: string, opts: { connectionId: string }): Promise<ChannelSession> {
    stateSchema.parse(JSON.parse(sessionString))
    return new SteleSession(opts.connectionId)
  }
}
class SteleSession implements ChannelSession {
  private client = new SteleClient()
  constructor(private connectionId: string) {}
  onMessage(): void {} // This port uses the awaited checkpointed sync method.
  onEdit(): void {}
  onDelete(): void {}
  async *backfill(): AsyncIterable<IncomingMessage> { /* sync owns bootstrap and replay */ }
  async listContacts() { return [] } // Contact/person matching is a separately scoped integration.
  async downloadMedia(): Promise<never> { throw new ChannelError('Media is unavailable.', 'other') }
  async logOut() { await this.close() } // Detach this consumer; leave the shared Stele device linked.
  async close() { this.client.close() }
  async ping() { const status = await this.client.status(); if (!status.readable) throw new SteleError(status.reason ?? undefined) }
  async sync(shouldContinue: () => boolean): Promise<void> {
    let state = steleState(this.connectionId)
    const status = await this.client.status()
    if (!status.readable) throw new SteleError(status.reason ?? undefined)
    if (status.sourceId !== state.sourceId) throw new SteleError('account_mismatch')
    let baseline = state.cursor === null
    const candidate = new Map<string, Extract<SteleChange, { type: 'upsert' }>>()
    const chatCache = new Map<string, SteleChat>()
    const key = (chat: string, message: string) => JSON.stringify([chat, message])
    const active = () => { if (!shouldContinue()) throw new SteleError() }
    const chat = async (id: string) => {
      if (!chatCache.has(id)) chatCache.set(id, await this.client.get(`/v1/chats/${encodeURIComponent(id)}`, chatSchema))
      return chatCache.get(id)!
    }
    const bootstrap = async () => {
      candidate.clear(); chatCache.clear()
      const h = await this.client.get('/v1/checkpoint', checkpointSchema)
      if (h.sourceId !== state.sourceId) throw new SteleError('account_mismatch')
      let pages = 0
      const page = async <T>(path: string, schema: z.ZodType<T>, cursor: string | null, messages = false) => {
        active(); if (++pages > 10_000) throw new SteleError('source_gap')
        const query = new URLSearchParams({ through: h.cursor, limit: '100' }); if (cursor) query.set(messages ? 'before' : 'cursor', cursor)
        const result = await this.client.get(path + '?' + query, z.object({ items: z.array(schema).max(100), nextCursor: z.string().nullable(), through: z.string() }))
        if (result.through !== h.cursor) throw new SteleError('source_gap')
        return result
      }
      let next: string | null = null
      do {
        const chats: { items: SteleChat[]; nextCursor: string | null; through: string } = await page('/v1/chats', chatSchema, next); next = chats.nextCursor
        for (const c of chats.items) {
          chatCache.set(c.id, c); let before: string | null = null
          do {
            const messages: { items: SteleMessage[]; nextCursor: string | null; through: string } = await page(`/v1/chats/${encodeURIComponent(c.id)}/messages`, messageSchema, before, true); before = messages.nextCursor
            for (const message of messages.items) {
              if (message.chatId !== c.id) throw new SteleError('source_gap')
              candidate.set(key(c.id, message.id), { type: 'upsert', chat: c, message })
              if (candidate.size > MAX_BASELINE) throw new SteleError('source_gap')
            }
          } while (before)
        }
      } while (next)
      return h.cursor
    }
    let after = baseline ? await bootstrap() : state.cursor!
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        let caughtUp = false
        for await (const wire of this.client.stream('/v1/events?after=' + encodeURIComponent(after))) {
          active(); const event = eventSchema.parse(wire)
          if (event.type === 'error') throw new SteleError(event.error.code)
          if (event.type === 'state') throw new SteleError()
          if (event.type === 'caught_up') {
            commitSteleChanges(this.connectionId, state, baseline ? [...candidate.values(), ...[...chatCache.values()].map(chat => ({ type: 'chat' as const, chat }))] : [], event.cursor, baseline)
            caughtUp = true; break
          }
          let change: SteleChange | null = null
          if (event.type === 'delete') change = { type: 'delete', chatId: event.data.chatId, messageId: event.data.messageId }
          else if (event.type === 'message' || event.type === 'edit') {
            try {
              const message = await this.client.get(`/v1/chats/${encodeURIComponent(event.data.chatId)}/messages/${encodeURIComponent(event.data.messageId)}`, messageSchema)
              if (message.id !== event.data.messageId || message.chatId !== event.data.chatId) throw new SteleError('source_gap')
              change = { type: 'upsert', chat: await chat(message.chatId), message }
            } catch (error) {
              if (!(error instanceof SteleError) || error.code !== 'gone') throw error
              change = { type: 'delete', chatId: event.data.chatId, messageId: event.data.messageId }
            }
          } else if (event.type === 'chat') {
            const updated = await this.client.get(`/v1/chats/${encodeURIComponent(event.data.id)}`, chatSchema)
            if (updated.id !== event.data.id) throw new SteleError('source_gap')
            chatCache.set(updated.id, updated)
            change = { type: 'chat', chat: updated }
          }
          if (baseline) {
            if (change?.type === 'delete') { candidate.delete(key(change.chatId, change.messageId)); commitSteleChanges(this.connectionId, state, [change], state.cursor, false, false) }
            if (change?.type === 'upsert') {
              const k = key(change.chat.id, change.message.id), previous = candidate.get(k)
              if (!previous || previous.message.revision < change.message.revision) candidate.set(k, change)
              if (candidate.size > MAX_BASELINE) throw new SteleError('source_gap')
            }
          } else {
            commitSteleChanges(this.connectionId, state, change ? [change] : [], event.cursor)
            state = { ...state, cursor: event.cursor }
          }
        }
        if (!caughtUp) throw new SteleError()
        return
      } catch (error) {
        if (error instanceof SteleError && error.code === 'cursor_expired' && attempt === 0) { baseline = true; after = await bootstrap(); continue }
        throw error
      }
    }
  }
}
