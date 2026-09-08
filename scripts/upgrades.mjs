#!/usr/bin/env node
// Compatibility entry point. New installations need only Docker and a shell.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const directory = path.resolve('.steno-updater')
const action = process.argv[2]
try {
  if (action === 'enable') {
    execFileSync('sh', [fileURLToPath(new URL('./enable-upgrades.sh', import.meta.url))], { stdio: 'inherit' })
  } else if (action === 'compose') {
    const { project } = JSON.parse(readFileSync(`${directory}/deployment.json`, 'utf8'))
    execFileSync('docker', ['compose', '-p', project, '-f', `${directory}/compose.json`, '-f', `${directory}/release.json`, ...process.argv.slice(3)], { stdio: 'inherit' })
  } else {
    console.log('Enable: sh scripts/enable-upgrades.sh. Then use ordinary docker compose commands.')
    process.exitCode = 1
  }
} catch {
  console.error('The command could not finish. Check Docker and the upgrade guide; configuration has not been printed because it can contain secrets.')
  process.exitCode = 1
}
