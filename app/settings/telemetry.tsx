import { getSettings } from '@/lib/services/settings'
import { env } from '@/lib/env'
import { updateTelemetryAction } from './actions'

// On by default, and turned off here. The card states the build's own status
// first: a build with no PostHog key sends nothing whatever the box says, and
// a page that hid that would be claiming a behaviour it does not have (the
// same rule the Enrichment card follows).
export async function TelemetrySection() {
  const s = await getSettings()
  const configured = !!env.STENO_POSTHOG_KEY

  return (
    <section className="card">
      <h2>Anonymous usage</h2>
      <p className="muted">
        When you use a feature — run a search, open a transcript, link a person, connect a channel,
        make a key, or turn enrichment on or off — this instance tells the project that it happened,
        so the project can see which parts are worth keeping. Each event is the feature&apos;s name,
        the version, and at most one word more: which channel, which agent tool. It never carries
        what you searched for, which chat you opened, a name, a phone number, or a key, and the random
        id that groups one instance&apos;s events is tied to nothing else — not your volume, not your
        account, not this machine. Events go to PostHog.
      </p>

      {!configured && (
        <p className="help">
          This build carries no PostHog key, so nothing is sent at all right now. The box below
          decides whether it may be, once a build does.
        </p>
      )}

      <form action={updateTelemetryAction} className="stack" style={{ gap: 10 }}>
        <label className="check">
          <input type="checkbox" name="telemetryEnabled" defaultChecked={s.telemetryEnabled} />
          Send anonymous usage events
        </label>
        <p className="help">
          Turn this off and this instance never sends anything, ever. Setting <code>DO_NOT_TRACK=1</code> on
          the host does the same without opening this page.
        </p>
        <div className="actions"><button type="submit" className="small">Save usage setting</button></div>
      </form>
    </section>
  )
}
