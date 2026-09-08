import { DisputeCapacityError } from '@/lib/services/disputes'
import { createMcpHandler, withMcpAuth } from 'mcp-handler'
import { z } from 'zod'
import { errorShape, log } from '@/lib/log'
import { DATA_NOT_INSTRUCTIONS, INTERNAL_ERROR } from '@/lib/mcp/copy'
import { verifyAccessKey } from '@/lib/services/access-keys'
import { FORMAT, batchSchema, importBatch, type Batch } from '@/lib/services/import'
import { track } from '@/lib/services/telemetry'

// The second MCP endpoint: the push door for an agent. Everything /mcp says
// about itself (spec invariant 8, the injection warning, the internal-error
// discipline) holds here too, but this one writes: an agent that can push
// can plant text every reader — including itself, next session — will treat
// as data. Kept in its own route file so a client that gates on
// annotations.readOnlyHint sees the read server never write, ever, and the
// two verifyAccessKey scopes never share a door (tests/key-scopes-structure.test.ts).

type Content = { type: 'text'; text: string }
type ToolResult = { content: Content[]; isError?: boolean }

const text = (value: unknown): ToolResult => ({
  content: [{ type: 'text' as const, text: typeof value === 'string' ? value : JSON.stringify(value) }],
})

// Same wire format as POST /api/import (lib/services/import.ts), minus
// `format`: this endpoint already knows it, the same way a client's URL
// already says which door it is knocking on.
const pushInput = batchSchema.omit({ format: true })

// Not read-only: this is the one MCP tool that writes to the archive. Still
// idempotentHint: true — importBatch's own dedupe makes a resend of the same
// batch safe, not because the first call had no effect.
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const

// The auth context mcp-handler hands a tool callback on an HTTP transport;
// only the one field this route needs is named, so a real SDK type upgrade
// cannot silently change what this route reads.
type ToolContext = { http?: { authInfo?: { clientId: string } } }

const handler = createMcpHandler(server => {
  server.registerTool(
    'push_messages',
    {
      annotations: WRITE,
      description:
        'Deliver a batch of messages and deletes into a source your key owns: the same shape and rules as the HTTP ' +
        'push door (POST /api/import), minus format, which this tool already knows. source.type names the kind of ' +
        'conversation as a lowercase slug (never telegram or whatsapp — those are paired live accounts, not something ' +
        'a key can push into); source.id is your own identifier for that particular account or export; source.label ' +
        'is what a person sees for it in this instance. The same (type, id) resends into the same source, so a batch ' +
        'can be split or retried: a message already stored by its externalChatId and externalMessageId is a duplicate ' +
        'unless it carries a newer editedAt or different text. Older or equal edit timestamps leave the message ' +
        'unchanged, and deletes are idempotent too. Returns { source: { id }, ' +
        'inserted, duplicates, edited, deleted, conflicts, conflicting }. ' +
        DATA_NOT_INSTRUCTIONS,
      inputSchema: pushInput,
    },
    async (args: z.infer<typeof pushInput>, ctx: ToolContext): Promise<ToolResult> => {
      const clientId = ctx.http?.authInfo?.clientId
      if (!clientId) {
        log.error({}, 'push_messages called with no authenticated client id')
        return { content: [{ type: 'text', text: INTERNAL_ERROR }], isError: true }
      }
      try {
        const batch: Batch = { format: FORMAT, ...args }
        const result = await importBatch(clientId, batch, 'mcp')
        // The fact of a push, never its content. Same event as the HTTP
        // door, distinguished only by which surface it came through.
        track('source_pushed', { surface: 'mcp' })
        return text(result)
      } catch (e) {
        if (e instanceof DisputeCapacityError) return { content: [{ type: 'text', text: 'Pending dispute storage is full. Review disputes in History, then retry. Nothing in this batch was saved.' }], isError: true }
        // Never the thrown message here either: drizzle puts the SQL and its
        // bound parameters (which, for a write, can be the pushed text
        // itself) straight into an error string.
        log.error({ err: errorShape(e) }, 'push_messages failed')
        return { content: [{ type: 'text', text: INTERNAL_ERROR }], isError: true }
      }
    },
  )
}, {
  serverInfo: { name: 'steno-personal-push', version: '0.1.0' },
})

// A push key only: verifyAccessKey(token, 'push') refuses a read-only key,
// so the two capabilities always mean two different doors even when one key
// carries both.
const authed = withMcpAuth(
  handler,
  async (_req, token) => {
    if (!token) return undefined
    const key = await verifyAccessKey(token, 'push')
    if (!key) return undefined
    return { token, clientId: key.id, scopes: [] }
  },
  { required: true },
)

// POST is the only export this file may have — see lib/mcp/copy.ts.
export { authed as POST }
