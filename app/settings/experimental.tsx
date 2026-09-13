'use client'

import { useEffect, useId, useRef, useState, useTransition } from 'react'
import { setExperimentalAction } from './actions'

// The last card on Settings, on purpose: a switch for parts of Steno that are
// not finished, separate from Advanced mode, which only reveals controls
// that already work. Each feature is its own row and its own column, so the
// worker and the routes can read the switch directly.
export function ExperimentalFeatures({ wechat }: { wechat: boolean }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const toggle = useRef<HTMLButtonElement>(null)
  const returnFocus = useRef(false)
  const titleId = useId()
  const rowId = useId()
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!pending && returnFocus.current) {
      returnFocus.current = false
      toggle.current?.focus()
    }
  }, [pending])

  const save = (next: boolean) => {
    setError(null)
    startTransition(async () => {
      try {
        await setExperimentalAction('wechat', next)
        returnFocus.current = true
        dialog.current?.close()
      } catch {
        setError('Could not save the setting. Please try again.')
      }
    })
  }

  return (
    <section id="experimental" className="card" aria-labelledby={titleId}>
      <h2 id={titleId}>Experimental features</h2>
      <p className="muted">Unfinished parts of Steno, off by default. They may change or disappear in a later release.
        Turning one on or off is reported as an anonymous usage event while those are on, so the project can see
        whether it is worth keeping; nothing about your accounts is.</p>
      <div className="advanced-mode-row">
        <div className="stack">
          <h3 id={rowId}>WeChat through Stele</h3>
          <p id={`${rowId}-description`} className="muted">Read WeChat through an unofficial sidecar. Adds a WeChat card to Connections.</p>
        </div>
        <button
          type="button"
          ref={toggle}
          role="switch"
          aria-checked={wechat}
          aria-labelledby={rowId}
          aria-describedby={`${rowId}-description`}
          className="mode-switch"
          disabled={pending}
          onClick={() => {
            setError(null)
            if (wechat) save(false)
            else dialog.current?.showModal()
          }}
        >
          <span className="mode-switch-track" aria-hidden="true"><span /></span>
          <span>{pending ? 'Saving…' : wechat ? 'On' : 'Off'}</span>
        </button>
      </div>
      <p className="help">Turning off hides the WeChat card and stops importing from it. Messages already archived stay.</p>
      {wechat && error && <p className="danger" role="alert">{error}</p>}
      <dialog
        ref={dialog}
        className="confirm advanced-mode-dialog"
        aria-labelledby={`${rowId}-dialog`}
        aria-describedby={`${rowId}-dialog-body`}
        onCancel={e => { if (pending) e.preventDefault() }}
        onClick={e => { if (!pending && e.target === dialog.current) dialog.current?.close() }}
      >
        <h3 id={`${rowId}-dialog`}>Turn on WeChat through Stele?</h3>
        <div className="confirm-body" id={`${rowId}-dialog-body`}>
          <p>WeChat is not built in. Telegram and WhatsApp are read by Steno itself; WeChat is read through
            Stele, a separate experimental sidecar that runs Tencent’s desktop client on this machine.</p>
          <ul>
            <li>Unofficial. Linking an unofficial reader can affect your WeChat account. Only link your own.</li>
            <li>Text only. No media, and a message recalled in WeChat may stay in this archive.</li>
            <li>Linux amd64 Docker only. Railway and ARM machines cannot run the sidecar.</li>
          </ul>
          <p>You can turn it off here at any time. Importing stops and what was archived stays.</p>
        </div>
        {error && <p className="danger" role="alert">{error}</p>}
        <div className="actions">
          <button type="button" autoFocus disabled={pending} onClick={() => dialog.current?.close()}>Cancel</button>
          <button type="button" className="primary" disabled={pending} onClick={() => save(true)}>
            {pending ? 'Saving…' : 'Turn on WeChat'}
          </button>
        </div>
      </dialog>
    </section>
  )
}
