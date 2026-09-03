import { getSettings } from '@/lib/services/settings'
import { env } from '@/lib/env'
import { updateTelemetryAction } from './actions'

// On by default, and turned off here. The card states the endpoint's own
// status first: with no STENO_TELEMETRY_URL set on this host nothing is sent
// whatever the box says, and a page that hid that would be claiming a
// behaviour it does not have (the same rule the Enrichment card follows).
export async function TelemetrySection() {
  const s = await getSettings()
  const configured = !!env.STENO_TELEMETRY_URL

  return (
    <section className="card">
      <h2>Anonymous usage</h2>
      <p className="muted">
        Once a day this instance can post a short count of how it is being used, so the project can
        see which parts are worth keeping. It carries a random id minted here, the version, which
        channels are connected, how many chats, messages, people and keys exist, and whether
        enrichment is on. It never carries a message, a chat title, a name, a phone number, a search
        query or a key, and the random id is tied to nothing else — not your volume, not your
        account, not this machine.
      </p>

      {!configured && (
        <p className="help">
          No collector is configured on this host, so nothing is sent at all right now. Setting
          <code> STENO_TELEMETRY_URL</code> is what turns the ping on; the box below decides whether
          it is allowed to run once one is set.
        </p>
      )}

      <form action={updateTelemetryAction} className="stack" style={{ gap: 10 }}>
        <label className="check">
          <input type="checkbox" name="telemetryEnabled" defaultChecked={s.telemetryEnabled} />
          Send anonymous usage counts
        </label>
        <p className="help">Turn this off and this instance never posts anything, ever.</p>
        <div className="actions"><button type="submit" className="small">Save usage setting</button></div>
      </form>
    </section>
  )
}
