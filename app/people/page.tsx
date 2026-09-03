import Link from 'next/link'
import { requireSession } from '@/lib/auth'
import { Nav } from '@/app/nav'
import { listPeople, listSuggestions } from '@/lib/services/people'
import { CHANNEL_LABELS } from '@/lib/format'
import { candidateLabel, PEOPLE_ERRORS } from './labels'
import { createPersonAction, confirmSuggestionAction, dismissSuggestionAction } from './actions'

// The address book. Suggestions never link anything on their own: the only
// path from a match to a row is the Confirm button below, and the owner is the
// one who presses it.
export default async function PeoplePage({ searchParams }: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const session = await requireSession()
  const sp = await searchParams
  const error = typeof sp.error === 'string' ? PEOPLE_ERRORS[sp.error] : undefined
  const [people, suggestions] = await Promise.all([listPeople(), listSuggestions()])

  return (
    <>
      <Nav label={session.label} via={session.via} current="people" />
      <main>
      <h1>People</h1>
      <p className="muted">
        One person, both apps. Everything here is your own annotation over the archive: nothing is
        linked for you, and nothing is ever sent back to Telegram or WhatsApp.
      </p>
      {error && <p className="danger" role="alert">{error}</p>}

      {suggestions.length > 0 && (
        <section className="card">
          <h2>Suggestions</h2>
          <p className="muted">
            Same phone number, or the same name written the same way. Confirm one and it becomes a
            person with both identities linked; dismiss one and it is not offered again.
          </p>
          <table>
            <thead><tr><th>Telegram</th><th>WhatsApp</th><th>Why</th><th></th></tr></thead>
            <tbody>
              {suggestions.map(s => (
                <tr key={`${s.telegram.externalId} ${s.whatsapp.externalId}`}>
                  <td>{candidateLabel(s.telegram)}</td>
                  <td>{candidateLabel(s.whatsapp)}</td>
                  <td className="muted">{s.reason === 'phone' ? 'Same phone number' : 'Same name'}</td>
                  <td>
                    <form action={confirmSuggestionAction} className="inline">
                      <input type="hidden" name="telegramExternalId" value={s.telegram.externalId} />
                      <input type="hidden" name="whatsappExternalId" value={s.whatsapp.externalId} />
                      <button type="submit">Confirm</button>
                    </form>{' '}
                    <form action={dismissSuggestionAction} className="inline">
                      <input type="hidden" name="telegramExternalId" value={s.telegram.externalId} />
                      <input type="hidden" name="whatsappExternalId" value={s.whatsapp.externalId} />
                      <button type="submit">Dismiss</button>
                    </form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      <section className="card">
        <h2>New person</h2>
        <form action={createPersonAction}>
          <label>Name <input name="name" maxLength={100} required placeholder="e.g. Ada" /></label>{' '}
          <label>Notes <input name="notes" placeholder="optional" /></label>{' '}
          <button type="submit">Add</button>
        </form>
      </section>

      <section className="card">
        <h2>Address book</h2>
        {people.length === 0 ? (
          <p className="muted">Nobody yet. Add one above, then link their Telegram and WhatsApp identities.</p>
        ) : (
          <table>
            <thead><tr><th>Name</th><th>Linked</th><th>Chats</th></tr></thead>
            <tbody>
              {people.map(p => (
                <tr key={p.id}>
                  <td><Link href={`/people/${p.id}`}>{p.name}</Link></td>
                  <td className="muted">
                    {p.identities.length === 0
                      ? 'nothing yet'
                      : [...new Set(p.identities.map(i => CHANNEL_LABELS[i.channel]))].join(', ')}
                  </td>
                  <td className="muted">{p.chatCount}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
      </main>
    </>
  )
}
