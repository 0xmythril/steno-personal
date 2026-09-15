'use client'

import { useEffect, useRef, useState } from 'react'
import { disconnectAction } from './actions'
import { formatRelativeTime } from '@/lib/format'

type Status = { configured: boolean; loginConfigured?: boolean; id?: string | null; connected?: boolean; readable?: boolean; capture?: string; reason?: string | null; lastSyncAt?: string | null }
const reasonText: Record<string, string> = {
  unauthorized: 'Stele rejected the credential. Update its private token file.',
  forbidden: 'The Stele credential does not permit this operation.',
  rate_limited: 'Stele is busy. Wait a minute before retrying.',
  account_mismatch: 'This is a different WeChat account or dataset. Reconnect it deliberately before importing.',
  source_gap: 'The source needs reconciliation or exceeds the current import limit.',
  scanning: 'WeChat is linked. Stele is scanning the available messages.',
  starting: 'Waiting for the official WeChat client to start.',
  not_logged_in: 'Confirm the linked session on your phone or show its login QR.',
  session_revoked: 'The WeChat session was revoked. Link it again to resume.',
}
export function WechatConnection() {
  const [status, setStatus] = useState<Status | null>(null)
  const [qr, setQr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const request = useRef<AbortController | null>(null)
  const expiry = useRef<ReturnType<typeof setTimeout> | null>(null)
  function clearQr() { if (expiry.current) clearTimeout(expiry.current); expiry.current = null; setQr(null) }
  useEffect(() => {
    const abort = new AbortController(); let polling = false
    const poll = async () => {
      if (polling) return; polling = true
      try {
        const response = await fetch('/api/stele/wechat/status', { cache: 'no-store', signal: abort.signal })
        if (!response.ok) { request.current?.abort(); clearQr(); setNotice('Sign in again to manage WeChat.'); return }
        setStatus(await response.json())
      } catch { if (!abort.signal.aborted) setStatus(s => s ? { ...s, readable: false } : null) }
      finally { polling = false }
    }
    void poll(); const timer = setInterval(() => void poll(), 5000)
    return () => { abort.abort(); clearInterval(timer); request.current?.abort(); if (expiry.current) clearTimeout(expiry.current) }
  }, [])
  async function connect() {
    if (request.current) return
    const abort = new AbortController(); request.current = abort; setBusy(true); setNotice('Waiting for the official client. Inspect the history-sync choice on your phone.'); clearQr()
    try {
      const response = await fetch('/api/stele/wechat/login', { method: 'POST', signal: abort.signal, headers: { 'Content-Type': 'application/json' }, body: '{}' })
      if (!response.ok || !response.body) throw new Error()
      const reader = response.body.getReader(), decoder = new TextDecoder(); let pending = '', completed = false
      for (;;) {
        const part = await reader.read(); if (part.done) break
        pending += decoder.decode(part.value, { stream: true }); if (pending.length > 256 * 1024) throw new Error()
        let newline: number
        while ((newline = pending.indexOf('\n')) >= 0) {
          const event = JSON.parse(pending.slice(0, newline)); pending = pending.slice(newline + 1); clearQr()
          if (event.type === 'qr' && /^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(event.qrDataUrl)) {
            const remaining = Math.min(Date.parse(event.expiresAt) - Date.now(), 10_000)
            if (remaining > 0) { setQr(event.qrDataUrl); expiry.current = setTimeout(clearQr, remaining) }
          } else if (event.type === 'login_success') { completed = true; setNotice('Linked. Waiting for capture readiness and the worker to import messages.') }
          else if (event.type === 'login_timeout') { completed = true; setNotice('The login window expired. You can try again.') }
          else if (event.type === 'error') { completed = true; setNotice(reasonText[event.error] ?? 'Login is unavailable. Check the private Stele connection and retry.') }
        }
      }
      if (!completed && !abort.signal.aborted) setNotice('The login stream disconnected. Retry to resume the current attempt.')
    } catch { if (!abort.signal.aborted) setNotice('Login is unavailable. Check the private Stele connection and retry.') }
    finally { abort.abort(); request.current = null; clearQr(); setBusy(false) }
  }
  const stale = Boolean(status?.connected && (!status.lastSyncAt || Date.now() - Date.parse(status.lastSyncAt) > 120_000))
  return <section className="card">
    <div className="card-head"><h2>WeChat</h2><span className={`chip ${status?.connected && status.readable && !stale ? 'ok' : 'warn'}`}>{status?.connected && status.readable ? 'Capture available' : 'Experimental'}</span></div>
    <p className="muted">WeChat is read through your own Stele instance. Text and history coverage are limited. Media and upstream recall propagation are unavailable; recalled messages may remain in this archive.</p>
    <p className="muted">This unsupported integration can affect account access. Only link your own account. Stele credentials stay on this server.</p>
    {status?.configured === false ? <p className="help">Configure the private Stele connection on this server to enable WeChat. See the self-hosting guide.</p> : <>
      <p aria-live="polite">{status?.reason ? reasonText[status.reason] ?? 'Capture is unavailable. Check Stele and the private connection.' : status?.readable ? 'Stele can read messages.' : 'Checking the private connection…'}</p>
      {stale && <p className="help">Import is pending or stale. The archive may be behind WeChat; check that the worker is running and review its sync errors.</p>}
      {status?.connected && <p className="muted">Last imported <span className="mono">{formatRelativeTime(status.lastSyncAt ? new Date(status.lastSyncAt) : null)}</span>. A running worker is required.</p>}
      {notice && <p aria-live="polite">{notice}</p>}
      {qr && <div className="connect"><div className="qr">{/* Ephemeral, server-validated PNG; never a remote image URL. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={qr} width={240} height={240} alt="WeChat login QR code" />
      </div><ol><li>Open WeChat on your phone and scan this code.</li><li>Inspect the history-sync choice before confirming.</li><li>Return here to see capture and import progress.</li></ol></div>}
      <div className="actions">
        {status?.loginConfigured && !busy && <button type="button" onClick={() => void connect()}>{status?.connected ? 'Show login QR' : 'Connect WeChat'}</button>}
        {busy && <button type="button" onClick={() => { request.current?.abort(); clearQr(); setNotice('QR display closed. The linked Stele session is unchanged.') }}>Close QR</button>}
        {status?.connected && status.id && <form action={disconnectAction}><input type="hidden" name="connectionId" value={status.id} /><button type="submit">Disconnect importer</button></form>}
      </div>
      <p className="help">Disconnecting stops Steno importing and keeps this archive. Manage the shared linked device in WeChat itself.</p>
    </>}
  </section>
}
