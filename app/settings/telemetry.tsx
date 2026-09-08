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
      <p className="muted">Help improve Steno by sending feature usage to PostHog.</p>
      <ul className="settings-copy-list muted">
        <li>Includes feature names, app version, and basic details such as channel, tool, or enabled features.</li>
        <li>Excludes messages, searches, chat IDs, names, phone numbers, and keys.</li>
        <li>Groups events with a random instance ID, not one derived from your account or device.</li>
      </ul>

      {!configured && (
        <p className="help">
          Usage reporting is not configured in this build. This preference will apply if it is configured later.
        </p>
      )}

      <form action={updateTelemetryAction} className="usage-settings-form">
        <label className="check">
          <input type="checkbox" name="telemetryEnabled" defaultChecked={s.telemetryEnabled} />
          Send anonymous usage events
        </label>
        <p className="help">
          Turn off to stop usage reporting. The host can also disable it with <code>DO_NOT_TRACK=1</code>.
        </p>
        <div className="actions"><button type="submit" className="small">Save usage setting</button></div>
      </form>
    </section>
  )
}
