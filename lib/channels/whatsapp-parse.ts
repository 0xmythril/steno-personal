import type { IncomingMessage } from '@/lib/services/ingest'

// Ported from the private Steno cloud repo (origin/main), lib/services/ingest.ts
// (unwrapContent, textOf, parseProtocolEvent, parseWaMessage,
// resolveContactIdentity), then generalised from "groups only" to any
// remoteJid.
//
// NOTHING IN THIS FILE MAY IMPORT THE BAILEYS LIBRARY (spec invariant 2 —
// lib/channels/whatsapp.ts is the one module allowed to name the package, and
// tests/whatsapp-structure.test.ts scans raw source text, comments included).
// Every input is a plain object handed over by lib/channels/whatsapp.ts, which
// is what makes all of this unit-testable without a socket.

export type WaChatKind = 'dm' | 'group' | 'channel'
export type WaMessageType = IncomingMessage['type']
export type WaMedia = IncomingMessage['media']

const MEDIA_KEYS: Record<string, WaMessageType> = {
  imageMessage: 'image',
  videoMessage: 'video',
  audioMessage: 'audio',
  documentMessage: 'document',
  stickerMessage: 'sticker',
}

// The "future-proof" wrappers WhatsApp nests real content inside (each holds
// the actual message at .message). An inbound edit, in particular, arrives as
// editedMessage -> message -> protocolMessage — NOT as a bare protocolMessage —
// so protocol detection must unwrap before it looks.
const WRAPPER_KEYS = [
  'ephemeralMessage', 'viewOnceMessage', 'viewOnceMessageV2',
  'viewOnceMessageV2Extension', 'documentWithCaptionMessage', 'editedMessage',
] as const

/* eslint-disable @typescript-eslint/no-explicit-any */

export function unwrapContent(content: any): any {
  for (let i = 0; i < 5; i++) {
    const key = WRAPPER_KEYS.find(k => content?.[k]?.message)
    if (!key) break
    content = content[key].message
  }
  return content
}

export function textOf(content: any): string | null {
  if (typeof content?.conversation === 'string') return content.conversation
  if (typeof content?.extendedTextMessage?.text === 'string') return content.extendedTextMessage.text
  for (const key of Object.keys(MEDIA_KEYS)) {
    if (typeof content?.[key]?.caption === 'string') return content[key].caption
  }
  return null
}

// Chat kind straight off the JID suffix (spec 4.3). null means "skip this
// chat entirely": status@broadcast and broadcast lists are not conversations
// we archive, and an unrecognised server (@call, @bot) is not either.
export function chatKindForJid(jid: string | null | undefined): WaChatKind | null {
  if (!jid) return null
  if (jid.endsWith('@broadcast')) return null
  if (jid.endsWith('@g.us')) return 'group'
  if (jid.endsWith('@newsletter')) return 'channel'
  if (jid.endsWith('@s.whatsapp.net') || jid.endsWith('@c.us') || jid.endsWith('@lid')) return 'dm'
  return null
}

// protobuf uint64 reaches us as a number, a string, or a {low,high} Long —
// and, after a JSON round-trip through the messages.raw column, usually the
// last of the three.
function longToNumber(v: unknown): number {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0
  if (typeof v === 'string') { const n = Number(v); return Number.isFinite(n) ? n : 0 }
  if (v && typeof v === 'object') {
    const lo = Number((v as { low?: unknown }).low ?? NaN)
    const hi = Number((v as { high?: unknown }).high ?? 0)
    if (Number.isFinite(lo)) return hi * 4294967296 + (lo >>> 0)
  }
  return 0
}

export function tsToDate(ts: unknown): Date {
  return new Date(longToNumber(ts) * 1000)
}

export type WaIdentity = { jid: string; lidJid: string | null; phone: string | null }

const isPnJid = (j: string) => j.endsWith('@s.whatsapp.net') || j.endsWith('@c.us')
const isLidJid = (j: string) => j.endsWith('@lid')

export function phoneFromPnJid(pnJid: string): string | null {
  const local = pnJid.split('@')[0].split(':')[0]
  return /^\d+$/.test(local) ? `+${local}` : null
}

export type WaIdentityCandidates = {
  id?: string
  lid?: string
  phoneNumber?: string
  participant?: string
  participantAlt?: string
}

// Product decision carried over from Steno cloud (spec 4.3, "one contact is
// one chat"): the phone-number JID is the canonical identity. `jid` is the PN
// JID whenever one appears among the candidates, whichever field it arrived
// on, and falls back to a @lid only when no PN is known at all. `lidJid` is
// captured independently so it stays available as a secondary key.
export function resolveContactIdentity(c: WaIdentityCandidates): WaIdentity | null {
  const ordered = [c.participantAlt, c.participant, c.phoneNumber, c.id, c.lid].filter((v): v is string => !!v)
  if (ordered.length === 0) return null
  const pnJid = ordered.find(isPnJid) ?? null
  const lidJid = (c.lid && isLidJid(c.lid) ? c.lid : null) ?? ordered.find(isLidJid) ?? null
  const jid = pnJid ?? lidJid ?? ordered[0]
  return { jid, lidJid, phone: pnJid ? phoneFromPnJid(pnJid) : null }
}

export type WaProtocolEvent =
  | { kind: 'delete'; remoteJid: string; waId: string; sentAt: Date }
  | { kind: 'edit'; remoteJid: string; waId: string; newText: string | null }

