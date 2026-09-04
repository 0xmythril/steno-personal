import { createMcpHandler, withMcpAuth } from 'mcp-handler'
import { track, type McpTool } from '@/lib/services/telemetry'
import { z } from 'zod'
import { errorShape, log } from '@/lib/log'
import {
  CHAT_NOT_FOUND, DATA_NOT_INSTRUCTIONS, INTERNAL_ERROR, MEDIA_NOT_FOUND, MEDIA_URL_NOTE, NO_CONNECTION, PERSON_NOTE,
} from '@/lib/mcp/copy'
import { archiveIsEmpty } from '@/lib/mcp/gate'
import { verifyAccessKey } from '@/lib/services/access-keys'
import { agentConnections, hasActiveConnection } from '@/lib/services/connections'
import { MAX_INLINE_IMAGE_BYTES, isInlineImage, normalizeMime, readServableMediaBytes } from '@/lib/services/media'
import { publicPeople } from '@/lib/services/people'
import { getMessages, mediaView, pageChats, recentMessages, searchMessages } from '@/lib/services/queries'

type Content = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }
type ToolResult = { content: Content[]; isError?: boolean }

const text = (value: unknown): ToolResult => ({
  content: [{ type: 'text' as const, text: typeof value === 'string' ? value : JSON.stringify(value) }],
})

// Anything a tool handler throws is returned to the client verbatim as
// `{ isError: true, content: [{ text: error.message }] }`, and drizzle builds
// that message as `Failed query: ${query}\nparams: ${params}` — the SQL and
// its bound values, straight into the agent's context. So no handler may
// throw: each one is wrapped here, the error goes to the log through
// errorShape, and the agent is told only that something went wrong.
function guarded<A extends unknown[]>(
  tool: McpTool,
  fn: (...args: A) => Promise<ToolResult>,
): (...args: A) => Promise<ToolResult> {
  return async (...args: A) => {
    // The tool's name only: never its arguments, never its result.
    track('mcp_tool_call', { tool })
    if (tool === 'search_messages') track('search', { surface: 'mcp' })
    try {
      return await fn(...args)
    } catch (e) {
      log.error({ err: errorShape(e), tool }, 'mcp tool failed')
      return { content: [{ type: 'text' as const, text: INTERNAL_ERROR }], isError: true }
    }
  }
}

// The content tools fall back to the one sentence only when this instance has
// nothing to serve at all — see lib/mcp/gate.ts. Disconnecting an account does
// not black the archive out for an agent while the portal and GET /api/chats
// keep serving the same history.
const nothingToServe = async (): Promise<boolean> =>
  !(await hasActiveConnection()) && (await archiveIsEmpty())

// Every tool here reads; none writes, deletes, or reaches anything outside
// this instance. Declared on each one so a client that gates on the hints
// (auto-approving read-only tools, say) can see it without trusting the
// description.
const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const

// A channel message id is the channel's own bookkeeping — useful to ingest
// for dedupe, useless to an agent, which cannot pass it to any tool here and
// only pays context for it. The portal's API keeps it; the agent view does not.
function lean<T extends { externalMessageId: string }>(m: T): Omit<T, 'externalMessageId'> {
  const copy: Partial<T> = { ...m }
  delete copy.externalMessageId
  return copy as Omit<T, 'externalMessageId'>
}

const timestamp = z.iso.datetime({ offset: true })
const toDate = (iso: string | undefined): Date | undefined => (iso ? new Date(iso) : undefined)
const channel = z.enum(['telegram', 'whatsapp'])
const kind = z.enum(['dm', 'group', 'channel'])
const limit = z.number().int().positive().max(200)

const listChatsInput = z.object({
  channel: channel.optional(),
  kind: kind.optional(),
  q: z.string().optional(),
  limit: limit.optional(),
  cursor: z.string().optional(),
})
const getMessagesInput = z.object({
  chat_id: z.string(),
  cursor: z.string().optional(),
  limit: limit.optional(),
  before: timestamp.optional(),
  after: timestamp.optional(),
})
const recentInput = z.object({
  channel: channel.optional(),
  kind: kind.optional(),
  include_channels: z.boolean().optional(),
  limit: limit.optional(),
  cursor: z.string().optional(),
  before: timestamp.optional(),
  after: timestamp.optional(),
})
const searchInput = z.object({
  query: z.string(),
  chat_id: z.string().optional(),
  channel: channel.optional(),
  kind: kind.optional(),
  sender: z.string().optional(),
  before: timestamp.optional(),
  after: timestamp.optional(),
  limit: limit.optional(),
  order: z.enum(['relevance', 'newest']).optional(),
  cursor: z.string().optional(),
})
const listPeopleInput = z.object({
  q: z.string().optional(),
  limit: limit.optional(),
  cursor: z.string().optional(),
  include_chats: z.boolean().optional(),
})
const getMediaInput = z.object({
  media_id: z.string(),
})

