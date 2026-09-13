import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { STELE_REF } from '../updater/wechat.mjs'

// The one-command WeChat setup is a Compose overlay plus a shell script. These
// checks pin the properties the self-hosting guide promises: the sidecar sits
// in the app's network namespace and nowhere else, it can read the official
// client's memory and nothing more, and the app never learns a Stele URL that
// the plain-HTTP-on-loopback rule would refuse.
describe('compose.wechat.yaml', () => {
  const overlay = readFileSync('compose.wechat.yaml', 'utf8')
  const stele = overlay.slice(overlay.indexOf('\n  stele:'), overlay.indexOf('\nvolumes:'))

  it('joins the app namespace instead of the host, and exposes no port', () => {
    expect(stele).toContain('network_mode: "service:app"')
    expect(stele).not.toContain('network_mode: host')
    expect(stele).not.toMatch(/^\s+ports:/m)
  })

  it('has exactly the capability Stele needs and never restarts on its own', () => {
    expect(stele).toContain('cap_add: [SYS_PTRACE]')
    expect(stele).not.toMatch(/privileged/)
    expect(stele).toContain('restart: "no"')
    expect(stele).toContain('pull_policy: never')
  })

  it('points the app at loopback and a read-only token mount', () => {
    expect(overlay).toContain('STELE_WECHAT_URL: http://127.0.0.1:6175')
    expect(overlay).toContain('STELE_WECHAT_READ_TOKEN_FILE: /run/steno-wechat/reader.token')
    expect(overlay).toContain('STELE_WECHAT_LOGIN_TOKEN_FILE: /run/steno-wechat/login.token')
    expect(overlay).toContain('./.steno-wechat:/run/steno-wechat:ro')
  })

  it('gives the sidecar its own volumes, never the archive', () => {
    expect(stele).not.toMatch(/-\s+data:\/data/)
    expect(stele).toContain('stele-collector:/data')
    expect(stele).toContain('stele-client:/home/client')
  })
})

describe('scripts/enable-wechat.sh', () => {
  const script = readFileSync('scripts/enable-wechat.sh', 'utf8')

  it('pins the same Stele revision as the companion, and allows a local checkout instead', () => {
    expect(script).toContain(`STELE_REF=\${STELE_REF:-${STELE_REF}}`)
    expect(script).toContain('STELE_SOURCE=${STELE_SOURCE:-}')
  })

  it('refuses hosts and states it cannot serve', () => {
    expect(script).toContain('x86_64|amd64')
    expect(script).toContain('[ -d .steno-updater ] && fail')
  })

  it('never prints a token and removes the copies it leaves in the sidecar', () => {
    expect(script).not.toMatch(/cat .*token/)
    expect(script).toContain('rm -f "/data/collector/$1.token"')
    expect(script).toContain('chmod 600 ".steno-wechat/$3"')
  })

  it('keeps the credential directory out of git and the image', () => {
    expect(readFileSync('.gitignore', 'utf8')).toContain('.steno-wechat/')
    expect(readFileSync('.dockerignore', 'utf8')).toContain('.steno-wechat')
  })
})

describe('the companion side of Enable WeChat', () => {
  it('answers exactly the two WeChat requests beside the upgrade ones', () => {
    const server = readFileSync('updater/server.mjs', 'utf8')
    expect(server).toContain("req.method === 'GET' && req.url === '/wechat'")
    expect(server).toContain("req.method === 'POST' && req.url === '/wechat/enable'")
    expect(readFileSync('lib/services/upgrades.ts', 'utf8')).toMatch(/'wechat-status': \['GET', '\/wechat'\]/)
  })
})

describe('the WeChat card', () => {
  const card = readFileSync('app/connections/wechat.tsx', 'utf8')

  it('says WeChat is not built in, unlike the two native channels', () => {
    expect(card).toContain('Not built in.')
    expect(card).toContain('Telegram and WhatsApp are read by Steno itself')
    expect(card).toMatch(/unofficial/i)
    expect(card).toContain('Only link your own')
  })

  it('asks for consent before enabling, and never shows Docker output', () => {
    expect(card).toContain('I understand WeChat is an unofficial, experimental integration')
    expect(card).toMatch(/disabled=\{pending \|\| !confirmed\}/)
    expect(card).not.toMatch(/stderr|stdout/)
  })
})
