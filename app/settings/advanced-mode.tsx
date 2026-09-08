'use client'

import { useEffect, useId, useRef, useState, useTransition } from 'react'
import { setAdvancedModeAction } from './actions'

export function AdvancedMode({ enabled }: { enabled: boolean }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const toggle = useRef<HTMLButtonElement>(null)
  const returnFocus = useRef(false)
  const titleId = useId()
  const descriptionId = useId()
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
        await setAdvancedModeAction(next)
        returnFocus.current = true
        dialog.current?.close()
      } catch {
        setError('Could not save Advanced mode. Please try again.')
      }
    })
  }

  return (
    <section id="advanced-mode" className="card" aria-labelledby={titleId}>
      <div className="advanced-mode-row">
        <div className="stack">
          <h2 id={titleId}>Advanced mode</h2>
          <p id={descriptionId} className="muted">Show agent import and archive management controls.</p>
        </div>
        <button
          type="button"
          ref={toggle}
          role="switch"
          aria-checked={enabled}
          aria-labelledby={titleId}
          aria-describedby={descriptionId}
          className="mode-switch"
          disabled={pending}
          onClick={() => {
            setError(null)
            if (enabled) save(false)
            else dialog.current?.showModal()
          }}
        >
          <span className="mode-switch-track" aria-hidden="true"><span /></span>
          <span>{pending ? 'Saving…' : enabled ? 'On' : 'Off'}</span>
        </button>
      </div>
      <p className="help">Turning off hides these controls. Existing keys, imports, and History keep working.</p>
      {enabled && error && <p className="danger" role="alert">{error}</p>}
      <dialog
        ref={dialog}
        className="confirm advanced-mode-dialog"
        aria-labelledby={`${titleId}-dialog`}
        aria-describedby={`${descriptionId}-dialog`}
        onCancel={e => { if (pending) e.preventDefault() }}
        onClick={e => { if (!pending && e.target === dialog.current) dialog.current?.close() }}
      >
        <h3 id={`${titleId}-dialog`}>Turn on Advanced mode?</h3>
        <div className="confirm-body" id={`${descriptionId}-dialog`}>
          <p>You will see controls to:</p>
          <ul>
            <li>Create keys for agents to add, update, or delete archived messages.</li>
            <li>Set up imports and manage their sources.</li>
            <li>Resolve disputes: keep, replace, or delete an archived message.</li>
            <li>Export chats or remove a revoked key’s contributions.</li>
          </ul>
          <p>Push keys can change your archive. Give them only to agents you trust.</p>
          <p>Existing key permissions stay the same. Steno cannot send messages to Telegram or WhatsApp.</p>
        </div>
        {error && <p className="danger" role="alert">{error}</p>}
        <div className="actions">
          <button type="button" autoFocus disabled={pending} onClick={() => dialog.current?.close()}>Cancel</button>
          <button type="button" className="primary" disabled={pending} onClick={() => save(true)}>
            {pending ? 'Saving…' : 'Turn on Advanced mode'}
          </button>
        </div>
      </dialog>
    </section>
  )
}
