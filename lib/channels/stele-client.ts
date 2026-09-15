import { WebSocket } from 'ws'
import { z } from 'zod'
import { env } from '@/lib/env'
import { readSteleToken } from './stele-config'
import { statusSchema } from './stele-wire'

const codes = new Set(['unauthorized', 'forbidden', 'rate_limited', 'cursor_expired', 'gone', 'account_mismatch', 'not_found', 'not_logged_in', 'session_revoked', 'starting', 'scanning', 'reader_unavailable', 'unsupported_build', 'source_gap', 'storage_full', 'unsupported'])
export class SteleError extends Error {
  readonly code: string
  constructor(code = 'reader_unavailable') { super('Stele is temporarily unavailable.'); this.name = 'SteleError'; this.code = codes.has(code) ? code : 'reader_unavailable' }
}
export function steleError(error: unknown) { return error instanceof SteleError ? error.code : 'reader_unavailable' }
export class SteleClient {
  readonly abort = new AbortController()
  async get<T>(path: string, schema: z.ZodType<T>): Promise<T> {
    try {
      if (!env.STELE_WECHAT_URL) throw new SteleError()
      const response = await fetch(new URL(path, env.STELE_WECHAT_URL), { headers: { Authorization: `Bearer ${readSteleToken(env.STELE_WECHAT_READ_TOKEN_FILE)}` }, redirect: 'error', cache: 'no-store', signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(15_000)]) })
      const reader = response.body?.getReader(); if (!reader) throw new SteleError()
      const chunks: Uint8Array[] = []; let bytes = 0
      try { for (;;) { const part = await reader.read(); if (part.done) break; bytes += part.value.length; if (bytes > 2 * 1024 * 1024) throw new SteleError(); chunks.push(part.value) } }
      finally { await reader.cancel().catch(() => {}) }
      const body = JSON.parse(Buffer.concat(chunks).toString())
      if (!response.ok) throw new SteleError(body?.error?.code)
      return schema.parse(body)
    } catch (error) { throw error instanceof SteleError ? error : new SteleError() }
  }
  status() { return this.get('/v1/status', statusSchema) }
  async *stream(path: string, login = false): AsyncGenerator<unknown> {
    if (!env.STELE_WECHAT_URL) throw new SteleError()
    const url = new URL(path, env.STELE_WECHAT_URL); url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    let socket: WebSocket
    try { socket = new WebSocket(url, { headers: { Authorization: `Bearer ${readSteleToken(login ? env.STELE_WECHAT_LOGIN_TOKEN_FILE : env.STELE_WECHAT_READ_TOKEN_FILE)}` }, followRedirects: false, handshakeTimeout: 10_000, maxPayload: login ? 128 * 1024 : 32 * 1024 }) }
    catch { throw new SteleError() }
    const queue: unknown[] = []; let done = false, failure: SteleError | null = null, wake = () => {}
    const stop = () => { done = true; socket.terminate(); wake() }
    const fail = (code?: string) => { failure = new SteleError(code); stop() }
    const timer = setTimeout(() => fail(), login ? 310_000 : 60_000)
    const abort = () => fail()
    this.abort.signal.addEventListener('abort', abort, { once: true })
    socket.on('message', bytes => { try { if (queue.length >= 128) { fail(); return }; queue.push(JSON.parse(bytes.toString())); if (queue.length >= 32) socket.pause(); wake() } catch { fail() } })
    socket.on('unexpected-response', (_request, response) => { response.resume(); fail(response.statusCode === 401 ? 'unauthorized' : response.statusCode === 403 ? 'forbidden' : response.statusCode === 410 ? 'cursor_expired' : response.statusCode === 429 ? 'rate_limited' : undefined) })
    socket.on('error', () => fail())
    socket.on('close', () => { done = true; wake() })
    try {
      if (this.abort.signal.aborted) throw new SteleError()
      for (;;) {
        if (failure) throw failure
        if (queue.length) { const value = queue.shift(); if (queue.length < 16 && socket.readyState === WebSocket.OPEN) socket.resume(); yield value; continue }
        if (done) return
        await new Promise<void>(resolve => { wake = resolve })
      }
    } finally { clearTimeout(timer); this.abort.signal.removeEventListener('abort', abort); stop() }
  }
  close() { this.abort.abort() }
}
