'use client'

import { useEffect, useState, useTransition } from 'react'
import { checkUpdateAction, startUpgradeAction } from './updates/actions'
import type { AvailableRelease, UpgradeStatus } from '@/lib/services/upgrades'
import { newerVersion } from '@/updater/releases.mjs'

const messages: Record<string, string> = {
  idle: 'Ready to check for updates.',
  preparing: 'Downloading and checking the release. Your archive is still available.',
  stopping: 'Pausing Steno before backing up your archive.',
  'backing-up': 'Backing up your archive, connections, and settings.',
  installing: 'Installing the new version.',
  verifying: 'Checking that Steno and its background worker are ready.',
  'rolling-back': 'The upgrade did not finish. Restoring the previous version and backup.',
  succeeded: 'Upgrade complete.',
  'rolled-back': 'The upgrade did not complete. The previous version has been restored.',
  failed: 'The upgrade stopped before changing your archive. Check available disk space and the updater, then try again.',
  'recovery-required': 'Automatic recovery could not finish. The host operator needs to restore the retained backup. See the upgrade guide.',
  unavailable: 'Waiting for Steno and the updater to reconnect. This page will keep checking. If it does not return, ask the host operator to inspect the updater.',
}
const finished = new Set(['idle', 'succeeded', 'rolled-back', 'failed'])

export function UpdatesSection({ currentVersion, configured }: { currentVersion: string; configured: boolean }) {
  const [release, setRelease] = useState<AvailableRelease | null>(null)
  const [status, setStatus] = useState<UpgradeStatus>({ phase: 'idle' })
  const [error, setError] = useState('')
  const [pending, startTransition] = useTransition()
  const [confirmed, setConfirmed] = useState(false)

  useEffect(() => {
    if (!configured) return
    let stopped = false
    const poll = async () => {
      try {
        const response = await fetch('/api/upgrades', { cache: 'no-store', signal: AbortSignal.timeout(8000) })
        if (!response.ok) throw new Error('Unavailable')
        const next = await response.json() as UpgradeStatus
        if (!stopped) {
          setStatus(next)
          if (next.phase === 'succeeded' && next.version && next.version !== currentVersion) window.location.reload()
        }
      } catch { if (!stopped) setStatus({ phase: 'unavailable' }) }
    }
    void poll()
    const timer = setInterval(() => { void poll() }, 5000)
    return () => { stopped = true; clearInterval(timer) }
  }, [configured, currentVersion])

  const newer = release && newerVersion(release.version, currentVersion)
  const supported = release?.version.split('.')[0] === currentVersion.split('.')[0]
  const busy = pending || !finished.has(status.phase)

  return <section className="card">
    <h2>Software updates</h2>
    <p className="muted">Installed version: <code>{currentVersion}</code>. Updates start only when you choose.</p>
    {!configured ? <p>
      Automatic upgrades are not configured. On Docker, the host operator can enable the companion updater.
      On Railway, back up the volume and deploy the selected release through Railway.
      {' '}<a href="https://github.com/0xmythril/steno-personal/blob/main/docs/upgrades.md" target="_blank" rel="noreferrer">Upgrade guide</a>.
    </p> : <>
      <p role="status" aria-live="polite">{messages[status.phase] ?? 'Checking upgrade status…'}</p>
      <p className="muted">Checking contacts GitHub for release information. Upgrading downloads the release image; no archive contents are sent.</p>
      <button type="button" disabled={busy} onClick={() => startTransition(async () => {
        setError(''); setConfirmed(false)
        const result = await checkUpdateAction()
        if (result.release) setRelease(result.release)
        else setError(result.error ?? 'Could not check for updates.')
      })}>{pending ? 'Please wait…' : 'Check for updates'}</button>
      {release && <div className="stack">
        <p>{newer ? `Version ${release.version} is available.` : 'You are running the latest stable version or a newer build.'}
          {' '}<a href={release.url} target="_blank" rel="noreferrer">Release notes</a></p>
        {newer && !supported && <p>This major release needs an upgrade from the host. Follow its release notes.</p>}
        {newer && supported && <>
          <p>Steno will pause while your archive is backed up and upgraded. Keep this tab open to reconnect.
            If recovery is needed, the archive returns to the backup point; newer messages may need to sync again.</p>
          <label className="row"><input type="checkbox" checked={confirmed} disabled={busy} onChange={event => setConfirmed(event.target.checked)} />
            I’m ready for Steno to pause and upgrade.</label>
          <button type="button" className="primary" disabled={busy || !confirmed} onClick={() => startTransition(async () => {
            setError('')
            const result = await startUpgradeAction(release.version)
            if (result.status) { setStatus(result.status); setConfirmed(false) }
            else setError(result.error ?? 'Could not start the upgrade.')
          })}>Upgrade to {release.version}</button>
        </>}
      </div>}
      <p><a href="https://github.com/0xmythril/steno-personal/blob/main/docs/upgrades.md" target="_blank" rel="noreferrer">Upgrade and recovery guide</a></p>
    </>}
    {error && <p className="danger" role="alert">{error}</p>}
  </section>
}
