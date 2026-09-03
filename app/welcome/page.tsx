import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import { requireSession } from '@/lib/auth'
import { FIRST_KEY_COOKIE } from '@/lib/services/keys-flash'
import { Nav } from '@/app/nav'
import { SaveKeyGate } from './save-key-gate'
import { welcomeDoneAction } from './actions'

type Flash = { id: string; rawKey: string } | null
function parseFlash(raw: string | undefined): Flash {
  if (!raw) return null
  try { return JSON.parse(raw) } catch { return null }
}

// The one screen that shows the first key. It is fed by the httpOnly flash
// setFirstKeyFlash() set — from /setup or from a matched recovery — and only
// for the session that was started with that same key. No flash, nothing to
// show: straight to the archive.
export default async function WelcomePage() {
  const session = await requireSession()
  const jar = await cookies()
  const flash = parseFlash(jar.get(FIRST_KEY_COOKIE)?.value)
  if (!flash || flash.id !== session.keyId) redirect('/')

  return (
    <>
      <Nav label={session.label} via={session.via} />
      <main>
        <div className="onboard">
          <div><p className="eyebrow">First run</p><h1>Your access key</h1></div>
          <section className="card">
            <p>
              This key logs you into this portal, and it is what an agent uses to read your archive over MCP.
              Save it now — in a password manager, or somewhere you will find it.
            </p>
            <form action={welcomeDoneAction} className="stack" style={{ gap: 12 }}>
              <SaveKeyGate rawKey={flash.rawKey} />
            </form>
            <p className="help">
              While you are logged in you can see it again under Settings, and make more keys there — one per device or
              agent. Logged out, nobody can show it to you: the way back in is to pair the same phone again from the login
              page, or a key minted by whoever runs this instance.
            </p>
          </section>
        </div>
      </main>
    </>
  )
}
