# Architecture

Written for someone about to change the code. For what the software promises a
user, read [../PRIVACY.md](../PRIVACY.md); for what it protects against, read
[threat-model.md](threat-model.md).

## The shape of it

```
 phone ──QR──▶ portal (Next)            worker (tick loop, 3s)
                │  connections/…          │
                │  chats/…                ├─ SessionManager
                │  settings/…             │    ├─ ChannelPort: telegram (mtcute)
                │  /mcp  (bearer key)     │    └─ ChannelPort: whatsapp (Baileys)
                │  /media/[id]            ├─ media drain (downloadMedia)
                ▼                         └─ analysis drain (OpenRouter)
              SQLite  ◀────────────────────┘
              DATA_DIR/steno.db, DATA_DIR/media/, DATA_DIR/whatsapp/wa-<conn>/
```

## Two processes, one supervisor

`scripts/start.mjs` is plain Node with no TypeScript and no env schema. It

1. runs `scripts/boot.ts` once and refuses to continue if it fails — that
   creates `DATA_DIR`, resolves or generates `SECRET_KEY`, applies migrations,
   purges expired sessions, and mints the bootstrap key if no key exists;
2. spawns **web** (`next start`) and **worker** (`worker/index.ts` under `tsx`);
3. exits the moment either child exits, so the host restarts a clean container.

`RUN_WEB=false` or `RUN_WORKER=false` (the literal string, nothing else) runs
one of them alone, which is how you would split them across two Railway
services if you ever wanted to. The default is both in one container.

**Why two processes and not one.** The worker holds long-lived sockets to
Telegram and WhatsApp and must survive a Next.js hot reload, a request that
throws, and a redeploy of the UI. Next.js gives no lifecycle hook that can own a
socket honestly. So the worker is its own process and the two talk only through
the database.

**Why that is safe.** Both processes open the same SQLite file with WAL enabled
and `foreign_keys = ON`. WAL allows one writer and many concurrent readers
without blocking, and the write volume here is a handful of rows a second at
worst. There is no second database and no message broker: the `connections`
table *is* the queue for logins, and `media.status` *is* the queue for
downloads.

## The channel port

`lib/channels/port.ts` is the interface both channels implement, and it is the
main structural guarantee in the codebase. Its shape is the promise:

```ts
export interface ChannelSession {
  backfill(opts, shouldContinue?): AsyncIterable<IncomingMessage>
  onMessage(cb): void
  onEdit(cb): void
  onDelete(cb): void
  downloadMedia(raw): Promise<{ data: Buffer; mimeType: string | null }>
  ping(): Promise<void>
  logOut(): Promise<void>
  close(): Promise<void>
}
```

