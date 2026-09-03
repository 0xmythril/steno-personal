// The project's own Telegram application credentials (spec decision 12), so a
// one-click deploy needs nothing from my.telegram.org — the same thing
// Telegram Desktop and every open-source client ships.
//
// THEY ARE EMPTY until the owner registers the application at
// https://my.telegram.org and pastes the pair in here. Until then a
// self-hoster supplies their own through TELEGRAM_API_ID / TELEGRAM_API_HASH,
// and the worker logs one warning and runs without the Telegram port.
export const TELEGRAM_DEFAULT_API_ID = 0
export const TELEGRAM_DEFAULT_API_HASH = ''
