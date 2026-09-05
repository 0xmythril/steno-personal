# Working in this repo

Read CONTRIBUTING.md first; its "Ground rules" are enforced by tests and are
not negotiable. Summary for an agent:

- Read-only channels, one importer per chat library, only the two disclosed
  and switchable outbound calls (CONTRIBUTING rule 3), no secret in a URL or
  log, deleted stays deleted, one user.
- Verify before claiming done: `npm run lint && npm run typecheck && npm test && npm run build`.
  Touching Dockerfile, start.mjs, migrations or auth: also `bash scripts/smoke.sh`.
- Fix a bug by writing the failing test first. Behaviour tests use the real
  SQLite database and services; mock only the network edge.
- Structural tests in `tests/` grep the source. If one fails, the promise it
  guards is what you broke — change the code, not the test, unless the
  change is deliberate and explained.
- New env var: `lib/env.ts` + `.env.example` + the `docs/self-hosting.md`
  Configuration table, together.
- UI: read `DESIGN.md` before touching anything under `app/`. Tokens live in
  `app/globals.css` and `tests/design-tokens.test.ts` guards them; no colour
  literal outside the token blocks, no font `<link>`, no pills.
- Schema change: a new `drizzle/NNNN_*.sql` via `npm run db:generate`.
- Commit as `type(scope): summary`; note user-visible changes under
  Unreleased in `CHANGELOG.md`.
- Never run a real account pairing, never paste a real key or phone number
  into a test, a fixture, or a document.
- `docs/superpowers/` and `.superpowers/` are local working notes and are
  git-ignored; do not reference them from anything that ships.
