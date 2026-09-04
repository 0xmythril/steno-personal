import Link from 'next/link'
import { requireSession } from '@/lib/auth'
import { Nav } from '@/app/nav'
import { listPeople, listArchivedPeople, listMergeSuggestions, ownerPerson, type PersonView } from '@/lib/services/people'
import { CHANNEL_LABELS } from '@/lib/format'
import { PEOPLE_ERRORS } from './labels'
import { createPersonAction, confirmSuggestionAction, dismissSuggestionAction, restorePersonAction } from './actions'

// The address book. Suggestions never merge anything on their own: an equal
// name is a hint, and the only path from a hint to one row is the "Merge them"
// button below, which the owner is the one to press.
export default async function PeoplePage({ searchParams }: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const session = await requireSession()
  const sp = await searchParams
  const error = typeof sp.error === 'string' ? PEOPLE_ERRORS[sp.error] : undefined
  const [people, hidden, suggestions, me] = await Promise.all([
    listPeople(), listArchivedPeople(), listMergeSuggestions(), ownerPerson(),
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
        <div className="page-head">
          <div><p className="eyebrow">Contacts</p><h1>People</h1></div>
          <span className="sub mono">{people.length} {people.length === 1 ? 'person' : 'people'}</span>
        </div>
        <p className="muted lede">
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
              happens until you say so. Merging keeps the older row and moves the other&apos;s identity
              onto it; keep them separate and the pair is not offered again.
            </p>
            <div className="tbl"><div className="scroll">
              <table>
                <thead><tr><th>Suggestion</th><th>Why</th><th></th></tr></thead>
                <tbody>
                  {suggestions.map(s => (
                    <tr key={`${s.from.id} ${s.into.id}`}>
                      {/* Which side is which channel, and which row is kept, said in
                          the sentence: two identical names on one line answered
                          neither. The channel words are set at the name's size so
                          they are not the smallest thing on the row. */}
                      <td className="name">
                        Add {s.from.name} <span className="on">on {CHANNEL_LABELS[s.from.channel]}</span> to{' '}
                        {s.into.name} <span className="on">on {CHANNEL_LABELS[s.into.channel]}</span>?
                      </td>
                      <td className="muted">
                        Same name · {CHANNEL_LABELS[s.into.channel]} row is older
                        {(s.into.chatCount > 0 || s.from.chatCount > 0) && (
                          <>, {s.into.chatCount} {s.into.chatCount === 1 ? 'chat' : 'chats'} to {s.from.chatCount}</>
                        )}
                      </td>
                      <td className="end">
                        <span className="actions">
                          <form action={confirmSuggestionAction} className="inline">
                            <input type="hidden" name="fromId" value={s.from.id} />
                            <input type="hidden" name="intoId" value={s.into.id} />
                            <button type="submit">Merge them</button>
                          </form>
                          <form action={dismissSuggestionAction} className="inline">
                            <input type="hidden" name="fromId" value={s.from.id} />
                            <input type="hidden" name="intoId" value={s.into.id} />
                            <button type="submit">Keep separate</button>
                          </form>
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div></div>
          </section>
        )}

        <section className="card">
          <h2>New person</h2>
          <p className="muted">
            For someone your contacts have not named yet. Link their Telegram and WhatsApp
            identities from their own page afterwards.
          </p>
          <form action={createPersonAction} className="row">
            <label className="field">
              <span>Name</span>
              <input name="name" maxLength={100} required placeholder="e.g. Ada" />
            </label>
            <label className="field">
              <span>Notes</span>
              <input name="notes" placeholder="Optional. Your own, never sent anywhere." />
            </label>
            <button type="submit" className="primary">Add person</button>
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
            <>
              <div className="tbl"><div className="scroll">
                <table>
                  <thead><tr><th>Name</th><th>Linked</th><th className="num">Chats</th></tr></thead>
                  <tbody>
                    {people.map(p => (
                      <tr key={p.id}>
                        <td className="name">
                          <Link href={`/people/${p.id}`}>{p.name}</Link>
                          {isAuto(p) && <> <span className="chip note">Auto</span></>}
                        </td>
                        <td className="muted">
                          {p.identities.length === 0
                            ? 'nothing yet'
                            : [...new Set(p.identities.map(i => CHANNEL_LABELS[i.channel]))].join(', ')}
                        </td>
                        <td className="num">{p.chatCount}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div></div>
              {/* The tag used to carry its meaning in a title attribute, which a
                  touch device never shows. */}
              <p className="help">Auto means the name came from your contacts and still follows it. Rename someone on their page and your name wins from then on.</p>
            </>
          )}
          {/* The owner is not in the table — it lists the people they talk
              to — but they are a person too: every message they sent carries
              this row for an agent, and the name is theirs to change. */}
          {me && (
            <p className="help">
              You are <Link href={`/people/${me.id}`}>{me.name}</Link> here: your own messages carry that
              name for your agents.
            </p>
          )}
        </section>

        {hidden.length > 0 && (
          <section className="card">
            <h2>Hidden ({hidden.length})</h2>
            <p className="muted">
              Hidden from the address book and from your agents. Their links are still here, which is
              what stops a contact sync from adding them back. Restore puts one on the list again.
            </p>
            <div className="tbl"><div className="scroll">
              <table>
                <thead><tr><th>Name</th><th>Linked</th><th></th></tr></thead>
                <tbody>
                  {hidden.map(p => (
                    <tr key={p.id}>
                      <td className="name">{p.name}</td>
                      <td className="muted">
                        {p.identities.length === 0
                          ? 'nothing'
                          : [...new Set(p.identities.map(i => CHANNEL_LABELS[i.channel]))].join(', ')}
                      </td>
                      <td className="end">
                        <form action={restorePersonAction} className="inline">
                          <input type="hidden" name="personId" value={p.id} />
                          <button type="submit">Restore to the address book</button>
                        </form>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div></div>
          </section>
        )}
      </main>
    </>
  )
}
