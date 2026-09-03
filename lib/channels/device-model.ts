// The name the channel lists this session under (Telegram: Settings ->
// Devices). One constant, two call sites: lib/channels/telegram.ts passes it
// to mtcute as deviceModel, and app/connections/consent.tsx names it as the
// entry to look for. The consent copy is only true while the two agree, so
// they read the same value instead of each being told it separately.
export const DEVICE_MODEL = 'steno-personal'
