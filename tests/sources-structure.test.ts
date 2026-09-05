import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

const read = (f: string) => readFileSync(f, 'utf8')

describe('the push door stays where it is', () => {
  it('the worker reads live connections only', () => {
    const src = read('lib/services/login.ts')
    expect(src.match(/eq\(connections\.mode, 'live'\)/g)?.length ?? 0).toBeGreaterThanOrEqual(2)
    expect(read('lib/services/recovery.ts')).toMatch(/eq\(connections\.mode, 'live'\)/)
  })

  it('the port seam knows nothing about pushed sources', () => {
    for (const f of ['lib/channels/port.ts', 'lib/channels/ports.ts', 'lib/channels/session-manager.ts', 'lib/channels/fake-port.ts']) {
      expect(read(f), f).not.toMatch(/services\/import|connections\.mode|pushKeyId|mode: 'push'/)
    }
  })

  it('the import route is a bearer door: no cookie auth, no ciphertext, POST only', () => {
    const src = read('app/api/import/route.ts')
    expect(src).not.toMatch(/from '@\/lib\/auth'/)
    expect(src).not.toMatch(/Ciphertext/)
    const exports = [...src.matchAll(/^export\b.*$/gm)].map(m => m[0])
    expect(exports).toHaveLength(1)
    expect(exports[0]).toMatch(/^export const POST = withErrorBoundary\(/)
  })

  it('the import path never logs through console or logs a body', () => {
    for (const f of ['lib/services/import.ts', 'app/api/import/route.ts']) {
      const src = read(f)
      expect(src, f).not.toMatch(/\bconsole\.(log|info|warn|error|debug)\(/)
      expect(src, f).not.toMatch(/log\.\w+\([^)]*\b(text|batch|input|title|label|senderName)\b/)
    }
  })

  it('the import service reaches the tables only through ingest, except for the source row', () => {
    const src = read('lib/services/import.ts')
    expect(src).toMatch(/from '@\/lib\/services\/ingest'/)
    expect(src).not.toMatch(/\b(chats|messages|media)\b\s*[,}]/) // no table import but connections
  })
})
