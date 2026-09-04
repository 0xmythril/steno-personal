import Link from 'next/link'
import { requireSession } from '@/lib/auth'
import { Nav } from '@/app/nav'
import { listPeople, listArchivedPeople, listMergeSuggestions, type PersonView } from '@/lib/services/people'
import { CHANNEL_LABELS } from '@/lib/format'
import { PEOPLE_ERRORS } from './labels'
import { createPersonAction, confirmSuggestionAction, dismissSuggestionAction, restorePersonAction } from './actions'

// The address book. Suggestions never merge anything on their own: an equal
// name is a hint, and the only path from a hint to one row is the Confirm
// button below, which the owner is the one to press.
export default async function PeoplePage({ searchParams }: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const session = await requireSession()
  const sp = await searchParams
  const error = typeof sp.error === 'string' ? PEOPLE_ERRORS[sp.error] : undefined
  const [people, hidden, suggestions] = await Promise.all([
    listPeople(), listArchivedPeople(), listMergeSuggestions(),
  ])

  // A row the address book wrote for itself: a name copied off a contact list,
  // still following it. The moment the owner types a name of their own it is
  // an alias and the tag goes — the tag is about where the NAME came from, not
  // about who is allowed to be here.
  const isAuto = (p: PersonView): boolean =>
    p.nameSource === 'channel' && p.identities.some(i => i.source === 'auto')

  return (
    <>
      <Nav label={session.label} via={session.via} current="people" />
      <main>
      <h1>People</h1>
      <p className="muted">
        One person, both apps. Everyone in your contacts is here already, and everything on this
        page is your own annotation over the archive: nothing is ever sent back to Telegram or
        WhatsApp.
      </p>
      {error && <p className="danger" role="alert">{error}</p>}

      {suggestions.length > 0 && (
        <section className="card">
          <h2>Suggestions</h2>
          <p className="muted">
            Two rows with the same name, one found on Telegram and one on WhatsApp. A name is only
            ever a hint — matching phone numbers are joined for you, names are not — so nothing
            happens until you say so. Confirm moves every identity onto the older row and removes
            the other; dismiss and the pair is not offered again.
          </p>
          <table>
            <thead><tr><th>Suggestion</th><th>Why</th><th></th></tr></thead>
            <tbody>
              {suggestions.map(s => (
                <tr key={`${s.from.id} ${s.into.id}`}>
                  <td>Merge {s.from.name} into {s.into.name}?</td>
                  <td className="muted">Same name</td>
                  <td>
                    <form action={confirmSuggestionAction} className="inline">
                      <input type="hidden" name="fromId" value={s.from.id} />
                      <input type="hidden" name="intoId" value={s.into.id} />
                      <button type="submit">Confirm</button>
                    </form>{' '}
                    <form action={dismissSuggestionAction} className="inline">
                      <input type="hidden" name="fromId" value={s.from.id} />
                      <input type="hidden" name="intoId" value={s.into.id} />
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
          <p className="muted">
            Nobody yet. Your contacts arrive here after the first sync; until then, add someone
            above and link their Telegram and WhatsApp identities.
          </p>
        ) : (
          <table>
            <thead><tr><th>Name</th><th>Linked</th><th>Chats</th></tr></thead>
            <tbody>
              {people.map(p => (
                <tr key={p.id}>
                  <td>
                    <Link href={`/people/${p.id}`}>{p.name}</Link>
                    {isAuto(p) && <> <span className="eyebrow" title="Named from your contacts">Auto</span></>}
                  </td>
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

      {hidden.length > 0 && (
        <section className="card">
          <h2>Hidden ({hidden.length})</h2>
          <p className="muted">
            Hidden from the address book and from your agents. Their links are still here, which is
            what stops a contact sync from adding them back. Restore puts one on the list again.
          </p>
          <table>
            <thead><tr><th>Name</th><th>Linked</th><th></th></tr></thead>
            <tbody>
              {hidden.map(p => (
                <tr key={p.id}>
                  <td>{p.name}</td>
                  <td className="muted">
                    {p.identities.length === 0
                      ? 'nothing'
                      : [...new Set(p.identities.map(i => CHANNEL_LABELS[i.channel]))].join(', ')}
                  </td>
                  <td>
                    <form action={restorePersonAction} className="inline">
                      <input type="hidden" name="personId" value={p.id} />
                      <button type="submit">Restore</button>
                    </form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
      </main>
    </>
  )
}
