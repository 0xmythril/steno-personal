import { describe, it, expect } from 'vitest'
import { contactFromUser } from '@/lib/channels/telegram'

// listContacts() itself is one bounded getContacts() call wrapped in
// classify(), and this binding has no fake MTProto client to drive it through.
// What is worth pinning is the mapping it applies to every user it gets back:
// the address book compares phone numbers as '+' + digits, so a number that
// arrives in any other shape must not reach the database in that shape.
describe('contactFromUser', () => {
  it('stringifies the id and normalises the phone number to +digits', () => {
    expect(contactFromUser({ id: 777000, displayName: 'Ada Lovelace', phoneNumber: '447700900123' }))
      .toEqual({ externalId: '777000', displayName: 'Ada Lovelace', phone: '+447700900123' })
  })

  it('accepts a bigint id and a number written with punctuation', () => {
    expect(contactFromUser({ id: 9007199254740993n, displayName: 'Bo', phoneNumber: '+44 7700 900123' }))
      .toEqual({ externalId: '9007199254740993', displayName: 'Bo', phone: '+447700900123' })
  })

  it('reads a missing name or number as null, never as an empty string', () => {
    // Telegram hides most contacts' numbers, and a deleted account has no name
    // at all. '' would compare equal to every other '' in the matcher.
    expect(contactFromUser({ id: 1, displayName: '', phoneNumber: '' }))
      .toEqual({ externalId: '1', displayName: null, phone: null })
    expect(contactFromUser({ id: 2 }))
      .toEqual({ externalId: '2', displayName: null, phone: null })
    expect(contactFromUser({ id: 3, displayName: '  ', phoneNumber: '--' }))
      .toEqual({ externalId: '3', displayName: null, phone: null })
  })
})
