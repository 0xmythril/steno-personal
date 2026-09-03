import type { IncomingMessage } from './ingest'

// M1 stores only the has_media flag on the message row; the download drain,
// the media table, and the enrichment pipeline all arrive in M4. This module
// exists now so lib/channels/session-manager.ts can call the real signature
// from the start — M4 replaces the body, not the call site.
export async function enqueueMedia(
  _messageId: string,
  _connectionId: string,
  _meta: NonNullable<IncomingMessage['media']>,
): Promise<void> {}
