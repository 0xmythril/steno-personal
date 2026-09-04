import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import type { WaAuth, WaDeps, WaEventMap, WaSocket, WaSocketOpts } from '@/lib/channels/whatsapp'

// Lets a promise chain that hops through fs and a couple of awaits settle.
// The session object deliberately exposes no test hook (spec invariant 1), so
// tests wait on the clock instead.
export function flush(ms = 10): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

// Poll instead of sleeping a fixed duration: `flush()` only guesses how long
// mkdir + the makeSocket chain takes, and that guess lost under load (the M2
// suite flaked on CI exactly here until this was made a poll). Every call
// site that immediately indexes h.sockets[0]/h.last() must wait on this.
export async function waitForSocket(h: FakeWaHarness, n = 1): Promise<void> {
  for (let i = 0; i < 500 && h.sockets.length < n; i++) {
    await flush(1)
  }
  if (h.sockets.length < n) {
    throw new Error(`waitForSocket: expected ${n} socket(s), got ${h.sockets.length} after 500ms`)
  }
}

export class FakeWaSocket implements WaSocket {
  readonly opts: WaSocketOpts
  user: { id?: string; lid?: string; name?: string } | undefined
  logoutCalls = 0
  endCalls = 0
  groupMetadataCalls: string[] = []
  readonly groupSubjects = new Map<string, string>()
  readonly lidToPn = new Map<string, string>()
  readonly reuploaded: unknown[] = []
  private readonly handlers = new Map<string, Array<(arg: never) => void>>()

  constructor(opts: WaSocketOpts) {
    this.opts = opts
  }

  readonly ev = {
    on: <K extends keyof WaEventMap>(event: K, cb: (arg: WaEventMap[K]) => void): void => {
      const list = this.handlers.get(event) ?? []
      list.push(cb as (arg: never) => void)
      this.handlers.set(event, list)
    },
  }

  readonly signalRepository = {
    lidMapping: {
      getPNForLID: async (lid: string): Promise<string | null> => this.lidToPn.get(lid) ?? null,
    },
  }

  async logout(): Promise<void> {
    this.logoutCalls++
  }

  async end(): Promise<void> {
    this.endCalls++
  }

  async groupMetadata(jid: string): Promise<{ id: string; subject?: string | null }> {
    this.groupMetadataCalls.push(jid)
    const subject = this.groupSubjects.get(jid)
    if (!subject) throw new Error('no metadata for this group')
    return { id: jid, subject }
  }

  async updateMediaMessage(message: unknown): Promise<unknown> {
    this.reuploaded.push(message)
    return message
  }

  emit<K extends keyof WaEventMap>(event: K, arg: WaEventMap[K]): void {
    for (const cb of this.handlers.get(event) ?? []) (cb as (a: WaEventMap[K]) => void)(arg)
  }

  emitQr(qr: string): void {
    this.emit('connection.update', { qr })
  }

  emitOpen(user: { id?: string; lid?: string; name?: string } = { id: '15551234567@s.whatsapp.net', name: 'Owner' }): void {
    this.user = user
    this.emit('connection.update', { connection: 'open' })
  }

  // `code` mirrors Baileys' Boom shape: lastDisconnect.error.output.statusCode.
  emitClose(code?: number): void {
    this.emit('connection.update', {
      connection: 'close',
      lastDisconnect: { error: code === undefined ? new Error('socket closed') : { output: { statusCode: code } }, date: new Date() },
    })
  }
}

export type FakeWaHarness = {
  deps: WaDeps
  sockets: FakeWaSocket[]
  last(): FakeWaSocket
  saveCredsCalls(): number
  downloads(): unknown[]
}

// The bytes fields of a WebMessageInfo, as JSON.stringify of a protobufjs
// message leaves them: base64 strings.
const BYTES_FIELDS = new Set(['mediaKey', 'fileSha256', 'fileEncSha256', 'streamingSidecar', 'jpegThumbnail'])

function reviveBytes(value: unknown): unknown {
  if (value === null || typeof value !== 'object' || Buffer.isBuffer(value)) return value
  if (Array.isArray(value)) return value.map(reviveBytes)
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = BYTES_FIELDS.has(k) && typeof v === 'string' ? Buffer.from(v, 'base64') : reviveBytes(v)
  }
  return out
}

export function fakeWaDeps(opts: { download?: (message: unknown) => Promise<Buffer> } = {}): FakeWaHarness {
  const sockets: FakeWaSocket[] = []
  const downloaded: unknown[] = []
  let saveCredsCalls = 0

  const deps: WaDeps = {
    async useAuthState(dir: string): Promise<WaAuth> {
      await mkdir(dir, { recursive: true })
      return { state: { creds: {}, keys: {} }, saveCreds: async () => { saveCredsCalls++ } }
    },
    async makeSocket(socketOpts) {
      const socket = new FakeWaSocket(socketOpts)
      sockets.push(socket)
      return socket
    },
    // Stands in for proto.WebMessageInfo.fromObject: protobufjs turns the
    // base64 strings its own JSON projection produced back into byte arrays.
    // Only the byte fields a media download needs are converted — this file
    // may not name Baileys (spec invariant 2), so it mimics the one behaviour
    // the port depends on rather than importing the real thing.
    async fromObject(raw) {
      return reviveBytes(raw) as never
    },
    async downloadMedia(message, ctx) {
      downloaded.push(message)
      await ctx.reuploadRequest(message)
      return opts.download ? await opts.download(message) : Buffer.from('media-bytes')
    },
  }

  return {
    deps,
    sockets,
    last: () => sockets[sockets.length - 1],
    saveCredsCalls: () => saveCredsCalls,
    downloads: () => downloaded,
  }
}

// Every test gets its own authRoot under the file's temp DATA_DIR.
export function testAuthRoot(name: string): string {
  return path.join(process.env.DATA_DIR ?? '/tmp', 'whatsapp', name)
}
