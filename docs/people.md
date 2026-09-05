# People (the address book)

The archive stores channel identities — a Telegram user id, a WhatsApp number —
and **People** is the address book that groups them, so a chat and a transcript
can say *Ada* whether she wrote from Telegram or from WhatsApp. It is your own
annotation over the archive: nothing is sent back to either channel, and nothing
you write here changes a message.

## You are a person here too

After the first sync the address book holds one row for you, named after your
account and linked to each account you connect, and every message you sent
carries it as its `person`, so an agent can answer *"what did I tell Ada"* by id.
It stays out of the address-book table, which lists the people you talk to, and
`list_people` marks it `self: true`. Rename it on its page like anyone else.

## It fills itself in

After every contact sync, everyone in your contact list and the other side of
every direct chat becomes a person, named the way that channel names them, with
that identity linked. Nothing is invented: a person who has only ever written in
a group is not one of them, and neither is an identity with no name at all. The
page tags those rows **Auto** and the link says *found in your contacts*.

Two identities are joined into one person **only when their phone numbers are
equal**. That is the one match strong enough to act on by itself, and it needs a
number on both sides — a Telegram contact whose number Telegram will not show
you cannot be matched this way. An identical name is never enough: the two get a
row each, and the page offers to merge them and waits for you.

You can still open **People**, add a person, and link their identities yourself.
Everyone the archive knows about on a channel is offered — your contact list,
the other side of every direct chat, and anyone whose message it has archived —
under the name that channel knows them by, with their number where there is one.
An identity belongs to at most one person; move it by unlinking it first.

## Your name wins

A name that came off a contact list follows it: rename the contact on your phone
and the archive follows on the next sync. Type a name here and it becomes an
**alias** — no sync overwrites it, ever. *Use channel name* on their page hands
it back and the name starts following the channel again.

## Merge into

Two rows for one person is the normal state of an address book that filled
itself in. *Merge into* on a person's page moves all of their identities to
whoever you choose and removes the row you were on. The survivor keeps its name,
unless it only has a channel name and the row you merged carries an alias you
typed — a name a human chose outranks one copied off a phone.

## Suggestions

Because the address book fills itself in, two people who match already have a
row each — so a suggestion is a question about those two rows: *Merge Ada into
Ada?* It never acts on one by itself; confirming is a button you press.

- A pair is offered when one row has only Telegram identities, the other only
  WhatsApp, and the two names are the same once trimmed, ignoring
  capitalisation. "Ada L" and "Ada Lovelace" are not offered.
- Matching phone numbers never reach this list: those two are joined for you
  already. A name is all that is left when Telegram will not show you a
  contact's number — it hides one unless you have each other saved, or they let
  everyone see it — and a name is only ever a hint.
- **Confirm** moves every identity onto the older of the two rows and removes
  the other, exactly as *Merge into* does on a person's page.
- **Dismiss** remembers your no. It is remembered against the two identities,
  not the two rows, so it holds even if the rows are rebuilt by a later sync.
- Hidden people are never offered: hiding is already an answer.

## What your agent sees

A chat or a message gains a `person` field — `{ id, name }` — when the sender or
the other side of a direct chat is someone in your address book, and the
`list_people` tool lists it: id, name, your notes, which channels are linked, and
how many chats they appear in. Never a phone number, and never the underlying
Telegram id or WhatsApp number — the id is this instance's own and means nothing
outside it. The notes are the one field you write yourself and they go out
verbatim, so write them for an agent to read. `GET /api/people` answers the same
thing with the same key. See [mcp.md](mcp.md).

Two labels come from the same contact list, and they are not gated behind a
link. A name you saved in your contacts is used as the sender label for that
person's messages wherever the channel sent none — in the portal and to an agent
— and a WhatsApp chat or sender nobody has any name for shows as the phone
number that is its identity, again in both places. Neither adds a field: they
fill in `senderName` and a chat's title, which an access key can already read.

## Hiding someone

*Hide* takes a person out of the address book and away from your agents, and
keeps their links: that is what stops the next contact sync putting them back.
Hidden people are listed under **Hidden** at the foot of the People page with a
Restore button each, so nothing is lost. The chats, the messages and the
attachments are untouched either way, and their names go back to whatever the
channels call them. Deleting a *connection* clears the contacts read from that
account, but leaves your people alone — they are yours, not the channel's.
