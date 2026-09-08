# Working in this repo

Read CONTRIBUTING.md first; its "Ground rules" are enforced by tests and are
not negotiable. Summary for an agent:

- Read-only channels, one importer per chat library, only the disclosed
  outbound calls and operator-enabled upgrades (CONTRIBUTING rule 3), no secret in a URL or
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

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
