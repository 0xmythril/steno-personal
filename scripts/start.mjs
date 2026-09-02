// Boots the data dir, then runs web + worker. If either child exits, the
// container exits so the host restarts it. Plain Node: no TS, no env schema,
// so a bad variable fails inside boot.ts with a readable message instead.
import { spawn, spawnSync } from 'node:child_process'

export function isOn(raw) {
  return raw?.trim().toLowerCase() !== 'false'
}

export function processesToStart(runWeb, runWorker) {
  const procs = []
  if (runWeb) procs.push(['web', 'node', ['node_modules/next/dist/bin/next', 'start', '-p', process.env.PORT ?? '3000']])
  if (runWorker) procs.push(['worker', 'node', ['node_modules/tsx/dist/cli.mjs', 'worker/index.ts']])
  return procs
}

if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]) {
  const procs = processesToStart(isOn(process.env.RUN_WEB), isOn(process.env.RUN_WORKER))
  if (procs.length === 0) { console.error('[supervisor] nothing to start'); process.exit(1) }
  console.log(`[supervisor] will start: ${procs.map(([n]) => n).join(', ')}`)

  const boot = spawnSync('node', ['node_modules/tsx/dist/cli.mjs', 'scripts/boot.ts'], { stdio: 'inherit', env: process.env })
  if (boot.status !== 0) { console.error('[supervisor] boot failed; refusing to start'); process.exit(boot.status ?? 1) }

  const children = []
  for (const [name, cmd, args] of procs) {
    const p = spawn(cmd, args, { stdio: 'inherit', env: process.env })
    children.push(p)
    p.on('exit', code => { console.error(`[supervisor] ${name} exited with ${code}; shutting down`); process.exit(code ?? 1) })
  }
  for (const sig of ['SIGTERM', 'SIGINT']) {
    process.on(sig, () => { for (const c of children) c.kill(sig) })
  }
}