Eight methods, all reads except `logOut` (which ends *our own* session on the
channel's side) and `close`. There is no `send`, no `markRead`, no
`setPresence`, and adding one would mean changing the interface every channel
and every test is written against. That is the point.

`ChannelPort` adds `login(driver, opts)` and `open(sessionString, opts)`.
`LoginDriver` is the DB-mediated handshake: the worker publishes a QR string
into the connection row, the portal polls and renders it, and for Telegram's
2FA step the portal writes an encrypted password back for the worker to take.
Neither process calls the other.

`SessionManager` (`lib/channels/session-manager.ts`) holds a
`Map<Channel, ChannelPort>` and picks the port from the connection row's
`channel` column. It runs the login handshake, opens active connections,
schedules backfill, pings for liveness, handles revocation from either side,
and stops everything on SIGTERM. It is the only caller of the port.

**One importer per library.** `@mtcute/*` is imported by
`lib/channels/telegram.ts` and nothing else; `@whiskeysockets/baileys` by
`lib/channels/whatsapp.ts` and nothing else. `tests/launch-invariants.test.ts`
walks `lib/`, `app/`, `worker/` and `scripts/` and fails otherwise. Reviewing
"can this send a message?" then means reading two files.

Both channels normalise to one DTO, `IncomingMessage` (`lib/services/ingest.ts`),
and ingest is first-writer-wins on `(chat_id, external_message_id)`, so a
replayed backfill or a WhatsApp history dump arriving twice is a no-op.

## What lives where on the volume

`DATA_DIR` is the whole state of an instance. Nothing else on the filesystem
matters, which is what makes "back up = copy this directory" true.

```
$DATA_DIR/
├── steno.db            the archive: connections, chats, messages, media rows,
│                       access keys, sessions, settings, and the FTS5 index
├── steno.db-wal        SQLite write-ahead log  ─┐ transient, but copy them
├── steno.db-shm        SQLite shared memory    ─┘ with the database
├── secret.key          the generated SECRET_KEY, mode 0600, only when the
│                       environment variable is unset
├── media/              downloaded attachments, one file per media row, named
│                       <mediaId>.<ext>
└── whatsapp/
    └── wa-<connectionId>/   Baileys multi-file auth state (signal keys), one
                             directory per WhatsApp connection
```

WhatsApp's auth state is a directory of files rather than a string in the
database because Baileys rewrites its signal keys continuously; a single
encrypted blob would be the wrong shape and would lose writes. The directory
*name* is what gets encrypted into `connections.session_ciphertext`, so that
column means one thing for both channels. (Deletion also falls back to the
name recovered by decrypting that column, in case an older build ever wrote
the directory under a different name — belt and braces, not the common case.)

Deleting a connection cascades through chats, messages, media rows and analysis
rows, and the service also unlinks the media files and the auth directory.
Revoking (disconnecting) a connection is a database write: `revokeConnection`
marks the row revoked and nulls its credential ciphertext, immediately and
whatever else is running. Everything beyond the database is the worker's, and
therefore best effort. On the tick after a revoke it closes the session it was
running for that connection and asks the channel to log out — bounded by a
20 s timeout, falling back to `close()` — which is possible only while that
process is the one holding the session open; a Disconnect performed with the
worker stopped can never be logged out remotely, because the credential needed
to reopen the session is already gone. (Hence PRIVACY.md telling the owner to
check the phone's device list too.)

WhatsApp's auth directory is the one file-level thing a revoke does reach: the
worker removes `whatsapp/wa-<connectionId>/` on the tick that closes the
session, and sweeps any revoked WhatsApp row's directory on its next run, so a
Disconnect made while it was down is cleaned up when it comes back. Nothing
else on the volume moves: a revoked connection's already-downloaded media, and
any media rows still pending download, sit untouched until you delete the
connection.

## Storage notes

- Migrations are generated by `drizzle-kit` into `drizzle/` and applied by
  `scripts/boot.ts` at start-up, before either process serves anything. There is
  no separate migrate step to remember and no pre-deploy hook — which also
  matters on Railway, where volumes are not mounted during pre-deploy.
- Search is an FTS5 virtual table kept current by triggers on `messages`, plus a
  second row per message carrying text extracted from its attachments. Queries
  group by message id.
- There is no `users` table. The single user is implicit and no service takes a
  user id. Do not add one — it is the assumption the whole personal side rests on.

## Routes

| Route | Auth | Notes |
|---|---|---|
| `/login` | none | Paste an access key; sets the session cookie. |
| `/` | cookie | Chats list. |
| `/chats/[id]` | cookie | Transcript. No form, textarea, or submit control — enforced by a test. |
| `/connections` | cookie | One card per channel: consent, QR, disconnect, delete everything. |
| `/settings` | cookie | Access keys and enrichment. |
| `/api/health` | none | `{ "ok": true }`. Railway's healthcheck path. |
| `/api/login` | none | `POST {"key": "sp_…"}` → `204` and a session cookie. The scriptable twin of `/login`; used by `scripts/smoke.sh`. |
| `/api/connections`, `/api/connections/[id]`, `…/revoke`, `…/password` | cookie | Portal plumbing, including reads — a bearer key handed to an agent must never be able to pair or unpair a device. |
| `/api/chats`, `/api/chats/[id]/messages`, `/api/search` | cookie **or** bearer | Same data the portal shows. |
| `/media/[id]` | cookie **or** bearer | Streams one attachment, whole file into memory (bounded by `MAX_MEDIA_BYTES`), no `Range` support. |
| `/mcp` | bearer | The MCP endpoint. POST only — `mcp-handler` answers `GET`/`DELETE` with `405` itself, and streamable HTTP does not need them here. |

`lib/auth.ts#authenticateRequest` is the one place that resolves either
credential, for the routes that accept both. Server actions call
`requireSession()` themselves rather than trusting the page that rendered them.

## Adding a channel

1. Write `lib/channels/<name>.ts` implementing `ChannelPort`, importing its
   library and nothing else importing that library.
2. Add the value to the `Channel` union and to the `channel` enums in the schema.
3. Register the port in `lib/channels/ports.ts#buildPorts`.
4. Add a consent screen with the honest sentences for that channel.
5. Add the import-ban entry to `tests/launch-invariants.test.ts`.

Read spec §9 first: channels with a first-party agent connector (Slack, Discord)
are a non-goal, on purpose.
