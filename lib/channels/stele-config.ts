import { constants, closeSync, fstatSync, openSync, readFileSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { env } from '@/lib/env'

export function steleConfigured() { return Boolean(env.STELE_WECHAT_URL && env.STELE_WECHAT_READ_TOKEN_FILE) }
export function steleLoginConfigured() { return steleConfigured() && Boolean(env.STELE_WECHAT_LOGIN_TOKEN_FILE) }
export function readSteleToken(file: string | undefined): string {
  let fd: number | undefined
  try {
    if (!file || !isAbsolute(file)) throw new Error()
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW)
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o077) || stat.size > 1024) throw new Error()
    const value = readFileSync(fd, 'utf8').trim()
    if (value.length < 32 || /\s/.test(value)) throw new Error()
    return value
  } catch { throw new Error('Stele credential file is unavailable or not private.') }
  finally { if (fd !== undefined) closeSync(fd) }
}
