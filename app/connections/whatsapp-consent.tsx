import { Consent } from './consent'

// The consent copy. These three sentences are VERBATIM here and in the
// README. They are not softened, not reordered, and not
// hidden behind a disclosure — the whole point of accepting the ban risk
// rather than gating it is that the user reads this before the QR appears.
// tests/whatsapp-structure.test.ts pins them.
export const WHATSAPP_CONSENT_SENTENCES = [
  'WhatsApp does not permit unofficial clients.',
  'Your number can be restricted or banned, and your phone will show an unofficial-client notice under Linked devices.',
  'The risk is higher when this runs on a cloud host than on a machine at home.',
] as const

// The three sentences alone, for a pairing that reads nothing — lost-key
// recovery links a device only to learn which account it is, then unlinks it.
// The account risk is the same, so the warning is the same.
export function WhatsAppRisk() {
  return <p className="danger">{WHATSAPP_CONSENT_SENTENCES.join(' ')}</p>
}

export function WhatsAppConsent() {
  return (
    <>
      <Consent channel="whatsapp" />
      <WhatsAppRisk />
    </>
  )
}
