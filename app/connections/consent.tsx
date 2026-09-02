import { DEVICE_MODEL } from '@/lib/channels/device-model'

// The consent copy lives in ONE component so it can be reviewed as a unit, and
// every claim it makes is enforced somewhere: read-only by the port surface (no
// send method exists to call), invisible by the mtcute binding's banned-mutator
// test, private by there being no second reader, and revocation by the single
// revoke authority. Do not add a claim this system does not keep.
//
// M2 appends WhatsApp's three extra sentences to this component.
export function Consent({ channel }: { channel: 'telegram' | 'whatsapp' }) {
  return (
    <div className="card">
      <h3>What connecting does</h3>
      <ul>
        <li>
          <strong>It reads everything on the account.</strong> Every chat — direct
          messages, groups and channels — including the media in them.
        </li>
        <li>
          <strong>It is read-only and invisible.</strong> It never marks anything
          as read, never shows you as online, never sends, replies, reacts, or
          types. Nobody you talk to sees any change.
        </li>
        <li>
          <strong>It stays on this machine.</strong> Your messages go into this
          instance&apos;s own database and nowhere else. Only someone holding one
          of your access keys can read them.
        </li>
        <li>
          <strong>You can end it from either side.</strong> Disconnect here signs
          this device out. To check, open{' '}
          {channel === 'telegram'
            ? <>Telegram &rarr; Settings &rarr; Devices</>
            : <>WhatsApp &rarr; Linked devices</>}{' '}
          and remove <strong>{DEVICE_MODEL}</strong> if it is still listed.
        </li>
        <li>
          Telegram&apos;s terms forbid using its data to train models. Reading your
          own messages so an agent can answer with your context is not training,
          and nothing here trains on them.
        </li>
      </ul>
    </div>
  )
}
