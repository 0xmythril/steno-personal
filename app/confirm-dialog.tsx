'use client'

import { useId, useRef, type MouseEvent, type ReactNode } from 'react'

// One grammar for anything that cannot be undone: an outlined trigger opens
// the consequence, a filled button inside acts on it. A native <dialog> so
// this needs no focus-trap library and no portal — showModal() traps focus
// and wires Escape for free, and .close() answers Cancel. The one thing a
// <details> could not do is lay out inside a table cell; a dialog is not in
// document flow, so it never fights the row it opens from.
//
// `children` is the caller's own form(s). Most callers pass a single
// <form action={…}> without its own submit button and a `confirm` label, and
// this component renders a filled button that submits that form. Every
// server action here redirects or revalidates the row out of existence, so
// there is no explicit close on success — the dialog's row is simply gone
// from the next render. A caller offering more than one outcome (the
// push-key row) passes complete forms, each with its own submit button, and
// no `confirm` label.
export function ConfirmDialog({ trigger, title, body, confirm, children }: {
  trigger: string
  title: string
  body: ReactNode
  confirm?: string
  children: ReactNode
}) {
  const ref = useRef<HTMLDialogElement>(null)
  const titleId = useId()

  const open = () => ref.current?.showModal()
  const close = () => ref.current?.close()
  // The form can arrive as a deferred server-rendered child. Cloning it to
  // append a button makes server and hydration output disagree. Submit the
  // actual form instead, preserving validation and the server action.
  const submit = () => ref.current?.querySelector('form')?.requestSubmit()

  // A click on the backdrop lands on the <dialog> element itself, never on
  // anything inside it, so this is the whole test — no coordinate math.
  const onBackdropClick = (e: MouseEvent<HTMLDialogElement>) => {
    if (e.target === ref.current) close()
  }

  return (
    <>
      <button type="button" className="confirm-open" onClick={open}>{trigger}</button>
      <dialog className="confirm" ref={ref} aria-labelledby={titleId} onClick={onBackdropClick}>
        <h3 id={titleId}>{title}</h3>
        <div className="confirm-body">{body}</div>
        {/* Cancel and the acting form(s) are siblings inside one flex row: any
            direct child of a flex container becomes a flex item regardless of
            its own display, so a plain <form> (block by default) lines up
            beside Cancel instead of falling to a row of its own. */}
        <div className="actions">
          <button type="button" onClick={close}>Cancel</button>
          {children}
          {confirm && <button type="button" className="danger" onClick={submit}>{confirm}</button>}
        </div>
      </dialog>
    </>
  )
}
