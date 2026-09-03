# Releasing

One maintained line, tagged releases, semantic versions. A release is a commit
on `main` whose tag is `vX.Y.Z`, plus a GitHub release whose notes are the
matching section of [`../CHANGELOG.md`](../CHANGELOG.md).

## Before tagging

1. `main` is green: the `ci` workflow runs lint, typecheck, tests, the build,
   and the Docker smoke test on every push. Do not tag a red commit.
2. Every user-visible change since the last tag has a line under
   **Unreleased** in the changelog. Read the diff since the last tag
   (`git log v0.1.0..main --oneline`) and fill in what is missing.
3. Nothing private is about to ship: no real key, phone number, or session
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
