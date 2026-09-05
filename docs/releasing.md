# Releasing

One maintained line, tagged releases, semantic versions. A release is a commit
on `main` whose tag is `vX.Y.Z`, plus a GitHub release whose notes are the
matching section of [`../CHANGELOG.md`](../CHANGELOG.md).

## Environments

Three, in a line. Code only ever moves left to right.

| | Runs | Deployed from | Data |
|---|---|---|---|
| **development** | your machine — `npm run dev`, or `docker compose up` | your working tree | `./data`, throwaway |
| **staging** | a hosted instance the maintainer keeps | the `staging` branch, on every push | its own volume, its own generated `SECRET_KEY` |
| **production** | the maintainer's own instance | the `main` branch, on every push | the real archive |

Staging and production share nothing. Separate volumes, separate secret keys,
separate paired accounts — staging cannot read the production archive, and a
migration that eats the staging database has not touched the real one. Setting
that up is ordinary hosting, not something this repo configures: the deploy
platform watches the two branches, and nothing in git can reach either
instance.

`main` is still the release line: it is what gets tagged, and it is what the
one-click deploy button builds. `staging` is the integration branch that
everything passes through first.

If you fork this, the same shape works anywhere that can watch two branches.
Nothing below depends on a particular host.

## The promotion

```
feature branch  ──PR──▶  staging  ──PR──▶  main
                            │                │
                            ▼                ▼
                     staging env        production env
```

1. Branch from `staging`. Build, and run the gate locally
   (`npm run lint && npm run typecheck && npm test && npm run build`).
2. Open a pull request **into `staging`**. CI runs lint, typecheck, tests, the
   build and the Docker smoke test on the push.
3. Merge. The staging instance rebuilds from the branch; wait for its health
   check at `/api/health` to go green.
4. Exercise it — the paths the unit tests cannot reach: boot on a real volume,
   migrations applied over existing data, a pairing flow, login, and the MCP
   endpoint under a real bearer token.
5. When staging has been green for as long as the change deserves, open a pull
   request from `staging` into `main`. Merging it deploys production.

A hotfix is the same shape, not an exception: branch from `staging`, merge to
`staging`, promote. The pipeline is short enough that skipping it buys minutes
and costs the archive.

### Standing up a staging instance

A staging instance is a normal deploy of this app, so
[self-hosting.md](self-hosting.md) covers it. Two things are specific to
staging:

- **Its volume starts empty, so `/setup` is open to whoever reaches the URL
  first.** Set `STENO_MINT_KEY` on it so a key is minted and printed to the
  boot log on first start; `/setup` closes as soon as any key row exists. Read
  the key out of the log — the banner prints once per value. `STENO_RESET`
  clears the marker, so a wipe mints a fresh key on the next boot. Both are
  documented under "Lost access" in [self-hosting.md](self-hosting.md).
- **Give it its own `SECRET_KEY` and its own volume.** Sharing either with
  production defeats the point of having a staging instance at all.

## Release candidates

Anything sitting on `staging` that is meant for the next release can be tagged
so other people can run it without waiting for the release:

```bash
git checkout staging && git pull
git tag -a vX.Y.Z-rc.N -m "vX.Y.Z-rc.N"
git push origin vX.Y.Z-rc.N
gh release create vX.Y.Z-rc.N --prerelease --title "vX.Y.Z-rc.N" \
  --notes "Release candidate for vX.Y.Z. See the Unreleased section of CHANGELOG.md."
```

A pre-release is marked as such on GitHub, so it never displaces the latest
stable release for someone who just wants the version that works. Self-hosters
who want the newest code check out the tag and run it on their own instance —
there is no shared instance to look at, and there will not be one: this
project is one archive for one person, and a public demo would mean either a
real account paired to it or a stranger claiming the deploy.

Release-candidate tags are never merged back or reused. The eventual `vX.Y.Z`
is cut from `main` in the normal way.

## Before tagging

1. `main` is green: the `ci` workflow runs lint, typecheck, tests, the build,
   and the Docker smoke test on every push. Do not tag a red commit.
2. The commit being tagged has already run on staging. `main` only ever
   receives merges from `staging`, so this is normally automatic — check it
   anyway with `git log --oneline staging..main`, which should be empty.
3. Every user-visible change since the last tag has a line under
   **Unreleased** in the changelog. Read the diff since the last tag
   (`git log v0.1.0..main --oneline`) and fill in what is missing.
