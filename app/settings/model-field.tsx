'use client'

import { useState } from 'react'

// The provider is the data-destination disclosure (lib/services/analysis-catalog.ts),
// so it cannot ride inside the option text: a closed select truncates its own
// tail, and no select is 466px wide on a phone. It gets its own line, which
// updates as you pick and is never cut off. Uncontrolled, so the form still
// submits the right model with JavaScript off; the line then reads the saved
// value, which is the one actually in effect.
export function ModelField({ label, name, options, selected }: {
  label: string
  name: string
  options: readonly { id: string; label: string; provider: string }[]
  selected: string
}) {
  const [id, setId] = useState(selected)
  const chosen = options.find(o => o.id === id) ?? options[0]
  return (
    <label className="field">
      <span>{label}</span>
      <select name={name} defaultValue={selected} onChange={e => setId(e.target.value)}>
        {options.map(o => <option key={o.id} value={o.id}>{o.label}</option>)}
      </select>
      <span className="help">Sends your files to <strong>{chosen.provider}</strong>.</span>
    </label>
  )
}
