import { CHANNEL_LABELS } from '@/lib/format'

// The channel's name in its brand colour, so a WhatsApp row and a Telegram row
// tell apart at a glance. Colour only — the word is always there for anyone
// who cannot see it.
export function ChannelName({ channel }: { channel: keyof typeof CHANNEL_LABELS }) {
  return <span className={`channel channel-${channel}`}>{CHANNEL_LABELS[channel]}</span>
}
