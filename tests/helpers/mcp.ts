import { POST } from '@/app/mcp/route'

// mcp-handler 2.x answers a POST with a single SSE frame carrying the
// JSON-RPC message, and refuses any request that does not accept both media
// types. Both facts live here so no test has to know them.
export type ToolInfo = {
  name: string; description?: string
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean }
}
type RpcMessage = {
  result?: { content?: Array<{ type: string; text?: string }>; tools?: ToolInfo[]; isError?: boolean }
  error?: { code: number; message: string }
}

export function mcpRequest(rawKey: string, body: unknown): Request {
  return new Request('http://localhost:3000/mcp', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${rawKey}`,
    },
    body: JSON.stringify(body),
  })
}

export async function rpc(rawKey: string, body: unknown): Promise<{ status: number; message: RpcMessage | null }> {
  const res = await POST(mcpRequest(rawKey, body))
  if (res.status !== 200) return { status: res.status, message: null }
  const sse = await res.text()
  const frame = sse.split('\n').find(line => line.startsWith('data: '))
  if (!frame) throw new Error(`no SSE data frame in response: ${sse}`)
  return { status: res.status, message: JSON.parse(frame.slice('data: '.length)) as RpcMessage }
}

export async function listTools(rawKey: string): Promise<ToolInfo[]> {
  const { message } = await rpc(rawKey, { jsonrpc: '2.0', id: 1, method: 'tools/list' })
  const tools = message?.result?.tools
  if (!tools) throw new Error(`tools/list failed: ${JSON.stringify(message)}`)
  return tools
}

export async function callTool(rawKey: string, name: string, args: Record<string, unknown> = {}): Promise<string> {
  const { message } = await rpc(rawKey, {
    jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args },
  })
  if (message?.error) throw new Error(`JSON-RPC error ${message.error.code}: ${message.error.message}`)
  return (message?.result?.content ?? []).map(c => c.text ?? '').join('\n')
}