4. Nothing private is about to ship: no real key, phone number, or session
   material in a fixture, a document, or a log excerpt. `git grep -n sp_` and
   `git grep -nE '\+[0-9]{8,}'` should find only placeholders.

## Cutting the release

```bash
git checkout main && git pull
npm version X.Y.Z --no-git-tag-version   # bumps package.json and the lockfile
```

Then in `CHANGELOG.md`:

- rename `## [Unreleased]` to `## [X.Y.Z] — YYYY-MM-DD` and open a fresh,
  empty `## [Unreleased]` above it;
- at the foot, point `[Unreleased]` at `compare/vX.Y.Z...HEAD` and add
  `[X.Y.Z]: https://github.com/0xmythril/steno-personal/releases/tag/vX.Y.Z`.

Run the full gate once more, including the smoke test, because the version
bump touches the lockfile the image is built from:

```bash
npm run lint && npm run typecheck && npm test && npm run build && bash scripts/smoke.sh
```

Commit, tag, and push:

```bash
git commit -am "chore(release): vX.Y.Z"
git tag -a vX.Y.Z -m "vX.Y.Z"
git push origin main --follow-tags
```

Create the GitHub release from the tag with the changelog section as its body:

```bash
gh release create vX.Y.Z --title "vX.Y.Z" --notes-file <(sed -n '/^## \[X.Y.Z\]/,/^## \[/p' CHANGELOG.md | sed '$d')
```

## After tagging

- Bring `staging` back in line with `main` so the next branch starts from the
  released commit. After a clean promotion they are already equal; a merge
  commit made on `main` is the usual reason they are not:

  ```bash
  git checkout staging && git merge --ff-only main && git push origin staging
  ```

  If `--ff-only` refuses, something reached `main` without going through
  staging. Find out what before you carry on.
