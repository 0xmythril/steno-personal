import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { ChannelError } from '@/lib/channels/port'

describe('ChannelError', () => {
  it('carries a kind and names itself', () => {
    const e = new ChannelError('auth invalidated', 'auth_invalidated')
    expect(e).toBeInstanceOf(Error)
    expect(e.name).toBe('ChannelError')
    expect(e.kind).toBe('auth_invalidated')
    expect(e.message).toBe('auth invalidated')
  })
})

describe('the port is read-only by construction', () => {
  it('ChannelSession declares no send or mutate method', () => {
    // The guarantee is the ABSENCE of a method to call. Assert on the declared
    // surface, so widening it has to be a deliberate edit to this list too.
    const src = readFileSync('lib/channels/port.ts', 'utf8')
    const body = src.slice(src.indexOf('export interface ChannelSession'))
    const surface = body.slice(0, body.indexOf('\n}'))
    const declared = [...surface.matchAll(/^\s{2}(\w+)\s*[(<]/gm)].map(m => m[1])
    // Nine since the address book (people design decision 8): listContacts()
    // is the one member added to this surface, and it is a READ — the contact
    // list the owner's own account already holds. The count moved on purpose;
    // it does not move again without one.
    expect(declared.sort()).toEqual(
      ['backfill', 'close', 'downloadMedia', 'listContacts', 'logOut', 'onDelete', 'onEdit', 'onMessage', 'ping'],
    )
  })
})
