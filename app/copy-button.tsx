'use client'
import { useState, type MouseEvent } from 'react'

export function CopyButton({ value, label = 'Copy' }: { value: string; label?: string }) {
  const [done, setDone] = useState(false)
  const copy = async (e: MouseEvent<HTMLButtonElement>) => {
    // Inside a <summary>, a click would also toggle the <details>.
    e.preventDefault()
    e.stopPropagation()
    await navigator.clipboard.writeText(value)
    setDone(true)
    setTimeout(() => setDone(false), 1500)
  }
  return (
    <button type="button" className="small" onClick={copy}>
      {done ? 'Copied' : label}
    </button>
  )
}