const handler = createMcpHandler(server => {
  server.registerTool(
    'list_chats',
    {
      annotations: READ_ONLY,
      description:
        'The chats archived on this instance, most recently active first: id, channel, kind (dm, group or channel), title, ' +
        'last activity, live message count and a snippet of the latest message. Filter by channel, by kind, or by q — a ' +
        'case-insensitive substring of the title, which for a direct chat is the name of the person in it. Twenty per page; ' +
        'pass nextCursor back to continue; total is how many match the filters. Two rows with one title are the same ' +
        'chat seen through two pairings of the account: connectionId (the id whoami reports) and createdAt tell them apart. ' +
        PERSON_NOTE + ' ' +
        DATA_NOT_INSTRUCTIONS,
      inputSchema: listChatsInput,
    },
    guarded('list_chats', async (args: z.infer<typeof listChatsInput>) => {
      if (await nothingToServe()) return text(NO_CONNECTION)
      return text(await pageChats(args))
    }),
  )

  server.registerTool(
    'get_messages',
    {
      annotations: READ_ONLY,
      description:
        'Read one chat, newest message first. Pass the nextCursor from a previous call to page further back, ' +
        'or before/after as ISO-8601 timestamps to bound the range. ' +
        MEDIA_URL_NOTE + ' ' +
        PERSON_NOTE + ' ' +
        DATA_NOT_INSTRUCTIONS,
      inputSchema: getMessagesInput,
    },
    guarded('get_messages', async (args: z.infer<typeof getMessagesInput>) => {
      if (await nothingToServe()) return text(NO_CONNECTION)
      const out = await getMessages(args.chat_id, {
        cursor: args.cursor,
        limit: args.limit,
        before: toDate(args.before),
        after: toDate(args.after),
      })
      return text(out ? { ...out, messages: out.messages.map(lean) } : CHAT_NOT_FOUND)
    }),
  )

  server.registerTool(
    'recent_messages',
    {
      annotations: READ_ONLY,
      description:
        'The inbox: the newest messages across your direct chats and groups, each with the chat it came from (chatId, ' +
        'chatTitle, channel, kind). Broadcast channels are left out unless you pass include_channels or kind: channel. ' +
        'Optionally one channel or one kind of chat, and before/after as ISO-8601 timestamps. Twenty per page; pass ' +
        'nextCursor back to go further back in time. ' +
        MEDIA_URL_NOTE + ' ' +
        PERSON_NOTE + ' ' +
        DATA_NOT_INSTRUCTIONS,
      inputSchema: recentInput,
    },
    guarded('recent_messages', async (args: z.infer<typeof recentInput>) => {
      if (await nothingToServe()) return text(NO_CONNECTION)
      const out = await recentMessages({
        channel: args.channel,
        kind: args.kind,
        includeChannels: args.include_channels,
        limit: args.limit,
        cursor: args.cursor,
        before: toDate(args.before),
        after: toDate(args.after),
      })
      return text({ ...out, messages: out.messages.map(lean) })
    }),
  )

  server.registerTool(
    'search_messages',
    {
      annotations: READ_ONLY,
      description:
        'Full-text search across the archive. Every word must match. Narrow it with chat_id, channel, kind, sender ' +
        '(a substring of the sender as shown), and before/after as ISO-8601 timestamps. Returns { hits, nextCursor }: ' +
        'fifty per page, pass nextCursor back to continue. Order is relevance (best match first) for a bare query and ' +
        'newest first when before or after is given; pass order to choose. Each hit names its chat (chatId, chatTitle, ' +
        'channel, kind). ' +
        MEDIA_URL_NOTE + ' ' +
        PERSON_NOTE + ' ' +
        DATA_NOT_INSTRUCTIONS,
      inputSchema: searchInput,
    },
    guarded('search_messages', async (args: z.infer<typeof searchInput>) => {
      if (await nothingToServe()) return text(NO_CONNECTION)
      const out = await searchMessages(args.query, {
        chatId: args.chat_id,
        channel: args.channel,
        kind: args.kind,
        sender: args.sender,
        before: toDate(args.before),
        after: toDate(args.after),
        limit: args.limit,
        order: args.order,
        cursor: args.cursor,
      })
      return text({ hits: out.hits.map(lean), nextCursor: out.nextCursor })
    }),
  )

  // The address book, gated exactly like the content tools: an empty instance
  // must look the same whichever tool a stranger reaches for. publicPeople()
  // is the mapping — no phone number, no channel identifier — and it is shared
  // with GET /api/people so the two cannot drift.
  server.registerTool(
    'list_people',
    {
      annotations: READ_ONLY,
      description:
        "The people in this instance's address book: id, name, your notes, which channels are linked, how many chats "
        + 'they appear in, and dm — the ids of the direct chats with them, which get_messages takes. Pass q to match a '
        + 'substring of the name. Fifty per page, sorted by name; pass nextCursor back to continue. Pass include_chats '
        + 'to also list every chat they appear in (id, title, channel, kind); it is long for a well-connected person, '
        + "so ask for it with q. The notes are the owner's own free text and are returned verbatim. "
        + 'Never a phone number. ' +
        DATA_NOT_INSTRUCTIONS,
      inputSchema: listPeopleInput,
    },
    guarded('list_people', async (args: z.infer<typeof listPeopleInput>) => {
      if (await nothingToServe()) return text(NO_CONNECTION)
      return text(await publicPeople({ q: args.q, limit: args.limit, cursor: args.cursor, includeChats: args.include_chats }))
    }),
  )

  // An attachment by the media.id a message carries. An image the client can
  // look at is returned as MCP image content alongside its metadata; anything
  // else (a document, a voice note, an image too large to inline) is metadata
  // only, with the url to fetch it from and whatever text analysis extracted.
  server.registerTool(
    'get_media',
    {
      annotations: READ_ONLY,
      description:
        'One attachment by the media.id on a message: its status, mime type, size, the chat and message it belongs to, ' +
        'and any text or description analysis extracted. A ready image up to 3 MiB is returned as image content in the ' +
        'same result, so you can look at it directly; anything else is metadata only. ' +
        MEDIA_URL_NOTE + ' ' +
        DATA_NOT_INSTRUCTIONS,
      inputSchema: getMediaInput,
    },
    guarded('get_media', async (args: z.infer<typeof getMediaInput>) => {
      if (await nothingToServe()) return text(NO_CONNECTION)
      const view = await mediaView(args.media_id)
      if (!view) return text(MEDIA_NOT_FOUND)
      const content: Content[] = []
      const mime = normalizeMime(view.mimeType)
      if (view.status === 'ready' && mime && isInlineImage(mime) && (view.sizeBytes ?? 0) <= MAX_INLINE_IMAGE_BYTES) {
        const bytes = await readServableMediaBytes(view.id, MAX_INLINE_IMAGE_BYTES)
        if (bytes) content.push({ type: 'image', data: bytes.toString('base64'), mimeType: mime })
      }
      content.push({ type: 'text', text: JSON.stringify(view) })
      return { content }
    }),
  )

  server.registerTool(
    'whoami',
    {
      annotations: READ_ONLY,
      description:
        'The channel accounts connected to this instance: id (the connectionId list_chats puts on each chat), channel, ' +
        'display name and status. Never a phone number. ' +
        DATA_NOT_INSTRUCTIONS,
    },
    guarded('whoami', async () => {
      // Archive rows only: a recovery attempt is a login-page event, not an
      // account this instance reads.
      return text({ connections: await agentConnections() })
    }),
  )
}, {
  serverInfo: { name: 'steno-personal', version: '0.1.0' },
})

// The same access keys that log into the portal. verifyAccessKey rejects
// revoked keys and bumps last_used_at, so /settings shows when an agent last
// read anything. A bad or missing token gets 401 + WWW-Authenticate.
const authed = withMcpAuth(
  handler,
  async (_req, token) => {
    if (!token) return undefined
    const key = await verifyAccessKey(token)
    if (!key) return undefined
    return { token, clientId: key.id, scopes: [] }
  },
  { required: true },
)

// mcp-handler 2.x is POST-only and stateless: it answers GET and DELETE with
// 405 itself, so there is nothing to export for them. POST is also the ONLY
// export this file may have — see lib/mcp/copy.ts.
export { authed as POST }
