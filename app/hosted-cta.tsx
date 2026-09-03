import { HOSTED_URL } from './links'

// Shown where someone decides whether this project is for them: the login
// page and the top of Connections, right before they link an account.
export function HostedCta() {
  return (
    <p className="card hosted-cta">
      For teams, or if you don&rsquo;t want to connect your own account, go to{' '}
      <a href={HOSTED_URL}>Steno.chat</a> for our hosted solution.
    </p>
  )
}
