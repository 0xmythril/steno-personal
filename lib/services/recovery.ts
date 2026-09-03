import { and, eq, isNotNull, isNull } from 'drizzle-orm'
import { db } from '@/lib/db/client'
import { connections } from '@/lib/db/schema'
import { mintAccessKey, revokeAccessKey } from './access-keys'
import { getConnection, revokeConnection, type ConnectionStatus } from './connections'
import { CHANNEL_LABELS } from '@/lib/format'
import type { Channel, ChannelAccount } from '@/lib/channels/port'

// Lost-key recovery: the owner pairs the same account a second time, on a
// connection row with purpose 'recovery'. The worker drives that handshake
// exactly like an archive login (lib/services/login.ts), then calls
// completeRecovery instead of completeLogin. A recovery row never becomes
// active, never stores the session string, never records who paired — it ends
// revoked with an outcome, and on a match, a freshly minted key the browser
// that started the attempt claims exactly once.
//
// Proof of ownership is the account id the channel reports for the paired
// device, compared with every ARCHIVE row on that channel, live or past: a
// number connected once and later disconnected still identifies its owner.
// Rows removed by "Delete everything" are gone and cannot vouch for anyone.

export type RecoveryOutcome = 'matched' | 'mismatched'

const CHANNEL_ORDER: Channel[] = ['telegram', 'whatsapp']

// Channels a recovery can be attempted on: those where some archive connection
// has ever reported an account id.
export async function knownAccountChannels(): Promise<Channel[]> {
  const rows = await db.selectDistinct({ channel: connections.channel }).from(connections)
    .where(and(eq(connections.purpose, 'archive'), isNotNull(connections.externalAccountId)))
  const found = new Set(rows.map(r => r.channel))
  return CHANNEL_ORDER.filter(c => found.has(c))
}

// A live recovery row that is not pending is dead (error). It never holds a
// chat, so it is deleted outright to free the (channel, 'recovery') slot; a
// pending one is replaced too — a second Start is the owner giving up on a
// code that never appeared.
export async function startRecovery(channel: Channel): Promise<{ ok: true; id: string } | { ok: false; reason: 'no_known_account' }> {
  if (!(await knownAccountChannels()).includes(channel)) return { ok: false, reason: 'no_known_account' }
  await db.delete(connections)
    .where(and(eq(connections.channel, channel), eq(connections.purpose, 'recovery'), isNull(connections.revokedAt)))
  const [row] = await db.insert(connections).values({ channel, purpose: 'recovery', status: 'pending' })
    .returning({ id: connections.id })
  return { ok: true, id: row.id }
}

export type RecoveryStatus = {
  id: string
  channel: Channel
  status: ConnectionStatus['status']
  outcome: RecoveryOutcome | null
  // A matched attempt whose key has not been claimed yet.
  hasKey: boolean
  lastError: string | null
  login: ConnectionStatus['login']
}

// Only a recovery row answers here: the archive connection's status is served
// by lib/services/connections.ts behind the session cookie, and this one is
// served behind the recovery cookie instead.
export async function getRecoveryAttempt(id: string): Promise<RecoveryStatus | null> {
  const status = await getConnection(id)
  if (!status || status.purpose !== 'recovery') return null
  const [row] = await db.select({ outcome: connections.recoveryOutcome, keyId: connections.recoveryKeyId })
    .from(connections).where(eq(connections.id, id))
  return {
    id: status.id, channel: status.channel, status: status.status,
    outcome: row?.outcome ?? null, hasKey: (row?.keyId ?? null) !== null,
    lastError: status.lastError, login: status.login,
  }
}

// Dated in the instance's own timezone, like every other date it renders
// (lib/format.ts): a UTC date can be yesterday to the person reading it.
const LABEL_DATE = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
export function recoveryKeyLabel(channel: Channel, now: Date = new Date()): string {
  return `Recovered via ${CHANNEL_LABELS[channel]}, ${LABEL_DATE.format(now)}`
}

// Worker-side verdict. Guarded like completeLogin: only a live pending
// recovery row can be completed, so a cancelled attempt reports 'gone' and is
// never written into. The paired account's id is compared and discarded — a
// stranger who pairs their own phone leaves no identifier behind.
export async function completeRecovery(id: string, account: ChannelAccount): Promise<RecoveryOutcome | 'gone'> {
  const [row] = await db.select({ channel: connections.channel }).from(connections)
    .where(and(
      eq(connections.id, id), eq(connections.purpose, 'recovery'),
      eq(connections.status, 'pending'), isNull(connections.revokedAt),
    ))
  if (!row) return 'gone'

  const [match] = account.channel === row.channel
    ? await db.select({ id: connections.id }).from(connections)
      .where(and(
        eq(connections.channel, row.channel), eq(connections.purpose, 'archive'),
        eq(connections.externalAccountId, account.externalAccountId),
      )).limit(1)
    : []

  if (!match) {
    await db.update(connections).set({ recoveryOutcome: 'mismatched' })
      .where(and(eq(connections.id, id), isNull(connections.revokedAt)))
    await revokeConnection(id, 'Recovery: the paired account is not the one this archive belongs to.')
    return 'mismatched'
  }

  const minted = await mintAccessKey(recoveryKeyLabel(row.channel))
  if (!minted.ok) throw new Error(`recovery mint failed: ${minted.reason}`)
  const updated = await db.update(connections).set({ recoveryOutcome: 'matched', recoveryKeyId: minted.id })
    .where(and(eq(connections.id, id), isNull(connections.revokedAt)))
    .returning({ id: connections.id })
  if (updated.length === 0) {
    // Cancelled between the select above and here: nobody can claim this key,
    // so it must not stay active.
    await revokeAccessKey(minted.id)
    return 'gone'
  }
  await revokeConnection(id, 'Recovery: this is the account the archive belongs to.')
  return 'matched'
}

// Hands the minted key's id to the browser exactly once: the conditional
// update is the claim, so two requests racing for it get one winner.
export async function claimRecoveryKey(id: string): Promise<string | null> {
  const [row] = await db.select({ keyId: connections.recoveryKeyId }).from(connections)
    .where(and(eq(connections.id, id), eq(connections.purpose, 'recovery'), eq(connections.recoveryOutcome, 'matched')))
  if (!row?.keyId) return null
  const res = await db.update(connections).set({ recoveryKeyId: null })
    .where(and(eq(connections.id, id), eq(connections.recoveryKeyId, row.keyId)))
    .returning({ id: connections.id })
  return res.length > 0 ? row.keyId : null
}

export async function cancelRecovery(id: string): Promise<boolean> {
  const [row] = await db.select({ id: connections.id }).from(connections)
    .where(and(eq(connections.id, id), eq(connections.purpose, 'recovery')))
  if (!row) return false
  return revokeConnection(id, 'You cancelled this recovery attempt.')
}
