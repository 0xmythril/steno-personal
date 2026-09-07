'use client'
import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { PencilIcon } from '@/app/icons'
import { renameKeyAction } from './actions'

// A key's label reads as plain text until the owner asks to change it: a
// table of five keys used to render five always-open inputs, a "Label"
// caption and a Rename button apiece, before this existed. The pencil is a
// real button — an accessible name, a visible focus ring, reachable by tap
// and by keyboard — never a hover reveal, because the owner uses this table
// on a phone.
//
// A rename failure starts the row already in the editing state: the caller
// passes `error`, and this component is remounted (see the `key` it is given
// in app/settings/page.tsx) whenever the label or the error changes, which is
// what returns it to read-only text after a successful save and keeps it open
// with the failure message after a rejected one.
//
// `maxLength` arrives as a prop from lib/services/access-keys' MAX_LABEL_LENGTH
// rather than being imported here directly: that module's top-level import of
// the SQLite client makes it a server-only module, and a 'use client' file
// that imports it pulls better-sqlite3 into the browser bundle and fails the
// build.
//
// Focus follows the switch, in both directions. Opening moves focus onto the
// input (`autoFocus` — the input is a freshly mounted node every time editing
// turns on, so the attribute fires). Closing — Cancel, Escape, or a Save that
// has just been submitted — unmounts whatever was focused inside the form, so
// `pencilRef` and `returnFocusRef` carry focus back to the pencil that opened
// it; without this a keyboard user lands on <body> and their next Tab
// restarts at the top of the document.
export function EditableLabel({
  keyId,
  label,
  maxLength,
  error,
}: {
  keyId: string
  label: string
  maxLength: number
  error?: string | null
}) {
  const [editing, setEditing] = useState(Boolean(error))
  const pencilRef = useRef<HTMLButtonElement>(null)
  const returnFocusRef = useRef(false)

  useEffect(() => {
    if (!editing && returnFocusRef.current) {
      returnFocusRef.current = false
      pencilRef.current?.focus()
    }
  }, [editing])

  const cancel = () => {
    returnFocusRef.current = true
    setEditing(false)
  }

  if (!editing) {
    return (
      <span className="editable-label">
        {label}
        <button ref={pencilRef} type="button" className="icon-btn" aria-label={`Rename ${label}`} onClick={() => setEditing(true)}>
          <PencilIcon />
        </button>
      </span>
    )
  }

  const onKeyDown = (e: KeyboardEvent<HTMLFormElement>) => {
    if (e.key === 'Escape') { e.preventDefault(); cancel() }
  }
  // A no-op save (the owner opens the pencil and submits the same text back)
  // changes neither the label nor the error, so the row's key in page.tsx is
  // stable and this component never remounts to reset `editing` on its own.
  // Close here instead — this only updates local state, so the submit still
  // reaches renameKeyAction; nothing here calls preventDefault.
  const onSubmit = () => {
    returnFocusRef.current = true
    setEditing(false)
  }

  return (
    <form action={renameKeyAction} className="inline" onKeyDown={onKeyDown} onSubmit={onSubmit}>
      <input type="hidden" name="keyId" value={keyId} />
      <label className="field">
        <span>Label</span>
        <input name="label" defaultValue={label} maxLength={maxLength} required autoFocus />
        {error && (
          <p className="danger" role="alert">
            {error === 'label_too_long' ? `Label is too long (max ${maxLength}).`
              : error === 'label_empty' ? 'Label cannot be empty.'
              : 'That key no longer exists.'}
          </p>
        )}
      </label>
      <button type="submit" className="small">Save</button>
      <button type="button" className="small" onClick={cancel}>Cancel</button>
    </form>
  )
}
