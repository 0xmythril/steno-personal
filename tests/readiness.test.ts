import { describe, it, expect } from 'vitest'
import { writeFileSync } from 'node:fs'
import { GET } from '@/app/api/ready/route'
import { recordWorkerProgress, heartbeatFile } from '@/lib/services/readiness'
import { version } from '@/package.json'

describe('upgrade readiness', () => {
  it('requires recent progress from the installed worker', async () => {
    expect(GET().status).toBe(503)
    recordWorkerProgress()
    const res = GET()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, version })
    writeFileSync(heartbeatFile(), JSON.stringify({ version, at: Date.now() - 61_000 }))
    expect(GET().status).toBe(503)
    writeFileSync(heartbeatFile(), JSON.stringify({ version: 'old', at: Date.now() }))
    expect(GET().status).toBe(503)
    writeFileSync(heartbeatFile(), '{broken')
    expect(GET().status).toBe(503)
  })
})
