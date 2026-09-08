export function validSteleUrl(value: string): boolean {
  try {
    const u = new URL(value)
    return !u.username && !u.password && !u.search && !u.hash && u.pathname === '/' &&
      (u.protocol === 'https:' || (u.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)))
  } catch { return false }
}
