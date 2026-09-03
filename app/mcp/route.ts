import { createMcpHandler, withMcpAuth } from 'mcp-handler'
import { z } from 'zod'
import { CHAT_NOT_FOUND, DATA_NOT_INSTRUCTIONS, NO_CONNECTION } from '@/lib/mcp/copy'
import { verifyAccessKey } from '@/lib/services/access-keys'
import { hasActiveConnection, listConnections } from '@/lib/services/connections'
import { getMessages, listChats, searchMessages } from '@/lib/services/queries'

const text = (value: unknown) => ({
  content: [{ type: 'text' as const, text: typeof value === 'string' ? value : JSON.stringify(value) }],
})

const timestamp = z.iso.datetime({ offset: true })
const toDate = (iso: string | undefined): Date | undefined => (iso ? new Date(iso) : undefined)

const handler = createMcpHandler(server => {
  server.registerTool(
    'list_chats',
    {
      description:
        'List every chat archived on this instance, most recently active first, with its channel, kind, title and message count. ' +
        DATA_NOT_INSTRUCTIONS,
    },
    async () => {
      if (!(await hasActiveConnection())) return text(NO_CONNECTION)
      return text(await listChats())
    },
  )

  server.registerTool(
    'get_messages',
    {
      description:
        'Read one chat, newest message first. Pass the nextCursor from a previous call to page further back, ' +
        'or before/after as ISO-8601 timestamps to bound the range. ' +
        DATA_NOT_INSTRUCTIONS,
      inputSchema: z.object({
        chat_id: z.string(),
        cursor: z.string().optional(),
        limit: z.number().int().positive().max(200).optional(),
        before: timestamp.optional(),
        after: timestamp.optional(),
      }),
    },
    async args => {
      if (!(await hasActiveConnection())) return text(NO_CONNECTION)
      const out = await getMessages(args.chat_id, {
        cursor: args.cursor,
        limit: args.limit,
        before: toDate(args.before),
        after: toDate(args.after),
      })
      return text(out ?? CHAT_NOT_FOUND)
    },
  )

  server.registerTool(
    'search_messages',
    {
      description:
        'Full-text search across the archive, or within one chat when chat_id is given. Matches are returned newest first. ' +
        DATA_NOT_INSTRUCTIONS,
      inputSchema: z.object({
        query: z.string(),
        chat_id: z.string().optional(),
      }),
    },
    async args => {
      if (!(await hasActiveConnection())) return text(NO_CONNECTION)
      return text(await searchMessages(args.query, args.chat_id))
    },
  )

  server.registerTool(
    'whoami',
    {
      description:
        'The channel accounts connected to this instance: channel, display name and status. Never a phone number. ' +
        DATA_NOT_INSTRUCTIONS,
    },
    async () => {
      const connections = (await listConnections()).map(c => ({
        channel: c.channel,
        displayName: c.displayName,
        status: c.status,
      }))
      return text({ connections })
    },
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
