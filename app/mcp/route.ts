import { createMcpHandler, withMcpAuth } from 'mcp-handler'
import { z } from 'zod'
import { errorShape, log } from '@/lib/log'
import {
  CHAT_NOT_FOUND, DATA_NOT_INSTRUCTIONS, INTERNAL_ERROR, MEDIA_URL_NOTE, NO_CONNECTION, PERSON_NOTE,
} from '@/lib/mcp/copy'
import { archiveIsEmpty } from '@/lib/mcp/gate'
import { verifyAccessKey } from '@/lib/services/access-keys'
import { hasActiveConnection, listConnections } from '@/lib/services/connections'
import { publicPeople } from '@/lib/services/people'
import { getMessages, listChats, searchMessages } from '@/lib/services/queries'

type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean }

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
  tool: string,
  fn: (...args: A) => Promise<ToolResult>,
): (...args: A) => Promise<ToolResult> {
  return async (...args: A) => {
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

const timestamp = z.iso.datetime({ offset: true })
const toDate = (iso: string | undefined): Date | undefined => (iso ? new Date(iso) : undefined)

const getMessagesInput = z.object({
  chat_id: z.string(),
  cursor: z.string().optional(),
  limit: z.number().int().positive().max(200).optional(),
  before: timestamp.optional(),
  after: timestamp.optional(),
})
const searchInput = z.object({
  query: z.string(),
  chat_id: z.string().optional(),
})

const handler = createMcpHandler(server => {
  server.registerTool(
    'list_chats',
    {
      description:
        'List every chat archived on this instance, most recently active first, with its channel, kind, title and message count. ' +
        PERSON_NOTE + ' ' +
        DATA_NOT_INSTRUCTIONS,
    },
    guarded('list_chats', async () => {
      if (await nothingToServe()) return text(NO_CONNECTION)
      return text(await listChats())
    }),
  )

  server.registerTool(
    'get_messages',
    {
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
      return text(out ?? CHAT_NOT_FOUND)
    }),
  )

  server.registerTool(
    'search_messages',
    {
      description:
        'Full-text search across the archive, or within one chat when chat_id is given. Matches are returned newest first. ' +
        MEDIA_URL_NOTE + ' ' +
        PERSON_NOTE + ' ' +
        DATA_NOT_INSTRUCTIONS,
      inputSchema: searchInput,
    },
    guarded('search_messages', async (args: z.infer<typeof searchInput>) => {
      if (await nothingToServe()) return text(NO_CONNECTION)
      return text(await searchMessages(args.query, args.chat_id))
    }),
  )

  // The address book, gated exactly like the content tools: an empty instance
  // must look the same whichever tool a stranger reaches for. publicPeople()
  // is the mapping — no phone number, no channel identifier — and it is shared
  // with GET /api/people so the two cannot drift.
  server.registerTool(
    'list_people',
    {
      description:
        "The people in this instance's address book: id, name, your notes, which channels are linked, and how "
        + "many chats they appear in. The notes are the owner's own free text and are returned verbatim. "
        + 'Never a phone number. ' +
        DATA_NOT_INSTRUCTIONS,
    },
    guarded('list_people', async () => {
      if (await nothingToServe()) return text(NO_CONNECTION)
      return text(await publicPeople())
    }),
  )

  server.registerTool(
    'whoami',
    {
      description:
        'The channel accounts connected to this instance: channel, display name and status. Never a phone number. ' +
        DATA_NOT_INSTRUCTIONS,
    },
    guarded('whoami', async () => {
      const connections = (await listConnections()).map(c => ({
        channel: c.channel,
        displayName: c.displayName,
        status: c.status,
      }))
      return text({ connections })
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
