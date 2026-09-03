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
      <span className="token">
        <code>{rawKey}</code>
        <button type="button" className="small" onClick={copy}>{copied ? 'Copied' : 'Copy'}</button>
      </span>
      <label className="check">
        <input type="checkbox" checked={written} onChange={e => setWritten(e.target.checked)} />
        I have saved this key somewhere safe
      </label>
      <div className="actions">
        <button type="submit" className="primary" disabled={!copied && !written}>Continue</button>
        {!copied && !written && <span className="help">Copy the key, or tick the box, to continue.</span>}
      </div>
    </>
  )
}