// Revoke (delete-for-everyone) and edit events, in any wrapping. Returns null
// for ordinary content messages, which then flow on to parseWaMessage.
// WAProto/index.d.ts:8620 (baileys 7.0.0-rc14): ProtocolMessage.Type.REVOKE = 0,
// MESSAGE_EDIT = 14. The edit branch keys off the presence of editedMessage
// rather than the numeric type, because that is the field we need anyway.
export function parseProtocolEvent(m: any): WaProtocolEvent | null {
  const remoteJid: string | undefined = m?.key?.remoteJid
  if (!remoteJid) return null
  const proto = unwrapContent(m?.message ?? {})?.protocolMessage
  const targetId: string | undefined = proto?.key?.id
  if (!proto || !targetId) return null
  if (proto.type === 0) return { kind: 'delete', remoteJid, waId: targetId, sentAt: tsToDate(m?.messageTimestamp) }
  if (proto.editedMessage) return { kind: 'edit', remoteJid, waId: targetId, newText: textOf(proto.editedMessage) }
  return null
}

export type ParsedWaMessage = {
  waId: string
  remoteJid: string
  chatKind: WaChatKind
  sender: WaIdentity | null
  senderName: string | null
  fromOwner: boolean
  sentAt: Date
  type: WaMessageType
  text: string | null
  media: WaMedia
  raw: unknown
}

// Live group messages carry the sender at m.key.participant (LID-addressed
// groups also carry the real PN at m.key.participantAlt). History-sync
// messages carry it one level up, at m.participant / m.participantAlt —
// Baileys never copies those into m.key. A DM has no participant at all: the
// counterparty IS the remoteJid (with m.key.remoteJidAlt as its PN
// counterpart — see lib/Types/Message.d.ts:21, baileys 7.0.0-rc14). An own
// message identifies its sender through fromOwner, not through a JID.
function resolveSender(m: any, chatKind: WaChatKind, fromOwner: boolean): WaIdentity | null {
  if (chatKind === 'dm') {
    if (fromOwner) return null
    return resolveContactIdentity({ participant: m?.key?.remoteJid, participantAlt: m?.key?.remoteJidAlt })
  }
  return resolveContactIdentity({
    participant: m?.key?.participant ?? m?.participant,
    participantAlt: m?.key?.participantAlt ?? m?.participantAlt,
  })
}

function mediaMeta(type: WaMessageType, node: any): WaMedia {
  // `seconds` is a uint32 on the wire. Anything that is not a finite positive
  // value inside int32 is treated as unknown rather than trusted.
  const secs = Math.round(Number(node?.seconds))
  const knownDuration = Number.isFinite(secs) && secs > 0 && secs < 2 ** 31
  const size = longToNumber(node?.fileLength)
  return {
    mimeType: typeof node?.mimetype === 'string' ? node.mimetype : null,
    sizeBytes: size > 0 ? size : null,
    isVoiceNote: type === 'audio' ? !!node?.ptt : null,
    durationSeconds: type === 'audio' && knownDuration ? secs : null,
  }
}

export function parseWaMessage(m: any): ParsedWaMessage | null {
  const remoteJid: string | undefined = m?.key?.remoteJid
  const chatKind = chatKindForJid(remoteJid)
  if (!remoteJid || !chatKind) return null
  const waId: string | undefined = m?.key?.id
  if (!waId) return null

  const content = unwrapContent(m?.message ?? {})
  // The control plane is not conversation. Revoke and edit are handled by the
  // port before it calls this; every OTHER protocol type — ephemeral-setting
  // changes, history-sync notifications, app-state key shares — would
  // otherwise become a row with no text and no media that the transcript
  // renders as an empty bubble.
  if (content?.protocolMessage) return null

  const fromOwner = !!m?.key?.fromMe
  const pushName = typeof m?.pushName === 'string' && m.pushName.trim() ? m.pushName.trim() : null
  const base = {
    waId,
    remoteJid,
    chatKind,
    sender: resolveSender(m, chatKind, fromOwner),
    senderName: pushName,
    fromOwner,
    sentAt: tsToDate(m?.messageTimestamp),
    raw: m,
  }

  if (typeof content?.conversation === 'string')
    return { ...base, type: 'text', text: content.conversation, media: null }
  if (content?.extendedTextMessage)
    return { ...base, type: 'text', text: content.extendedTextMessage.text ?? null, media: null }
  for (const [key, type] of Object.entries(MEDIA_KEYS)) {
    const node = content?.[key]
    if (!node) continue
    return { ...base, type, text: node.caption ?? null, media: mediaMeta(type, node) }
  }
  if (m?.messageStubType != null) return { ...base, type: 'system', text: null, media: null }
  return { ...base, type: 'unknown', text: null, media: null }
}

export type ToIncomingCtx = {
  chatTitle: string | null
  // The port supplies these already canonicalised (a @lid resolved to its
  // phone-number JID where WhatsApp could tell us); without an override the
  // parsed values stand.
  externalChatId?: string
  senderExternalId?: string | null
}

export function toIncoming(p: ParsedWaMessage, ctx: ToIncomingCtx): IncomingMessage {
  return {
    externalChatId: ctx.externalChatId ?? p.remoteJid,
    chatKind: p.chatKind,
    chatTitle: ctx.chatTitle,
    externalMessageId: p.waId,
    senderExternalId: ctx.senderExternalId ?? p.sender?.jid ?? null,
    senderName: p.senderName,
    fromOwner: p.fromOwner,
    sentAt: p.sentAt,
    type: p.type,
    text: p.text,
    media: p.media,
    raw: p.raw,
  }
}
