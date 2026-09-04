# Releasing

One maintained line, tagged releases, semantic versions. A release is a commit
on `main` whose tag is `vX.Y.Z`, plus a GitHub release whose notes are the
matching section of [`../CHANGELOG.md`](../CHANGELOG.md).

## Environments

Three, in a line. Code only ever moves left to right.

| | Runs | Deployed from | Data |
|---|---|---|---|
| **development** | your machine — `npm run dev`, or `docker compose up` | your working tree | `./data`, throwaway |
| **staging** | Railway, `steno-personal` project, `staging` environment | the `staging` branch, on every push | its own 5 GB volume, its own generated `SECRET_KEY` |
| **production** | Railway, `steno-personal` project, `production` environment | the `main` branch, on every push | the real archive |

The two Railway environments share nothing but the project. Separate volumes,
separate secret keys, separate paired accounts — staging cannot read the
production archive, and a migration that eats the staging database has not
touched the real one.

`main` is still the release line: it is what gets tagged, and it is what the
one-click deploy button builds. `staging` is the integration branch that
everything passes through first.

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
3. Merge. Railway builds the `staging` branch and deploys it to the staging
   environment; watch the deploy log until the health check at `/api/health`
   is green.
4. Exercise it on the staging URL — the paths the unit tests cannot reach:
   boot on a real volume, migrations applied over existing data, a pairing
   flow, login, and the MCP endpoint under a real bearer token.
5. When staging has been green for as long as the change deserves, open a pull
   request from `staging` into `main`. Merging it deploys production.

A hotfix is the same shape, not an exception: branch from `staging`, merge to
`staging`, promote. The pipeline is short enough that skipping it buys minutes
and costs the archive.

### Staging's first boot

The staging volume starts empty, which means `/setup` is open to whoever
reaches the public URL first. `STENO_MINT_KEY=staging-host` is set on the
staging environment so a key is minted and printed to the deploy log on first
boot; once any key row exists `/setup` is closed. Read the key out of the
Railway log and keep it — the banner prints once per value.

If you ever wipe staging (`STENO_RESET`), the mint marker is cleared with it
and a fresh key is printed on the next boot.

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
  see the Railway section of [self-hosting.md](self-hosting.md).
- If the release fixes a reported vulnerability, publish the advisory from
  the repository's Security tab and credit the reporter if they asked to be.

## Versioning

- **Patch**: a fix with no change to configuration, schema, or the MCP tools.
- **Minor**: a new feature, a new environment variable, or a new migration.
  Migrations apply forward at boot; a minor release never requires the user
  to do anything beyond `git pull` and a restart.
- **Major**: anything that needs manual action on the volume, changes the
  meaning of an existing environment variable, or removes an MCP tool.
