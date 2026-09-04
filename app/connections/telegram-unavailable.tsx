import { CHANNEL_LABELS } from '@/lib/format'

// Shown in place of the Telegram card wherever a pairing could start, when the
// deploy has no Telegram application pair. Says what is missing and where it
// comes from, on the page, instead of letting the reader wait for a login
// code that no worker will ever publish. There is deliberately no Connect
// button: the services refuse the row too (telegram_unconfigured), this just
// keeps the reader from finding that out the slow way.
export function TelegramUnavailable({ heading = CHANNEL_LABELS.telegram }: { heading?: string }) {
  return (
    <section className="card">
      <div className="card-head"><h2>{heading}</h2><span className="chip off">Not available</span></div>
      <p>
        This deploy has no Telegram application credentials, so it cannot pair a Telegram account yet.
      </p>
      <p className="muted">
        Whoever runs it sets <code>TELEGRAM_API_ID</code> and <code>TELEGRAM_API_HASH</code> — a pair registered at{' '}
        <a href="https://my.telegram.org" rel="noreferrer">my.telegram.org</a> — and restarts; the card then offers to
        connect. Until then WhatsApp still works.
      </p>
    </section>
  )
}
