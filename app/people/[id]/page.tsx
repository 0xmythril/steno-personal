import Link from 'next/link'
import { notFound } from 'next/navigation'
import { requireSession } from '@/lib/auth'
import { Nav } from '@/app/nav'
import { getPerson, listPeople, listIdentityCandidates, type IdentityCandidate } from '@/lib/services/people'
import { listChats } from '@/lib/services/queries'
import { CHANNEL_LABELS } from '@/lib/format'
import type { Channel } from '@/lib/channels/port'
import { candidateLabel, PEOPLE_ERRORS, CHANNELS, SOURCE_LABELS } from '../labels'
import {
  updatePersonAction, resetNameAction, mergePeopleAction, hidePersonAction,
  linkIdentityAction, unlinkIdentityAction,
} from '../actions'

// One person: what they are called here, which channel identities are theirs,
// and the direct chats those identities are the other side of.
export default async function PersonPage({ params, searchParams }: {
  params: Promise<{ id: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const session = await requireSession()
  const { id } = await params
  const sp = await searchParams
  const error = typeof sp.error === 'string' ? PEOPLE_ERRORS[sp.error] : undefined

  const person = await getPerson(id)
  if (!person) notFound()

  const [everyone, chats, telegram, whatsapp] = await Promise.all([
    listPeople(),
    listChats(),
    listIdentityCandidates('telegram'),
    listIdentityCandidates('whatsapp'),
  ])
  // Who each already-linked candidate belongs to, so the option can say so
  // instead of silently refusing when it is submitted.
  const nameOf = new Map(everyone.map(p => [p.id, p.name]))
  const candidates: Record<Channel, IdentityCandidate[]> = { telegram, whatsapp }
  // listChats resolves the person for direct chats only: a group is a room,
  // not someone. The copy below says so rather than implying completeness.
  const theirChats = chats.filter(c => c.person?.id === person.id)
  // Everyone this person could be merged into. Themselves excluded, because
  // "merge into me" is a slip rather than an instruction; hidden people are
  // not in listPeople at all, and merging into one would resurrect nothing.
  const others = everyone.filter(p => p.id !== person.id)

  return (
    <>
      <Nav label={session.label} via={session.via} current="people" />
      <main>
        <p className="muted"><Link href="/people">&larr; All people</Link></p>
        <div className="page-head">
          <div>
            <p className="eyebrow">Person</p>
            <h1>
              {person.name}
              {person.nameSource === 'owner' && <> <span className="chip note">alias</span></>}
            </h1>
          </div>
        </div>
        {person.notes && <p className="lede">{person.notes}</p>}
        {error && <p className="danger" role="alert">{error}</p>}

        <section className="card">
          <h2>Name and notes</h2>
          {person.nameSource === 'owner' ? (
            <p className="muted">
              This is your name for them, and no contact sync will overwrite it. Hand it back and
              they are called whatever the channel calls them, now and after every later sync.
            </p>
          ) : (
            <p className="muted">
              This name comes from your contacts and follows it: rename them here and your name wins
              from then on.
            </p>
          )}
          <form action={updatePersonAction} className="row">
            <input type="hidden" name="personId" value={person.id} />
            <label className="field">
              <span>Name</span>
              <input name="name" defaultValue={person.name} maxLength={100} required />
            </label>
            <label className="field">
              <span>Notes</span>
              <input name="notes" defaultValue={person.notes ?? ''} placeholder="Optional. Your own, never sent anywhere." />
            </label>
            <button type="submit" className="primary">Save name and notes</button>
          </form>
          {person.nameSource === 'owner' && (
            <form action={resetNameAction}>
              <input type="hidden" name="personId" value={person.id} />
              <button type="submit">Use channel name</button>
            </form>
          )}
        </section>

        <section className="card">
          <h2>Identities</h2>
          {person.identities.length === 0 ? (
            <p className="muted">Nothing linked yet.</p>
          ) : (
            <div className="tbl"><div className="scroll">
              <table>
                <thead>
                  <tr><th>Channel</th><th>Name there</th><th>Phone or id</th><th>Linked because</th><th></th></tr>
                </thead>
                <tbody>
                  {person.identities.map(i => (
                    <tr key={i.id}>
                      <td className="name">{CHANNEL_LABELS[i.channel]}</td>
                      <td>{i.displayName ?? <span className="muted">no name</span>}</td>
                      <td><code>{i.phone ?? i.externalId}</code></td>
                      <td className="muted">{SOURCE_LABELS[i.source]}</td>
                      <td className="end">
                        <form action={unlinkIdentityAction} className="inline">
                          <input type="hidden" name="personId" value={person.id} />
                          <input type="hidden" name="identityId" value={i.id} />
                          <button type="submit">Unlink</button>
                        </form>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div></div>
          )}

          <h3>Link another</h3>
          <p className="muted">
            Everyone this instance has heard of on that channel: your contacts, the other side of every
            direct chat, and anyone who has written in a group. One identity belongs to one person.
          </p>
          {CHANNELS.map(channel => (
            <form key={channel} action={linkIdentityAction} className="row">
              <input type="hidden" name="personId" value={person.id} />
              <input type="hidden" name="channel" value={channel} />
              <label className="field">
                <span>{CHANNEL_LABELS[channel]}</span>
                <select name="externalId" defaultValue="">
                  <option value="">Choose someone…</option>
                  {candidates[channel].map(c => (
                    <option key={c.externalId} value={c.externalId} disabled={c.personId !== null}>
                      {candidateLabel(c)}
                      {c.personId !== null && ` (linked to ${nameOf.get(c.personId) ?? 'someone else'})`}
                    </option>
                  ))}
                </select>
              </label>
              <button type="submit">Link this identity</button>
            </form>
          ))}
        </section>

        <section className="card">
          <h2>Direct chats</h2>
          {theirChats.length === 0 ? (
            <p className="muted">None yet. Link an identity above and their direct chats appear here.</p>
          ) : (
            <div className="tbl"><div className="scroll">
              <table>
                <thead><tr><th>Chat</th><th>Channel</th><th className="num">Messages</th></tr></thead>
                <tbody>
                  {theirChats.map(c => (
                    <tr key={c.id}>
                      <td className="name"><Link href={`/chats/${c.id}`}>{c.title ?? 'Untitled chat'}</Link></td>
                      <td className="muted">{CHANNEL_LABELS[c.channel]}</td>
                      <td className="num">{c.messageCount}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div></div>
          )}
          <p className="help">Group chats they write in are not listed here; their name still shows on their messages.</p>
        </section>

        <section className="card">
          <h2>Merge into</h2>
          <p className="muted">
            Two rows for one person. Every identity here moves to whoever you choose, and this row is
            deleted for good — Hide can be undone, this cannot. The other one keeps its name, unless
            it only has a channel name and this one carries a name you typed, and it takes these
            notes if it has none of its own. Chats and messages are untouched.
          </p>
          {others.length === 0 ? (
            <p className="muted">Nobody else to merge into yet.</p>
          ) : (
            // Gated like every other action that cannot be undone: the summary
            // opens the consequence, the filled button inside is the one that acts.
            <details className="confirm">
              <summary>Merge this person into another</summary>
              <div className="confirm-body">
                <p>
                  This row is deleted for good, and {person.identities.length === 1
                    ? 'its one identity moves'
                    : `its ${person.identities.length} identities move`} to whoever you pick. There is
                  no undo — Hide, further down, is the reversible one.
                </p>
                <form action={mergePeopleAction} className="row">
                  <input type="hidden" name="personId" value={person.id} />
                  <label className="field">
                    <span>Move everything to</span>
                    <select name="intoId" defaultValue="">
                      <option value="">Choose someone…</option>
                      {others.map(p => (
                        <option key={p.id} value={p.id}>{p.name}</option>
                      ))}
                    </select>
                  </label>
                  <button type="submit" className="danger">Merge and delete this row</button>
                </form>
              </div>
            </details>
          )}
        </section>

        <section className="card">
          <h2>Hide</h2>
          <p className="muted">
            Hides this person from the address book and from agents. Their links stay, so they will
            not be recreated. You can restore them from the People page.
          </p>
          <form action={hidePersonAction}>
            <input type="hidden" name="personId" value={person.id} />
            <button type="submit" className="danger">Hide this person</button>
          </form>
        </section>
      </main>
    </>
  )
}
