'use server'

import { redirect } from 'next/navigation'
import { requireSession } from '@/lib/auth'
import {
  createPerson, getPerson, updatePerson,
  archivePerson, restorePerson, mergePeople, resetName,
  linkIdentity, unlinkIdentity, listIdentityCandidates,
  confirmSuggestion, dismissSuggestion,
} from '@/lib/services/people'
import type { Channel } from '@/lib/channels/port'

// Every action re-runs the guard. A layout protects rendering, not the server
// actions its pages post to, which are directly callable.
//
// Failure comes back as `?error=<code>` and nothing else. A person's name and
// a channel identity — which, on WhatsApp, IS a phone number — never go in a
// URL: every proxy and access log between here and the browser records one,
// and this archive's whole promise is that they do not. The only identifier a
// redirect may carry is this instance's own uuid, which names nobody.

const CHANNELS: Channel[] = ['telegram', 'whatsapp']
const asChannel = (v: unknown): Channel | null =>
  (CHANNELS as string[]).includes(String(v)) ? String(v) as Channel : null

const field = (formData: FormData, key: string): string => String(formData.get(key) ?? '').trim()

// createPerson and updatePerson throw RangeError on a name outside 1..100.
// That is the one bad input a form can produce, and it deserves a sentence
// rather than a 500 — anything else is a real fault and is rethrown.

export async function createPersonAction(formData: FormData): Promise<void> {
  await requireSession()
  let created: { id: string }
  try {
    created = await createPerson({ name: field(formData, 'name'), notes: field(formData, 'notes') })
  } catch (err) {
    if (err instanceof RangeError) redirect('/people?error=length')
    throw err
  }
  redirect(`/people/${created.id}`)
}

export async function updatePersonAction(formData: FormData): Promise<void> {
  await requireSession()
  const id = field(formData, 'personId')
  if (!id) redirect('/people')
  // Typing a name is aliasing the person: from then on no contact sync may
  // touch it (decision 13). Saving the box unchanged is not typing a name, so
  // the name is only passed on when it actually differs — otherwise adding a
  // note to someone the address book filled in for you would quietly freeze
  // their name, which is not what the owner asked for.
  const current = await getPerson(id)
  if (!current) redirect('/people?error=gone')
  const name = field(formData, 'name')
  let updated: boolean
  try {
    // An empty notes box means "clear the notes", which is what the service
    // does with a blank string. The name box is required by the form.
    updated = await updatePerson(id, {
      name: name === current.name ? undefined : name,
      notes: field(formData, 'notes'),
    })
  } catch (err) {
    if (err instanceof RangeError) redirect(`/people/${id}?error=length`)
    throw err
  }
  // The service says "no such row" when the person was hidden or merged away
  // while this page sat open — another tab, or the Hide button below it.
  // Saying so beats redirecting to a 404 that looks like the save itself broke.
  if (!updated) redirect('/people?error=gone')
  redirect(`/people/${id}`)
}

// The owner's "no, use whatever the channel calls them": the alias is dropped
// and the name follows the contact list again.
export async function resetNameAction(formData: FormData): Promise<void> {
  await requireSession()
  const id = field(formData, 'personId')
  if (!id) redirect('/people')
  const reset = await resetName(id)
  if (!reset) redirect('/people?error=gone')
  redirect(`/people/${id}`)
}

// Two rows, one person. `from` is emptied of its identities and deleted
// outright, so the page the owner ends up on is the survivor's.
export async function mergePeopleAction(formData: FormData): Promise<void> {
  await requireSession()
  const id = field(formData, 'personId')
  if (!id) redirect('/people')
  const intoId = field(formData, 'intoId')
  // The select opens on a placeholder with no value; submitting it is a slip.
  if (!intoId) redirect(`/people/${id}?error=empty`)
  if (intoId === id) redirect(`/people/${id}?error=self`)
  const merged = await mergePeople(id, intoId)
  // Either side hidden, merged away or never there: nothing happened, and the
  // person the owner was looking at is still the one to come back to.
  if (!merged) redirect(`/people/${id}?error=gone`)
  redirect(`/people/${intoId}`)
}

// Hides the person. Their links stay, so the populater never creates them
// again, and chats and messages are untouched — the address book is an
// annotation over the archive, never a part of it (decision 14). Reversible
// from the Hidden section of the People page.
export async function hidePersonAction(formData: FormData): Promise<void> {
  await requireSession()
  const id = field(formData, 'personId')
  const archived = id ? await archivePerson(id) : true
  if (!archived) redirect('/people?error=gone')
  redirect('/people')
}

export async function restorePersonAction(formData: FormData): Promise<void> {
  await requireSession()
  const id = field(formData, 'personId')
  if (!id) redirect('/people')
  const restored = await restorePerson(id)
  if (!restored) redirect('/people?error=gone')
  redirect(`/people/${id}`)
}

export async function linkIdentityAction(formData: FormData): Promise<void> {
  await requireSession()
  const id = field(formData, 'personId')
  if (!id) redirect('/people')
  const channel = asChannel(formData.get('channel'))
  const externalId = field(formData, 'externalId')
  // The select opens on a placeholder option with no value; submitting it is
  // a slip, not an error worth a 500.
  if (!channel || !externalId) redirect(`/people/${id}?error=empty`)
  // The name and the number come from THIS list, never from the form. The
  // select rendered the candidate as "Ada · +447700900123" and the Identities
  // table reads display_name and phone straight off the row it creates: a link
  // that stored neither would show `no name` next to a bare id the instant the
  // owner pressed the button, while a confirmed suggestion — which does pass
  // them — looked right. Resolving here also proves the posted id is one this
  // instance actually knows; the browser can put anything in that field.
  const candidate = (await listIdentityCandidates(channel)).find(c => c.externalId === externalId)
  if (!candidate) redirect(`/people/${id}?error=unknown`)
  const result = await linkIdentity(id, {
    channel, externalId,
    displayName: candidate.displayName, phone: candidate.phone,
  })
  if (!result.ok) {
    if (result.reason === 'no_person') redirect('/people?error=gone')
    redirect(`/people/${id}?error=linked`)
  }
  redirect(`/people/${id}`)
}

export async function unlinkIdentityAction(formData: FormData): Promise<void> {
  await requireSession()
  const id = field(formData, 'personId')
  const identityId = field(formData, 'identityId')
  const unlinked = identityId ? await unlinkIdentity(identityId) : true
  if (!id) redirect('/people')
  if (!unlinked) redirect(`/people/${id}?error=gone`)
  redirect(`/people/${id}`)
}

// The owner's yes to a suggestion. confirmSuggestion returns null when the
// pair has gone stale — either side linked since the page rendered, or the
// match no longer holds — and a stale post must not invent a person.
export async function confirmSuggestionAction(formData: FormData): Promise<void> {
  await requireSession()
  const created = await confirmSuggestion(
    field(formData, 'telegramExternalId'),
    field(formData, 'whatsappExternalId'),
  )
  if (!created) redirect('/people?error=stale')
  redirect(`/people/${created.id}`)
}

// The owner's no. Remembered, because the matcher would otherwise offer the
// same pair again on the next page load.
export async function dismissSuggestionAction(formData: FormData): Promise<void> {
  await requireSession()
  const telegramId = field(formData, 'telegramExternalId')
  const whatsappId = field(formData, 'whatsappExternalId')
  if (telegramId && whatsappId) await dismissSuggestion(telegramId, whatsappId)
  redirect('/people')
}
