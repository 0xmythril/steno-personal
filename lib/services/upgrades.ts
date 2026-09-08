import 'server-only'
import { request } from 'node:http'
import { env } from '@/lib/env'

export type UpgradeStatus = { phase: string; version?: string; updatedAt?: string }
export type AvailableRelease = { version: string; url: string }

export function upgradesConfigured() { return Boolean(env.STENO_UPDATER_SOCKET) }

// This is a Unix socket to the operator-installed companion, never a URL
// supplied by a browser. No host control or Docker socket enters the web app.
export async function updaterRequest<T>(operation: 'status' | 'check' | 'upgrade', version?: string): Promise<T> {
  if (!env.STENO_UPDATER_SOCKET) throw new Error('Automatic upgrades are not configured')
  return new Promise((resolve, reject) => {
    const req = request({ socketPath: env.STENO_UPDATER_SOCKET, path: `/${operation}`,
      method: operation === 'status' ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json' },
    }, res => {
      let body = ''
      res.on('data', chunk => {
        body += chunk
        if (body.length > 16_384) req.destroy(new Error('Invalid updater response'))
      })
      res.on('error', () => reject(new Error('Updater unavailable')))
      res.on('end', () => {
        if (!res.statusCode || res.statusCode >= 400) return reject(new Error('Updater unavailable or busy'))
        try { resolve(JSON.parse(body) as T) } catch { reject(new Error('Invalid updater response')) }
      })
    })
    req.setTimeout(25_000, () => req.destroy(new Error('Updater timed out')))
    req.on('error', () => reject(new Error('Updater unavailable')))
    req.end(operation === 'upgrade' ? JSON.stringify({ version }) : undefined)
  })
}
