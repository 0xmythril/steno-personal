import { HOSTED_URL } from './links'

// Shown where someone decides whether this project is for them: the login
// page and Connections, right before they link an account. The one mint card
// a screen may carry (DESIGN.md → Cards).
export function HostedCta() {
  return (
    <aside className="card hosted-cta">
      <h2>For a team, or if you don&rsquo;t want to connect your own account</h2>
      <p>Steno Cloud runs the recorder for you, with one archive every member can read. <a href={HOSTED_URL}>Go to Steno.chat &rarr;</a></p>
    </aside>
  )
}
