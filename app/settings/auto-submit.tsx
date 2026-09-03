'use client'
import type { ChangeEvent, ReactNode } from 'react'

// Submits the enclosing form the moment a control inside it changes, so
// choosing a key fills the snippets in without a second click. The form's
// own Fill in button stays for keyboards and for a page without JavaScript.
export function AutoSubmit({ children }: { children: ReactNode }) {
  const submit = (e: ChangeEvent<HTMLDivElement>) => {
    (e.target as HTMLElement).closest('form')?.requestSubmit()
  }
  return <div className="auto-submit" onChange={submit}>{children}</div>
}
