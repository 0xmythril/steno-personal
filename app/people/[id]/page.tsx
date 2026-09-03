import Link from 'next/link'
import { notFound } from 'next/navigation'
import { requireSession } from '@/lib/auth'
import { Nav } from '@/app/nav'
import { getPerson, listPeople, listIdentityCandidates, type IdentityCandidate } from '@/lib/services/people'
import { listChats } from '@/lib/services/queries'
import { CHANNEL_LABELS } from '@/lib/format'
import type { Channel } from '@/lib/channels/port'
import { candidateLabel, PEOPLE_ERRORS, CHANNELS, SOURCE_LABELS } from '../labels'
import { updatePersonAction, deletePersonAction, linkIdentityAction, unlinkIdentityAction } from '../actions'

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

  return (
    <>
      <Nav label={session.label} current="people" />
      <main>
      <p className="muted"><Link href="/people">&larr; All people</Link></p>
      <h1>{person.name}</h1>
      {person.notes && <p>{person.notes}</p>}
      {error && <p className="danger" role="alert">{error}</p>}

      <section className="card">
        <h2>Name and notes</h2>
        <form action={updatePersonAction}>
          <input type="hidden" name="personId" value={person.id} />
          <label>Name <input name="name" defaultValue={person.name} maxLength={100} required /></label>{' '}
          <label>Notes <input name="notes" defaultValue={person.notes ?? ''} placeholder="optional" /></label>{' '}
          <button type="submit">Save</button>
        </form>
      </section>

      <section className="card">
        <h2>Identities</h2>
        {person.identities.length === 0 ? (
          <p className="muted">Nothing linked yet.</p>
        ) : (
          <table>
            <thead>
              <tr><th>Channel</th><th>Name there</th><th>Phone or id</th><th>Linked because</th><th></th></tr>
            </thead>
            <tbody>
              {person.identities.map(i => (
                <tr key={i.id}>
                  <td>{CHANNEL_LABELS[i.channel]}</td>
                  <td>{i.displayName ?? <span className="muted">no name</span>}</td>
                  <td><code>{i.phone ?? i.externalId}</code></td>
                  <td className="muted">{SOURCE_LABELS[i.source]}</td>
                  <td>
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
        )}

        <h3>Link another</h3>
        <p className="muted">
          Everyone this instance has heard of on that channel: your contacts, the other side of every
          direct chat, and anyone who has written in a group. One identity belongs to one person.
        </p>
        {CHANNELS.map(channel => (
          <div key={channel} style={{ margin: '0.5rem 0' }}>
            <form action={linkIdentityAction} className="inline">
              <input type="hidden" name="personId" value={person.id} />
              <input type="hidden" name="channel" value={channel} />
              <label>
                {CHANNEL_LABELS[channel]}{' '}
                <select name="externalId" defaultValue="">
                  <option value="">Choose someone…</option>
                  {candidates[channel].map(c => (
                    <option key={c.externalId} value={c.externalId} disabled={c.personId !== null}>
                      {candidateLabel(c)}
                      {c.personId !== null && ` (linked to ${nameOf.get(c.personId) ?? 'someone else'})`}
                    </option>
                  ))}
                </select>
              </label>{' '}
              <button type="submit">Link</button>
            </form>
          </div>
        ))}
      </section>

      <section className="card">
        <h2>Direct chats</h2>
        {theirChats.length === 0 ? (
          <p className="muted">None yet. Link an identity above and their direct chats appear here.</p>
        ) : (
          <table>
            <thead><tr><th>Chat</th><th>Channel</th><th>Messages</th></tr></thead>
            <tbody>
              {theirChats.map(c => (
                <tr key={c.id}>
                  <td><Link href={`/chats/${c.id}`}>{c.title ?? 'Untitled chat'}</Link></td>
                  <td className="muted">{CHANNEL_LABELS[c.channel]}</td>
                  <td className="muted">{c.messageCount}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="muted">Group chats they write in are not listed here; their name still shows on their messages.</p>
      </section>

      <section className="card">
        <h2>Delete</h2>
        <p className="muted">
          Removes this person and the links only. Every chat and message stays exactly where it is,
          under whatever name the channel stored.
        </p>
        <form action={deletePersonAction}>
          <input type="hidden" name="personId" value={person.id} />
          <button type="submit" className="danger">Delete this person</button>
        </form>
      </section>
      </main>
    </>
  )
}
