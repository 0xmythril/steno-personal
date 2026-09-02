import { describe, it, expect } from 'vitest'
import { GET } from '@/app/api/health/route'

describe('health', () => {
  it('answers ok', async () => {
    const res = GET()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })
})
