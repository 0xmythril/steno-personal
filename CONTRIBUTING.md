# Contributing

Thanks for looking. steno-personal is small on purpose: one person's chats,
one SQLite file, read-only by construction. Contributions that keep it that way
are welcome; contributions that widen it (multi-user, hosted, write access to
chats) will be declined however well made — see "What this project will not
become" below before you start.

## Ground rules

These are the promises the README, PRIVACY.md and SECURITY.md make to users.
Tests in `tests/` enforce each one, so a pull request that breaks a promise
fails CI rather than a reviewer's memory.

1. **Read-only.** No code path sends a message, marks a chat read, sets
   presence, reacts, or edits anything on the user's account. The transcript
   page has no compose control.
2. **One importer per chat library.** Only `lib/channels/telegram.ts` imports
   `@mtcute/*`; only `lib/channels/whatsapp.ts` imports Baileys. Everything
   else talks to the `ChannelPort` / `ChannelSession` interfaces in
   `lib/channels/port.ts`.
3. **Nothing leaves the machine** except the one OpenRouter call a user turns
   on. No analytics, telemetry, crash reporting, or update checks.
4. **Secrets never reach a URL, a log, or a response body.** Access keys and
   session material travel in httpOnly cookies or `Authorization` headers;
   logs use `errorShape()` from `lib/log.ts` and never print identifiers.
5. **Deleted stays deleted.** A message the sender unsent is never served by
   any read path.
6. **One person.** No users table, roles, sharing, or operator surface.

## Developing

```bash
nvm use            # Node 24, from .nvmrc
npm ci
cp .env.example .env
npm run dev        # web app on :3000 (worker is separate: npm run worker)
```

Before you push:

```bash
npm run lint && npm run typecheck && npm test && npm run build
```

`bash scripts/smoke.sh` builds the Docker image and drives a real container
through boot, login and the API; CI runs it on every push, so run it locally
when you touch the Dockerfile, `scripts/start.mjs`, migrations or auth.

## Tests

- Write the test first when fixing a bug: the failing test is the bug report.
- Behaviour tests hit the real SQLite database (each test file gets its own
  temporary `DATA_DIR`) and the real services. Mock only the network edge
  (`fetch`, the channel library) — see `lib/channels/fake-port.ts`.
- Structural tests (`tests/*-structure.test.ts`, `tests/launch-invariants.test.ts`)
  read source files and assert the ground rules above. If your change
  legitimately needs one loosened, change the test in the same pull request
  and say why in the description.

## Pull requests

- One change per pull request, with a description that says what a user
  would notice and why.
- Commit messages: `type(scope): imperative summary` — `fix(media): …`,
  `docs(launch): …`, `test: …`, `chore: …`.
- Add a line under **Unreleased** in `CHANGELOG.md` for anything a user would
  notice.
- New environment variables go in `lib/env.ts` (validated), `.env.example`,
  and the README's Configuration table, in the same change.
- Schema changes ship as a new `drizzle/NNNN_*.sql` migration generated with
  `npm run db:generate`; never edit an applied migration.
- No new runtime dependency without saying why in the description. The
  dependency sweep in `tests/launch-invariants.test.ts` bans analytics and
  Postgres drivers outright.

## What this project will not become

- A hosted service or a multi-user product.
- A bot, a bridge, or anything that writes to the user's account.
- A client for a third channel unless it fits behind `ChannelPort` with the
  same read-only guarantees and its own consent copy.

If you want one of those, fork it — the AGPL lets you — and please rename it.

## Releases

The maintainer cuts releases; the procedure is in
[docs/releasing.md](docs/releasing.md). A pull request never bumps the version
or edits a released changelog section.

## Reporting a security problem

Do not open a public issue. Follow [SECURITY.md](SECURITY.md).

## Licence

By contributing you agree that your contribution is licensed under the
[AGPL-3.0-only](LICENSE), like the rest of the project.
