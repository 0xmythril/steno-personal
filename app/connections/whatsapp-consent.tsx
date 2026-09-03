import { Consent } from './consent'

// Spec decision 2 and the shared-interfaces "Consent copy" section: these
// three sentences are VERBATIM. They are not softened, not reordered, and not
// hidden behind a disclosure — the whole point of accepting the ban risk
// rather than gating it is that the user reads this before the QR appears.
// tests/whatsapp-structure.test.ts pins them.
export const WHATSAPP_CONSENT_SENTENCES = [
  'WhatsApp does not permit unofficial clients.',
  'Your number can be restricted or banned, and your phone will show an unofficial-client notice under Linked devices.',
  'The risk is higher when this runs on a cloud host than on a machine at home.',
] as const

export function WhatsAppConsent() {
  return (
    <>
      <Consent channel="whatsapp" />
      <p className="danger">{WHATSAPP_CONSENT_SENTENCES.join(' ')}</p>
    </>
  )
}
