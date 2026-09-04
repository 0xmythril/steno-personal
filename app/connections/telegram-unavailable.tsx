import { CHANNEL_LABELS } from '@/lib/format'

// Shown in place of the Telegram card wherever a pairing could start, when
// this deploy runs without Telegram — TELEGRAM_API_ID=0, or a fork that
// stripped the shipped pair. Says so on the page, instead of letting the
// reader wait for a login code that no worker will ever publish. There is deliberately no Connect
// button: the services refuse the row too (telegram_unconfigured), this just
// keeps the reader from finding that out the slow way.
export function TelegramUnavailable({ heading = CHANNEL_LABELS.telegram }: { heading?: string }) {
  return (
    <section className="card">
      <div className="card-head"><h2>{heading}</h2><span className="chip off">Not available</span></div>
      <p>
        This deploy runs without Telegram, so it cannot pair a Telegram account.
      </p>
      <p className="muted">
        Whoever runs it set <code>TELEGRAM_API_ID=0</code>. Removing it restores the pair the project ships with;
        setting <code>TELEGRAM_API_ID</code> and <code>TELEGRAM_API_HASH</code> together uses a pair of their own from{' '}
        <a href="https://my.telegram.org" rel="noreferrer">my.telegram.org</a>. After a restart the card offers to
        connect. WhatsApp works either way.
      </p>
    </section>
  )
}
