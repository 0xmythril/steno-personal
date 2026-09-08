import { mkdir, readFile, rename, open, stat } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { newerVersion } from './releases.mjs'

export const terminal = phase => ['idle', 'succeeded', 'rolled-back', 'failed', 'recovery-required'].includes(phase)

// Atomic replacement plus fsync: the journal must reach disk before the
// operation it describes. Store it outside the archive that rollback restores.
export async function writeJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  const temp = `${file}.tmp`
  const handle = await open(temp, 'w', 0o600)
  try {
    const owner = await stat(path.dirname(file))
    await handle.chown(owner.uid, owner.gid)
    await handle.writeFile(JSON.stringify(value, null, 2) + '\n'); await handle.sync()
  }
  finally { await handle.close() }
  await rename(temp, file)
  const dir = await open(path.dirname(file), 'r')
  try { await dir.sync() } finally { await dir.close() }
}

export class UpgradeEngine {
  constructor(directory, driver, report = (_phase) => {}) {
    this.directory = directory
    this.driver = driver
    this.state = { phase: 'idle' }
    this.busy = false
    this.report = report
  }

  async save(changes) {
    const next = { ...this.state, ...changes, updatedAt: new Date().toISOString() }
    await writeJson(path.join(this.directory, 'journal.json'), next)
    this.state = next
    this.report(next.phase)
  }

  async initialize() {
    try { this.state = JSON.parse(await readFile(path.join(this.directory, 'journal.json'), 'utf8')) }
    catch (error) { if (error.code !== 'ENOENT') throw error }
    const active = ['preparing', 'stopping', 'backing-up', 'installing', 'verifying', 'rolling-back']
    if (!this.state || (!terminal(this.state.phase) && !active.includes(this.state.phase))) throw new Error('Invalid upgrade journal')
    if (!terminal(this.state.phase) && (!this.state.previous?.image || !this.state.previous?.version ||
      typeof this.state.id !== 'string' || typeof this.state.backupComplete !== 'boolean')) throw new Error('Incomplete upgrade journal')
    if (!terminal(this.state.phase)) {
      this.busy = true
      try { await this.recover() } finally { this.busy = false }
    }
  }

  async start(version) {
    if (this.busy || !terminal(this.state.phase) || this.state.phase === 'recovery-required') throw new Error('Upgrade unavailable')
    this.busy = true
    try {
      const current = await this.driver.current()
      const release = await this.driver.release()
      if (version !== release.version || !newerVersion(version, current.version) || version.split('.')[0] !== current.version.split('.')[0]) {
        throw new Error('Select a newer stable release within the current major version')
      }
      this.state = { phase: 'idle' }
      await this.save({ phase: 'preparing', id: randomUUID(), version, previous: current, backupComplete: false })
      // Reply before stopping the app. The updater owns the task's lifetime.
      this.task = new Promise(resolve => setTimeout(resolve, 1000)).then(() => this.run()).finally(() => { this.busy = false })
      return this.state
    } catch (error) { this.busy = false; throw error }
  }

  async run() {
    try {
      const image = await this.driver.prepare(this.state.version)
      await this.save({ image, phase: 'stopping' })
      await this.driver.stop()
      await this.save({ phase: 'backing-up' })
      await this.driver.backup(this.state)
      await this.save({ backupComplete: true, phase: 'installing' })
      await this.driver.install(image)
      await this.save({ phase: 'verifying' })
      await this.driver.verify(this.state.version)
      await this.save({ phase: 'succeeded' })
    } catch {
      // Do not expose docker stderr, environment values, or archive paths.
      await this.recover()
    }
  }

  async recover() {
    try {
      await this.driver.cancelHelper()
      if (this.state.phase === 'preparing') {
        await this.save({ phase: 'failed' }) // The running app has not been touched.
        return
      }
      await this.save({ phase: 'rolling-back' })
      await this.driver.stop()
      if (this.state.backupComplete) await this.driver.restore(this.state)
      await this.driver.install(this.state.previous.image)
      await this.driver.verify(this.state.previous.version)
      await this.save({ phase: 'rolled-back' })
    } catch {
      // No retries against an uncertain restore. Keep the backup and journal
      // for host recovery and prevent further upgrades from overwriting them.
      await this.save({ phase: 'recovery-required' })
    }
  }

  status() {
    const { phase, version, updatedAt } = this.state
    return { phase, version, updatedAt }
  }
}
