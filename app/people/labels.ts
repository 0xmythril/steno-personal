import type { Channel } from '@/lib/channels/port'

// One way to name a channel identity everywhere the portal shows one: the name
// that channel knows them by, then the number behind it — or the raw id, when
// there is no number to show. Both live in the local database and on these
// pages only; neither ever reaches a URL or a log.
export function candidateLabel(
  c: { displayName: string | null; phone: string | null; externalId: string },
): string {
  return `${c.displayName ?? 'No name'} · ${c.phone ?? c.externalId}`
}

// Server actions signal failure with a short code in `?error=`, never with a
// sentence — and never with a name or a number. The sentences live here.
export const PEOPLE_ERRORS: Record<string, string> = {
  length: 'A name has to be between 1 and 100 characters.',
  linked: 'That identity already belongs to someone else. Unlink it there first.',
  empty: 'Choose someone to link first.',
  stale: 'That suggestion is out of date: one side is already linked to a person. The list below is current.',
  // Covers a person and a link alike: whichever one the action reached for,
  // the row was not there any more.
  gone: 'That is already gone — it was deleted while this page was open.',
  unknown: 'This instance has never heard of that identity. The list below is current.',
}

export const CHANNELS: readonly Channel[] = ['telegram', 'whatsapp']

// How the link came to be, in the owner's words rather than the column's.
export const SOURCE_LABELS = {
  manual: 'you linked it',
  phone_match: 'confirmed phone match',
  name_match: 'confirmed name match',
  auto: 'from your contacts',
} as const
