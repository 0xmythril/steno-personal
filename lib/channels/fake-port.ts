import type {
  BackfillOpts, Channel, ChannelAccount, ChannelPort, ChannelSession, IncomingMessage, LoginDriver,
} from '@/lib/channels/port'

type LoginResult = { sessionString: string; account: ChannelAccount }

// Scriptable in-memory ChannelPort for testing the session manager, ingest,
// and backfill with no network. This is the whole point of the port seam:
// everything except the two library bindings is exercised through here.
export class FakePort implements ChannelPort {
  private loginResult: LoginResult | null = null
  private loginError: Error | null = null
  private passwordLogin: { correctPassword: string; result: LoginResult } | null = null
  private backfillMessages: IncomingMessage[] = []
  private backfillError: Error | null = null
  private pingError: Error | null = null
  private logOutError: Error | null = null
  private logOutHangs = false
  private download: { data: Buffer; mimeType: string | null } | null = null
  private session: FakeSession | null = null

  constructor(readonly channel: Channel = 'telegram') {}

  scriptLogin(result: LoginResult) { this.loginResult = result; this.loginError = null; this.passwordLogin = null }
  scriptLoginError(err: Error) { this.loginError = err; this.loginResult = null; this.passwordLogin = null }
  // Mirrors how lib/channels/telegram.ts actually drives 2FA: requestPassword(),
  // then poll getPassword() in a loop. A password that does not match calls
  // passwordRejected() and keeps polling; the matching one resolves login().
  scriptPasswordLogin(opts: { correctPassword: string; result: LoginResult }) {
    this.passwordLogin = opts; this.loginResult = null; this.loginError = null
  }
  scriptBackfill(msgs: IncomingMessage[]) { this.backfillMessages = msgs }
  // Read live by the already-open session, so a test can fail one backfill,
  // clear the error, and retry against the SAME session without reopening it.
  scriptBackfillError(err: Error | null) { this.backfillError = err }
  // Simulates a phone-side revocation caught by the manager's liveness probe.
  scriptPingError(err: Error | null) { this.pingError = err }
  // Simulates an already-dead session that cannot log itself out.
  scriptLogOutError(err: Error | null) { this.logOutError = err }
  // Simulates a channel that accepts the log-out call and never answers it —
  // the shape that would wedge a tick (and with it SIGTERM) if the manager
  // awaited it unbounded.
  scriptLogOutHang(hangs = true) { this.logOutHangs = hangs }
  scriptDownload(payload: { data: Buffer; mimeType: string | null }) { this.download = payload }

  private requireSession(): FakeSession {
    if (!this.session) throw new Error('FakePort: call open() before emitting events')
    return this.session
  }

  emitMessage(m: IncomingMessage) { this.requireSession().emitMessage(m) }
  emitEdit(m: IncomingMessage) { this.requireSession().emitEdit(m) }
  emitDelete(ref: { externalChatId?: string; externalMessageId: string }) { this.requireSession().emitDelete(ref) }

  // How many liveness probes the manager has actually made — the manager
  // throttles them, so a test needs to count them, not just observe an error.
  get pingCount(): number { return this.session?.pings ?? 0 }
  get loggedOut(): boolean { return this.session?.loggedOut ?? false }
  get sessionClosed(): boolean { return this.session?.closed ?? false }

  async login(driver: LoginDriver, _opts: { timeoutMs: number; connectionId: string }): Promise<LoginResult> {
    await driver.publishQr('tg://login?token=FAKE')
    if (this.loginError) throw this.loginError
    if (this.passwordLogin) {
      const { correctPassword, result } = this.passwordLogin
      await driver.requestPassword()
      for (;;) {
        const pw = await driver.getPassword()
        if (pw === correctPassword) return result
        if (pw !== null) await driver.passwordRejected()
        await new Promise(r => setTimeout(r, 20))
      }
    }
    if (!this.loginResult) throw new Error('FakePort.login not scripted')
    return this.loginResult
  }

  async open(_sessionString: string, _opts: { connectionId: string }): Promise<ChannelSession> {
    this.session = new FakeSession(
      this.backfillMessages,
      () => this.backfillError, () => this.pingError, () => this.logOutError,
      () => this.logOutHangs, () => this.download,
    )
    return this.session
  }
}

class FakeSession implements ChannelSession {
  private msgCbs: Array<(m: IncomingMessage) => void> = []
  private editCbs: Array<(m: IncomingMessage) => void> = []
  private delCbs: Array<(ref: { externalChatId?: string; externalMessageId: string }) => void> = []
  closed = false
  loggedOut = false
  pings = 0

  constructor(
    private backfillMessages: IncomingMessage[],
    private getBackfillError: () => Error | null,
    private getPingError: () => Error | null,
    private getLogOutError: () => Error | null,
    private getLogOutHangs: () => boolean,
    private getDownload: () => { data: Buffer; mimeType: string | null } | null,
  ) {}

  async *backfill(_opts: BackfillOpts, shouldContinue: () => boolean = () => true): AsyncIterable<IncomingMessage> {
    const err = this.getBackfillError()
    if (err) throw err
    for (let i = 0; i < this.backfillMessages.length; i++) {
      if (!shouldContinue()) return
      yield this.backfillMessages[i]
      // A small pause BETWEEN messages (never after the last, so a
      // single-message backfill pays no latency) gives a concurrent revoke a
      // real chance to land mid-backfill, mirroring network-bound iteration
      // without a fake clock.
      if (i < this.backfillMessages.length - 1) await new Promise(r => setTimeout(r, 50))
    }
  }

  onMessage(cb: (m: IncomingMessage) => void) { this.msgCbs.push(cb) }
  onEdit(cb: (m: IncomingMessage) => void) { this.editCbs.push(cb) }
  onDelete(cb: (ref: { externalChatId?: string; externalMessageId: string }) => void) { this.delCbs.push(cb) }
  emitMessage(m: IncomingMessage) { this.msgCbs.forEach(cb => cb(m)) }
  emitEdit(m: IncomingMessage) { this.editCbs.forEach(cb => cb(m)) }
  emitDelete(ref: { externalChatId?: string; externalMessageId: string }) { this.delCbs.forEach(cb => cb(ref)) }

  async downloadMedia(_raw: unknown): Promise<{ data: Buffer; mimeType: string | null }> {
    const payload = this.getDownload()
    if (!payload) throw new Error('FakePort: downloadMedia not scripted')
    return payload
  }

  async ping(): Promise<void> {
    this.pings++
    const err = this.getPingError()
    if (err) throw err
  }

  async logOut(): Promise<void> {
    if (this.getLogOutHangs()) return new Promise<never>(() => {})
    const err = this.getLogOutError()
    if (err) throw err
    this.loggedOut = true
  }

  async close(): Promise<void> { this.closed = true }
}
