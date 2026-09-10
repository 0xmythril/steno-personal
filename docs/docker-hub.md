# Docker Hub images

Official release images are published in two repositories:

- [`0xmythril/steno-personal`](https://hub.docker.com/r/0xmythril/steno-personal)
  contains the web app and worker.
- [`0xmythril/steno-personal-updater`](https://hub.docker.com/r/0xmythril/steno-personal-updater)
  contains the optional local upgrade companion.

Both support `linux/amd64` and `linux/arm64`. Stable releases have immutable
`vX.Y.Z` and `X.Y.Z` tags. `X.Y` and `latest` move to the newest stable release
in that line and overall. Pin a full version for repeatable deployments:

```bash
docker pull 0xmythril/steno-personal:0.3.1
```

The images are mirrors of the GHCR release images. Each release includes build
provenance and an SBOM and is signed with Sigstore's GitHub Actions identity.
The in-app updater continues to resolve releases from GHCR and pins the chosen
image digest before installation.

For a normal installation, use the repository's
[Docker Compose quick start](../README.md#quick-start). It creates the persistent
volume and can enable upgrades from Settings. The updater image is managed by
that setup and should not be started by itself.

## Verify a signature

Install [Cosign](https://docs.sigstore.dev/cosign/system_config/installation/),
then verify the application image against this repository's workflow identity:

```bash
cosign verify \
  --certificate-identity-regexp='^https://github.com/0xmythril/steno-personal/.github/workflows/release-images.yml@refs/(heads/main|tags/v[0-9]+\.[0-9]+\.[0-9]+)$' \
  --certificate-oidc-issuer='https://token.actions.githubusercontent.com' \
  0xmythril/steno-personal:0.3.1
```

The repository source, setup instructions, upgrade behavior, recovery steps,
and security policy live at
<https://github.com/0xmythril/steno-personal>.
