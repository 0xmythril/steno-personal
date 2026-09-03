import type { MessageView } from '@/lib/services/queries'

// Read-only by construction, like the rest of the transcript: an <img>, an
// <audio> player, or a download link, each as a media chip on a well fill
// (DESIGN.md → The transcript). No form, no textarea, no submit — enforced by
// tests/transcript-page-structure.test.ts.
export function MediaAttachment({ media }: { media: NonNullable<MessageView['media']> }) {
  const mime = (media.mimeType ?? '').split(';')[0].trim().toLowerCase()

  if (mime.startsWith('image/')) {
    return (
      <figure className="attachment">
        {/* Plain <img>: next/image would proxy these through the optimizer,
            which means a second copy of private archive bytes on disk. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={media.url} alt="Attached image" loading="lazy" />
        {media.extractedText && <figcaption>&ldquo;{media.extractedText}&rdquo;</figcaption>}
      </figure>
    )
  }

  if (mime.startsWith('audio/')) {
    return (
      <div className="attachment">
        <span className="line"><strong>Voice note</strong></span>
        <audio controls preload="none" src={media.url} />
        {media.extractedText && <p className="transcript-text">&ldquo;{media.extractedText}&rdquo;</p>}
      </div>
    )
  }

  return (
    <p className="attachment">
      <span className="line">
        <a href={media.url} download>Download attachment</a>
        {mime && <span className="kind">{mime}</span>}
      </span>
    </p>
  )
}
