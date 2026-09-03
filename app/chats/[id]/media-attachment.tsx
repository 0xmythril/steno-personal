import type { MessageView } from '@/lib/services/queries'

// Read-only by construction, like the rest of the transcript: an <img>, an
// <audio> player, or a download link. No form, no textarea, no submit —
// enforced by tests/transcript-page-structure.test.ts.
export function MediaAttachment({ media }: { media: NonNullable<MessageView['media']> }) {
  const mime = (media.mimeType ?? '').split(';')[0].trim().toLowerCase()

  if (mime.startsWith('image/')) {
    return (
      <figure className="attachment">
        {/* Plain <img>: next/image would proxy these through the optimizer,
            which means a second copy of private archive bytes on disk. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={media.url} alt="Attached image" loading="lazy" />
        {media.extractedText && <figcaption className="muted">{media.extractedText}</figcaption>}
      </figure>
    )
  }

  if (mime.startsWith('audio/')) {
    return (
      <div className="attachment">
        <audio controls preload="none" src={media.url} />
        {media.extractedText && <p className="muted">{media.extractedText}</p>}
      </div>
    )
  }

  return (
    <p className="attachment">
      <a href={media.url} download>Download attachment</a>
      {mime && <span className="muted"> ({mime})</span>}
    </p>
  )
}
