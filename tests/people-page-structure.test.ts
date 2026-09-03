import { describe, it, expect, beforeEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'

// The behavioural half of this file runs the real server action against the
// real services and the real database. Only the two Next request-scope APIs it
// reaches through are stood in for: one in-memory cookie jar (the convention
// from tests/api-routes.test.ts) and a redirect() that throws its target, which
// is what Next's own redirect does.
const jar = new Map<string, string>()
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
    set: (name: string, value: string) => { jar.set(name, value) },
    delete: (opts: { name: string }) => { jar.delete(opts.name) },
  }),
  headers: async () => new Headers(),
}))
vi.mock('next/navigation', () => ({
  redirect: (url: string) => { throw new Error(`redirect:${url}`) },
}))

import { resetDb } from './helpers/db'
import { makeConnection } from './helpers/fixtures'
import { createPerson, getPerson, syncContacts } from '@/lib/services/people'
import { mintAccessKey } from '@/lib/services/access-keys'
import { startSession } from '@/lib/auth'
import {
  linkIdentityAction, updatePersonAction, deletePersonAction, unlinkIdentityAction,
} from '@/app/people/actions'

const actions = () => readFileSync('app/people/actions.ts', 'utf8')

describe('people pages', () => {
  it('every server action re-runs the session guard', () => {
    // A layout protects rendering, not the actions its pages post to — those
    // are directly callable. Checked per function, never as a total: a count
    // passes when a guardless new action is offset by a redundant guard.
    const src = actions()
    const blocks = src.split(/export async function /).slice(1)
    expect(blocks.length).toBeGreaterThan(0)
    const unguarded = blocks
      .map(b => ({ name: b.slice(0, b.indexOf('(')), body: b.slice(0, b.indexOf('\n}')) }))
      .filter(b => !b.body.includes('requireSession()'))
      .map(b => b.name)
    expect(unguarded).toEqual([])
  })

  it('never puts a name or a channel identity in a URL', () => {
    // A person's name is the thing this archive exists to keep local, and a
    // WhatsApp identity IS a phone number. Every proxy and access log between
    // here and the browser records a URL, so a redirect may carry only this
    // instance's own uuid — which names nobody — and a short error code.
    const src = actions()
    const args = [...src.matchAll(/redirect\(\s*(['"`])([\s\S]*?)\1\s*\)/g)].map(m => m[2])
    // Every redirect in the file must be one of those literals, or the sweep
    // below would silently skip the one that is not.
    expect(args.length).toBe((src.match(/\bredirect\(/g) ?? []).length)
    expect(args.length).toBeGreaterThan(0)
    for (const arg of args) {
      expect(arg, `redirect(${arg}): only /people, /people/<id> and ?error=<code>`)
        .toMatch(/^\/people(\/\$\{[A-Za-z][\w.]*\})?(\?error=[a-z_]+)?$/)
      expect(arg, `redirect(${arg}) names somebody`).not.toMatch(/name|phone|display/i)
    }
    // …and nothing hand-builds a query string out of one either.
    expect(src).not.toMatch(/redirect\([^)]*\b(name|phone|displayName|externalId)\b/)
  })

  it('the transcript page still offers no way to send anything', () => {
    // Person labels arrived on this page with the address book; linking did
    // not. Read-only stays a property of the page, not a promise in its copy.
    const src = readFileSync('app/chats/[id]/page.tsx', 'utf8')
    expect(src).not.toMatch(/<textarea|<form|type=["']submit["']|<input/)
    // It reaches the address book with a link, which is the whole allowance.
    expect(src).toMatch(/href="\/people"/)
  })

  it('shows the channel name muted when the address book disagrees', () => {
    const src = readFileSync('app/chats/[id]/page.tsx', 'utf8')
    // Both labels are rendered; how they are laid out is tests/transcript.ts's
    // business, not this file's — an exact JSX substring here would fail on a
    // reformat that changed nothing.
    expect(src).toMatch(/run\.rawLabel/)
    expect(src).toMatch(/run\.senderLabel/)
  })

  it('takes a linked identity\'s name and number from this instance, never from the post', () => {
    // The select showed "Ada · +4477…"; the Identities table reads display_name
    // and phone off the row the action creates. Resolving the candidate again
    // server-side is what keeps those two the same thing — and a posted id is
    // a browser string, so looking it up also checks it is one we know.
    const src = actions()
    const body = src.split('export async function linkIdentityAction')[1].split('\n}')[0]
    expect(body).toMatch(/listIdentityCandidates\(channel\)/)
    expect(body).toMatch(/displayName: candidate\.displayName/)
    expect(body).toMatch(/phone: candidate\.phone/)
    // And no action in the file reads a name or a number out of the form at
    // all: the complete set of keys any of them asks for, not a sample.
    const keys = [
      ...[...src.matchAll(/formData\.get\(\s*'([^']+)'\s*\)/g)].map(m => m[1]),
      ...[...src.matchAll(/field\(formData,\s*'([^']+)'\)/g)].map(m => m[1]),
    ]
    expect([...new Set(keys)].sort()).toEqual([
      'channel', 'externalId', 'identityId', 'name', 'notes', 'personId',
      'telegramExternalId', 'whatsappExternalId',
    ])
  })

  it('is reachable from the nav', () => {
    const src = readFileSync('app/nav.tsx', 'utf8')
    expect(src).toMatch(/href="\/people"/)
  })
})

// The same promise, run rather than read: the row the action writes is what
// the person page will render back.
describe('linkIdentityAction', () => {
  beforeEach(async () => {
    jar.clear()
    await resetDb()
  })

  async function signIn(): Promise<void> {
    const k = await mintAccessKey('portal')
    if (!k.ok) throw new Error(k.reason)
    await startSession(k.id)
  }

  it('stores the name and number the page showed beside the option', async () => {
    await signIn()
    const conn = await makeConnection({ channel: 'telegram' })
    await syncContacts(conn.id, 'telegram', [
      { externalId: '42', displayName: 'Ada', phone: '+44 7700 900123' },
    ])
    const { id } = await createPerson({ name: 'Ada Lovelace' })

    const form = new FormData()
    form.set('personId', id)
    form.set('channel', 'telegram')
    form.set('externalId', '42')
    // A forged post can carry these; the action must not be reading them.
    form.set('displayName', 'Not Ada')
    form.set('phone', '+15550000000')
    await expect(linkIdentityAction(form)).rejects.toThrow(`redirect:/people/${id}`)

    expect((await getPerson(id))!.identities).toEqual([expect.objectContaining({
      channel: 'telegram', externalId: '42',
      displayName: 'Ada', phone: '+447700900123', source: 'manual',
    })])
  })

  // Every action that can act on a row someone else has already deleted says
  // so, rather than reporting a success that did nothing.
  it('reports a stale person or link as gone instead of silently succeeding', async () => {
    await signIn()
    const { id } = await createPerson({ name: 'Ada Lovelace' })
    const form = (extra: Record<string, string> = {}) => {
      const f = new FormData()
      f.set('personId', id)
      for (const [k, v] of Object.entries(extra)) f.set(k, v)
      return f
    }
    // Deleted out from under all three, exactly as a second tab would.
    await expect(deletePersonAction(form())).rejects.toThrow(/^redirect:\/people$/)

    await expect(updatePersonAction(form({ name: 'Ada L', notes: '' })))
      .rejects.toThrow('redirect:/people?error=gone')
    await expect(deletePersonAction(form())).rejects.toThrow('redirect:/people?error=gone')
    await expect(unlinkIdentityAction(form({ identityId: 'no-such-identity' })))
      .rejects.toThrow(`redirect:/people/${id}?error=gone`)
  })

  it('refuses an identity this instance has never heard of', async () => {
    await signIn()
    const { id } = await createPerson({ name: 'Ada Lovelace' })
    const form = new FormData()
    form.set('personId', id)
    form.set('channel', 'telegram')
    form.set('externalId', '999')
    await expect(linkIdentityAction(form)).rejects.toThrow(`redirect:/people/${id}?error=unknown`)
    expect((await getPerson(id))!.identities).toEqual([])
  })
})
