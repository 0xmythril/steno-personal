import { describe, it, expect, beforeEach } from 'vitest'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { db } from '@/lib/db/client'
import { connections, chats, messages, media } from '@/lib/db/schema'
import { encryptSecret, decryptSecret } from '@/lib/services/crypto'
import { env } from '@/lib/env'
import { resetDb } from './helpers/db'
import { makeConnection, makeChat, addMessage } from './helpers/fixtures'
import { mediaDir, mediaFilePath } from '@/lib/services/media'
import { makeAttachment } from './helpers/media-fixtures'
import {
  createConnection, listConnections, getConnection, submitLoginPassword,
  revokeConnection, deleteConnection, hasActiveConnection, PASSWORD_REJECTED, mapInsertError,
} from '@/lib/services/connections'

const rowOf = async (id: string) => (await db.select().from(connections).where(eq(connections.id, id)))[0]

describe('connections service', () => {
  beforeEach(resetDb)

  it('creates a pending connection and reports it as pending with a login block', async () => {
    const res = await createConnection('telegram')
    expect(res.ok).toBe(true)
    if (!res.ok) return
    const status = await getConnection(res.id)
    expect(status).toMatchObject({ channel: 'telegram', status: 'pending', displayName: null })
    expect(status!.login).toEqual({ qr: null, qrAt: null, needsPassword: false, passwordRejected: false })
    expect(await hasActiveConnection()).toBe(false)
  })

  it('refuses a second connection while one is active on that channel', async () => {
    await makeConnection({ channel: 'telegram', status: 'active' })
    expect(await createConnection('telegram')).toEqual({ ok: false, reason: 'already_connected' })
    // a different channel is free
    expect((await createConnection('whatsapp')).ok).toBe(true)
    expect(await hasActiveConnection()).toBe(true)
  })

  it('a live recovery row neither blocks nor is touched by a new archive connection', async () => {
    const rec = await makeConnection({ channel: 'telegram', purpose: 'recovery', status: 'pending' })
    const res = await createConnection('telegram')
    expect(res.ok).toBe(true)
    const recovery = await rowOf(rec.id)
    expect(recovery.status).toBe('pending')
    expect(recovery.revokedAt).toBeNull()
    const status = await getConnection(rec.id)
    expect(status!.purpose).toBe('recovery')
    if (res.ok) expect((await getConnection(res.id))!.purpose).toBe('archive')
  })

  it('clears an abandoned pending row so the single live slot can be reused', async () => {
    const first = await createConnection('telegram')
    const second = await createConnection('telegram')
    expect(second.ok).toBe(true)
    if (!first.ok || !second.ok) return
    expect(second.id).not.toBe(first.id)
    const rows = await db.select().from(connections)
    expect(rows.map(r => r.id)).toEqual([second.id])
  })

  it('revokes rather than deletes a dead row that already holds an archive', async () => {
    const conn = await makeConnection({ channel: 'telegram', status: 'error' })
    await makeChat(conn)
    const again = await createConnection('telegram')
    expect(again.ok).toBe(true)
    const old = await rowOf(conn.id)
    expect(old.status).toBe('revoked')
    expect(old.revokedAt).not.toBeNull()
    expect(await db.select().from(chats)).toHaveLength(1) // the archive survived
  })

  it('lists newest first and includes revoked rows', async () => {
    const revoked = await makeConnection({ channel: 'whatsapp', status: 'active' })
    await revokeConnection(revoked.id, 'done')
    await new Promise(r => setTimeout(r, 5))
    const live = await makeConnection({ channel: 'telegram', status: 'active' })
    const list = await listConnections()
    expect(list.map(c => c.id)).toEqual([live.id, revoked.id])
    expect(list[1].status).toBe('revoked')
    expect(list[1].login).toBeNull() // only a pending row exposes a login block
  })

  it('never returns a ciphertext in a status payload', async () => {
    const conn = await makeConnection({ channel: 'telegram', status: 'pending' })
    await db.update(connections).set({
      sessionCiphertext: 'SESSION_SECRET', loginSecretCiphertext: 'PW_SECRET', loginQrToken: 'tg://login?token=abc',
    }).where(eq(connections.id, conn.id))
    const blob = JSON.stringify([await getConnection(conn.id), await listConnections()])
    expect(blob).not.toContain('SESSION_SECRET')
    expect(blob).not.toContain('PW_SECRET')
    expect(blob).toContain('tg://login?token=abc') // the QR IS the thing to scan
  })

  it('stores a 2FA password encrypted, only while pending, and clears a stale rejection', async () => {
    const conn = await makeConnection({ channel: 'telegram', status: 'pending' })
    await db.update(connections).set({ lastError: PASSWORD_REJECTED, loginNeedsPassword: true })
      .where(eq(connections.id, conn.id))
    expect((await getConnection(conn.id))!.login!.passwordRejected).toBe(true)

    expect(await submitLoginPassword(conn.id, 'hunter2')).toBe(true)
    const row = await rowOf(conn.id)
    expect(row.loginSecretCiphertext).not.toContain('hunter2')
    expect(decryptSecret(row.loginSecretCiphertext!)).toBe('hunter2')
    expect(row.loginSecretAt).toBeInstanceOf(Date)
    expect(row.lastError).toBeNull() // a new attempt supersedes the old rejection

    await revokeConnection(conn.id, 'stop')
    expect(await submitLoginPassword(conn.id, 'again')).toBe(false)
    expect(await submitLoginPassword('not-a-real-id', 'x')).toBe(false)
  })

  it('revokeConnection nulls every secret and moves status and revoked_at together', async () => {
    const conn = await makeConnection({ channel: 'telegram', status: 'active' })
    await db.update(connections).set({
      sessionCiphertext: 'S', loginQrToken: 'Q', loginSecretCiphertext: 'P',
      loginNeedsPassword: true, loginSecretAt: new Date(), loginQrAt: new Date(),
    }).where(eq(connections.id, conn.id))

    expect(await revokeConnection(conn.id, 'You revoked this session from your phone.')).toBe(true)
    const row = await rowOf(conn.id)
    expect(row.status).toBe('revoked')
    expect(row.revokedAt).toBeInstanceOf(Date)
    expect(row.sessionCiphertext).toBeNull()
    expect(row.loginQrToken).toBeNull()
    expect(row.loginSecretCiphertext).toBeNull()
    expect(row.loginNeedsPassword).toBe(false)
    expect(row.lastError).toBe('You revoked this session from your phone.')

    expect(await revokeConnection(conn.id, 'again')).toBe(false) // already revoked
    expect(await revokeConnection('not-a-real-id', 'x')).toBe(false)
  })

  it('deleteConnection removes the row and its whole archive', async () => {
    const conn = await makeConnection({ channel: 'telegram', status: 'active' })
    await addMessage(await makeChat(conn))
    expect(await deleteConnection(conn.id)).toBe(true)
    expect(await db.select().from(connections)).toEqual([])
    expect(await db.select().from(chats)).toEqual([])
    expect(await db.select().from(messages)).toEqual([])
    expect(await deleteConnection(conn.id)).toBe(false)
  })

  it('deleteConnection removes the WhatsApp auth directory named by the connection id', async () => {
    const conn = await makeConnection({ channel: 'whatsapp', status: 'active' })
    const dirName = `wa-${conn.id}`
    await db.update(connections).set({ sessionCiphertext: encryptSecret(dirName) }).where(eq(connections.id, conn.id))
    const dirPath = path.join(env.DATA_DIR, 'whatsapp', dirName)
    mkdirSync(dirPath, { recursive: true })
    expect(await deleteConnection(conn.id)).toBe(true)
    expect(existsSync(dirPath)).toBe(false)
  })

  // The three ordinary orders — Disconnect then Delete, a phone-side unlink,
  // and a login that never finished — all reach delete with no ciphertext to
  // read the directory name out of. The keys are on the volume either way.
  it('deleteConnection removes the auth directory of an already-revoked WhatsApp row', async () => {
    const conn = await makeConnection({ channel: 'whatsapp', status: 'active' })
    await db.update(connections).set({ sessionCiphertext: encryptSecret(`wa-${conn.id}`) }).where(eq(connections.id, conn.id))
    const dirPath = path.join(env.DATA_DIR, 'whatsapp', `wa-${conn.id}`)
    mkdirSync(dirPath, { recursive: true })

    await revokeConnection(conn.id, 'You disconnected this channel.')
    expect((await rowOf(conn.id)).sessionCiphertext).toBeNull()

    expect(await deleteConnection(conn.id)).toBe(true)
    expect(existsSync(dirPath)).toBe(false)
  })

  it('deleteConnection removes the auth directory of a login that failed before it stored a session', async () => {
    const conn = await makeConnection({ channel: 'whatsapp', status: 'error' })
    expect(conn.sessionCiphertext).toBeNull()
    // login() creates the directory before the pairing can time out.
    const dirPath = path.join(env.DATA_DIR, 'whatsapp', `wa-${conn.id}`)
    mkdirSync(dirPath, { recursive: true })
    expect(await deleteConnection(conn.id)).toBe(true)
    expect(existsSync(dirPath)).toBe(false)
  })

  it('deleteConnection also removes a legacy directory named by the session string', async () => {
    const conn = await makeConnection({ channel: 'whatsapp', status: 'active' })
    const legacy = 'wa-legacy-name'
    await db.update(connections).set({ sessionCiphertext: encryptSecret(legacy) }).where(eq(connections.id, conn.id))
    const idDir = path.join(env.DATA_DIR, 'whatsapp', `wa-${conn.id}`)
    const legacyDir = path.join(env.DATA_DIR, 'whatsapp', legacy)
    mkdirSync(idDir, { recursive: true })
    mkdirSync(legacyDir, { recursive: true })
    expect(await deleteConnection(conn.id)).toBe(true)
    expect(existsSync(idDir)).toBe(false)
    expect(existsSync(legacyDir)).toBe(false)
  })

  it('deleteConnection leaves DATA_DIR untouched for a Telegram row', async () => {
    const conn = await makeConnection({ channel: 'telegram', status: 'active' })
    await db.update(connections).set({ sessionCiphertext: encryptSecret('some-telegram-session') }).where(eq(connections.id, conn.id))
    const whatsappRoot = path.join(env.DATA_DIR, 'whatsapp')
    const before = existsSync(whatsappRoot)
    expect(await deleteConnection(conn.id)).toBe(true)
    expect(existsSync(whatsappRoot)).toBe(before) // rm never invoked for a non-WhatsApp row
  })

  it('deleteConnection unlinks the downloaded files, not just their rows', async () => {
    const fixture = await makeAttachment({ mimeType: 'image/jpeg', status: 'done', storagePath: 'x.jpg' })
    mkdirSync(mediaDir(), { recursive: true })
    writeFileSync(mediaFilePath('x.jpg'), 'bytes')

    expect(await deleteConnection(fixture.connection.id)).toBe(true)
    expect(await db.select().from(media)).toEqual([])
    expect(existsSync(mediaFilePath('x.jpg'))).toBe(false)
  })

  it('deleteConnection leaves another connection\'s downloaded files untouched', async () => {
    const doomed = await makeAttachment({ mimeType: 'image/jpeg', status: 'done', storagePath: 'doomed.jpg' })
    mkdirSync(mediaDir(), { recursive: true })
    writeFileSync(mediaFilePath('doomed.jpg'), 'bytes')

    const survivor = await makeAttachment({ mimeType: 'image/jpeg', status: 'done', storagePath: 'survivor.jpg' })
    writeFileSync(mediaFilePath('survivor.jpg'), 'bytes')

    expect(await deleteConnection(doomed.connection.id)).toBe(true)
    expect(existsSync(mediaFilePath('doomed.jpg'))).toBe(false)
    expect(existsSync(mediaFilePath('survivor.jpg'))).toBe(true)
    expect((await db.select().from(media)).map(m => m.id)).toEqual([survivor.media.id])
  })

  it('deleteConnection still deletes the connection row when a media file fails to unlink', async () => {
    const fixture = await makeAttachment({ mimeType: 'image/jpeg', status: 'done', storagePath: 'stubborn.jpg' })
    // A directory sits where the file should be: rm(..., { force: true })
    // rejects with EISDIR (not ENOENT, which force swallows), so this
    // exercises the one failure mode force alone does not cover.
    mkdirSync(mediaFilePath('stubborn.jpg'), { recursive: true })

    expect(await deleteConnection(fixture.connection.id)).toBe(true)
    expect(await db.select().from(connections).where(eq(connections.id, fixture.connection.id))).toEqual([])
  })

  it('maps the partial-unique-index race to already_connected, top-level or under cause, and passes through anything else', () => {
    expect(mapInsertError({ code: 'SQLITE_CONSTRAINT_UNIQUE' })).toBe('already_connected')
    expect(mapInsertError({ message: 'wrapped', cause: { code: 'SQLITE_CONSTRAINT_UNIQUE' } })).toBe('already_connected')
    expect(mapInsertError({ code: 'SQLITE_CONSTRAINT_FOREIGNKEY' })).toBeNull()
    expect(mapInsertError(new Error('boom'))).toBeNull()
    expect(mapInsertError(undefined)).toBeNull()
  })

  it('submitLoginPassword refuses a pending connection that never asked for a password', async () => {
    const conn = await makeConnection({ channel: 'telegram', status: 'pending' })
    expect(await submitLoginPassword(conn.id, 'hunter2')).toBe(false)
    const row = await rowOf(conn.id)
    expect(row.loginSecretCiphertext).toBeNull()
    expect(row.loginSecretAt).toBeNull()
  })
})