- If the Dockerfile, `railway.json`, or the deploy instructions changed,
  update the Railway template so a one-click deploy builds the new release;
  see [The Railway template](#the-railway-template) below.
- If the release fixes a reported vulnerability, publish the advisory from
  the repository's Security tab and credit the reporter if they asked to be.

## Versioning

- **Patch**: a fix with no change to configuration, schema, or the MCP tools.
- **Minor**: a new feature, a new environment variable, or a new migration.
  Migrations apply forward at boot; a minor release never requires the user
  to do anything beyond `git pull` and a restart.
- **Major**: anything that needs manual action on the volume, changes the
  meaning of an existing environment variable, or removes an MCP tool.

## The Railway template

The template is published as `steno-personal` — id
`546731b9-54bf-467b-9d40-67f685511bb6`, editor
<https://railway.com/workspace/templates/546731b9-54bf-467b-9d40-67f685511bb6>,
marketplace page <https://railway.com/deploy/steno-personal> — generated from
the `steno-personal` project in the maintainer's workspace and published on
2026-09-05. A draft carries a random code (`1Vhm3c` was this one's);
**publishing replaces it with the slug**, and the old code stops resolving the
moment it does, so the README button is updated in the same sitting. This is
the whole procedure, kept for the day the template has to be rebuilt. It is manual on
purpose — Railway has no committed template manifest; a template is built in the
dashboard composer or generated from a live project, per
<https://docs.railway.com/templates/create>. Verify against that page before you
start, in case Railway has since shipped a file format.

**1. Build a working project first.** Follow the Railway section of [self-hosting.md](self-hosting.md#railway) and get a
real deploy green, with the volume attached and Setup served on the generated
domain. A template generated from something that works is worth more than one
assembled blind.

**2. Create the template.** Either

- dashboard: project **Settings → Generate Template from Project → Create
  Template**, then confirm the settings in the composer; or
- CLI: `railway templates create --project steno-personal --environment production`
  (`railway template` is an accepted alias; see <https://docs.railway.com/cli/templates>).

The CLI clones the project's variables verbatim. Do **not** set
`SECRET_KEY=${{secret(48)}}` on the live project first: Railway evaluates the
function there and stores the resulting string, so the clone would hand every
deployer the same secret. Leave `SECRET_KEY` off the project and add the
function in the template editor (step 4).

**3. Check the service in the composer.**

- Source: the GitHub repo `0xmythril/steno-personal`. To pin a branch, paste the
  full branch URL, e.g. `https://github.com/0xmythril/steno-personal/tree/main`.
- Build: Dockerfile — it should already be picked up from `railway.json`.
- Healthcheck path: `/api/health`.
- Public networking: HTTP, enabled.

**4. Set the variables.** Three fixed, plus the two Telegram credentials the
deployer fills in:

| Variable | Value | Why |
|---|---|---|
| `DATA_DIR` | `/data` | Matches the volume mount path below. |
| `SECRET_KEY` | `${{secret(48)}}` | A different random secret per deploy. `secret(length?, alphabet?)` is a Railway template variable function evaluated at deploy time; it defaults to 32 characters, and 48 comfortably clears the 32-character minimum. Docs: <https://docs.railway.com/templates/create> ("Template variable functions"). |
| `PORT` | `3000` | The supervisor passes it to Next. |
| `TELEGRAM_API_ID` | leave out of the template | The project ships its own pair (`lib/channels/telegram-defaults.ts`), so a one-click deploy needs nothing from my.telegram.org. A blank value falls back to the shipped pair anyway, and a visible empty field only invites the deployer to think one is needed. A self-hoster who wants their own application sets both variables together; `TELEGRAM_API_ID=0` runs without Telegram. |
| `TELEGRAM_API_HASH` | leave out of the template | Same. Half a pair is refused at boot. |

**5. Attach the volume.** Right-click the service in the composer → **Attach
Volume** → mount path `/data`. One volume, that path, nothing else — it must
match `DATA_DIR`. There is no volume block in `railway.json`; the volume belongs
to the template. Docs: <https://docs.railway.com/templates/create> ("Add a
volume") and <https://docs.railway.com/volumes>.

**6. Create the template**, then deploy it once yourself from a clean workspace
and confirm, in order:

- the build uses the Dockerfile and succeeds;
- the volume is mounted at `/data`;
- `SECRET_KEY` in the deployed service is a 48-character random string, not the
  literal `${{secret(48)}}`;
- the deploy log ends its `[boot]` line with `no key yet — open the portal to
  set up`, and contains no `sp_…` key;
- the generated domain redirects to `/setup`, and a paired channel there hands
  out a key that logs in;
- `/api/health` returns `{"ok":true}`;
- redeploying keeps that key working and does **not** reopen Setup (the volume
  persisted).

That list is the bar: one click gives a running instance.

**7. Publish it.** Dashboard: **Workspace settings → Templates → Publish**, and
fill the form — category `Other`, a one-line description, and the overview
markdown. Or CLI:

```bash
railway templates publish <template-id> \
  --category Other \
  --description "Your Telegram and WhatsApp conversations, connected to your AI agents." \
  --readme-file docs/railway-template.md
```

The marketplace validates both. The description must be **75 characters or
fewer**. The overview must carry six headings, matched by prefix: `# Deploy
and Host`, `## About Hosting`, `## Why Deploy`, `## Common Use Cases`,
`## Dependencies for`, `### Deployment Dependencies` —
[railway-template.md](railway-template.md) is the one that passed, kept in the
repo so the next publish starts from it. Angle-bracket autolinks
(`<https://…>`) are stripped as HTML on the way in, so write every link as
`[text](url)`. First publication requires `--readme-file` or `--readme`;
`railway templates update` replaces the metadata later. Docs:
<https://docs.railway.com/cli/templates>.

**8. Check the button.** The README button points at:

```
https://railway.com/new/template/steno-personal?referralCode=45_zFw&utm_medium=integration&utm_source=button&utm_campaign=steno-personal
```

If the template is ever recreated it gets a new random draft code, and on
publishing the slug again; either way this URL must follow, and
`tests/launch-invariants.test.ts` only checks that it is *a* template URL, not
that it resolves — open it.

`45_zFw` is the maintainer's code from the workspace's referrals page
(<https://railway.com/account/referrals>): a signup through it gets $20 in
credits and the maintainer gets 15% of their first twelve months of invoices
under Railway's affiliate programme. The same link is offered, and labelled as
a referral, in the README and in the Railway steps of self-hosting.md. That is separate from the template kickback,
which needs no code at all: once the template is on the marketplace you earn
15% of the usage it generates, 25% if you answer questions in your template
queue. Docs: <https://docs.railway.com/community/affiliate-program> and
<https://docs.railway.com/templates/kickbacks>.

The button image is `https://railway.com/button.svg`. Docs:
<https://docs.railway.com/templates/publish-and-share>.

**9. Re-run the invariant sweep.** `tests/launch-invariants.test.ts` asserts
that the README button carries a real template URL
(`toContain('railway.com/new/template/')`) and that no placeholder marker is
left in any shipped document. Keep it green.
