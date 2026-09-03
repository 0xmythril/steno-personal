import { Consent } from './consent'

// The consent copy. These two sentences are VERBATIM here and in the
// README, shown before the QR appears and never hidden behind a disclosure.
// tests/whatsapp-structure.test.ts pins them.
export const WHATSAPP_CONSENT_SENTENCES = [
  'This connects through an unofficial WhatsApp client.',
  'Use it at your own risk.',
] as const

// The two sentences alone, for a pairing that reads nothing — lost-key
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
