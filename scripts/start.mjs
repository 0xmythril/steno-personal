// Boots the data dir, then runs web + worker. If either child exits, the
// container exits so the host restarts it. Plain Node: no TS, no env schema,
// so a bad variable fails inside boot.ts with a readable message instead.
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

export function isOn(raw) {
  return raw?.trim().toLowerCase() !== 'false'
}

// Railway clears a variable to '' rather than removing it, so `??` is not
// enough: `next start -p ''` parses as NaN and takes the container down.
export function resolvePort(raw) {
  return raw?.trim() || '3000'
}

export function processesToStart(runWeb, runWorker, port = resolvePort(process.env.PORT)) {
  const procs = []
  if (runWeb) procs.push(['web', 'node', ['node_modules/next/dist/bin/next', 'start', '-p', port]])
  if (runWorker) procs.push(['worker', 'node', ['node_modules/tsx/dist/cli.mjs', 'worker/index.ts']])
  return procs
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const procs = processesToStart(isOn(process.env.RUN_WEB), isOn(process.env.RUN_WORKER))
  if (procs.length === 0) { console.error('[supervisor] nothing to start'); process.exit(1) }
  console.log(`[supervisor] will start: ${procs.map(([n]) => n).join(', ')}`)

  const boot = spawnSync('node', ['node_modules/tsx/dist/cli.mjs', 'scripts/boot.ts'], { stdio: 'inherit', env: process.env })
  if (boot.status !== 0) { console.error('[supervisor] boot failed; refusing to start'); process.exit(boot.status ?? 1) }

  let shuttingDown = false
  const children = []
  let remaining = procs.length
  for (const [name, cmd, args] of procs) {
    const p = spawn(cmd, args, { stdio: 'inherit', env: process.env })
    children.push(p)
    p.on('exit', code => {
      if (shuttingDown) {
        console.error(`[supervisor] ${name} stopped`)
        remaining -= 1
        if (remaining <= 0) process.exit(0)
        return
      }
      console.error(`[supervisor] ${name} exited with ${code}; shutting down`)
      process.exit(code ?? 1)
    })
  }
  for (const sig of ['SIGTERM', 'SIGINT']) {
    process.on(sig, () => { shuttingDown = true; for (const c of children) c.kill(sig) })
  }
}
