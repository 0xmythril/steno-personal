import { listChats } from '@/lib/services/queries'

// Spec invariant 7 is about *copy*: "Agent-facing copy never advertises what
// is not connected", so a stranger who reaches /mcp learns nothing about what
// this instance could be. It is not an archive-wide gate. The portal
// deliberately keeps serving history after a disconnect ("Everything already
// archived stays readable below.", app/page.tsx) and so does GET /api/chats
// with the same access key — and the two surfaces read the same
// lib/services/queries.ts precisely so the transcript an agent sees and the
// one the portal renders can never disagree. So the content tools fall back to
// the sentence only when there is nothing connected AND nothing archived.
export async function archiveIsEmpty(): Promise<boolean> {
  return (await listChats()).length === 0
}
