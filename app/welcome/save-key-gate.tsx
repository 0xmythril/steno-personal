'use client'
import { useState } from 'react'

// Continue stays disabled until the key has actually been copied, or the
// reader says they wrote it down. Rendered inside the /welcome form; the
// server action it submits only drops the flash, so the gate is about not
// losing the key, not about authorisation.
export function SaveKeyGate({ rawKey }: { rawKey: string }) {
  const [copied, setCopied] = useState(false)
  const [written, setWritten] = useState(false)
  const copy = async () => {
    await navigator.clipboard.writeText(rawKey)
    setCopied(true)
  }
  return (
    <>
      <p>
        <code style={{ wordBreak: 'break-all' }}>{rawKey}</code>{' '}
        <button type="button" onClick={copy}>{copied ? 'Copied' : 'Copy'}</button>
      </p>
      <p>
        <label>
          <input type="checkbox" checked={written} onChange={e => setWritten(e.target.checked)} />
          {' '}I have saved this key somewhere safe
        </label>
      </p>
      <p>
        <button type="submit" disabled={!copied && !written}>Continue</button>
        {!copied && !written && <span className="muted"> Copy the key, or tick the box, to continue.</span>}
      </p>
    </>
  )
}
