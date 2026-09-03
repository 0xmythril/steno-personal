// Pure string builders for the copy blocks on /settings. Kept out of the
// component so they can be tested without a request, and so the MCP path
// lives in exactly one place.
export const MCP_PATH = '/mcp'
export const SERVER_NAME = 'steno'
export const KEY_PLACEHOLDER = 'sp_YOUR_ACCESS_KEY'

const LOCAL_HOSTS = ['localhost', '127.0.0.1', '[::1]']

// A deployed instance sits behind a proxy that terminates TLS (Railway sets
// x-forwarded-*); a laptop does not. Guessing https for a bare `localhost`
// would hand the user a URL that cannot connect.
export function mcpUrlFrom(headers: {
  host: string | null
  forwardedHost: string | null
  forwardedProto: string | null
}): string {
  const host = headers.forwardedHost ?? headers.host ?? 'localhost:3000'
  // An IPv6 host arrives bracketed ("[::1]:3000"), so the port cannot just be
  // split off at the first colon.
  const hostname = host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.split(':')[0]
  const proto = headers.forwardedProto ?? (LOCAL_HOSTS.includes(hostname) ? 'http' : 'https')
  return `${proto}://${host}${MCP_PATH}`
}

export function claudeCodeCommand(mcpUrl: string, rawKey: string): string {
  return `claude mcp add --transport http ${SERVER_NAME} ${mcpUrl} --header "Authorization: Bearer ${rawKey}"`
}

export function mcpServersJson(mcpUrl: string, rawKey: string): string {
  return JSON.stringify({
    mcpServers: {
      [SERVER_NAME]: {
        type: 'http',
        url: mcpUrl,
        headers: { Authorization: `Bearer ${rawKey}` },
      },
    },
  }, null, 2)
}
