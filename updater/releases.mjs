export const REPOSITORY = '0xmythril/steno-personal'
export const IMAGE = `ghcr.io/${REPOSITORY}`
export const stableVersion = value => typeof value === 'string' && /^\d+\.\d+\.\d+$/.test(value)

export function newerVersion(candidate, current) {
  if (!stableVersion(candidate) || !stableVersion(current)) return false
  const a = candidate.split('.').map(Number)
  const b = current.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i]
  }
  return false
}

// Only a deliberate check/upgrade contacts GitHub. No instance identifiers,
// current version, credentials, or archive contents are sent.
export async function latestRelease() {
  const res = await fetch(`https://api.github.com/repos/${REPOSITORY}/releases/latest`, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'steno-personal-updater' },
    signal: AbortSignal.timeout(15_000),
    redirect: 'error',
  })
  if (!res.ok) throw new Error('Release check unavailable')
  const release = await res.json()
  const version = release.tag_name?.replace(/^v/, '')
  if (!stableVersion(version) || release.draft || release.prerelease) throw new Error('No stable release available')
  return { version, url: `https://github.com/${REPOSITORY}/releases/tag/v${version}` }
}
