// Stands in for `next/font/google` under vitest (see vitest.config.mts). The
// real module is a compile-time loader: Next's SWC transform replaces each
// call with a bundled font at build time, and the untransformed export is not
// callable. Tests that import app/layout.tsx (tests/build-time-imports) only
// need each face to resolve to the shape the layout reads.
type Face = { className: string; variable: string; style: { fontFamily: string } }
const face = (family: string) => (): Face => ({ className: '', variable: '', style: { fontFamily: family } })

export const Instrument_Serif = face('Instrument Serif')
export const Instrument_Sans = face('Instrument Sans')
export const IBM_Plex_Mono = face('IBM Plex Mono')
