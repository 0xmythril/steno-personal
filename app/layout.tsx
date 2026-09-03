import './globals.css'
import type { ReactNode } from 'react'
import { Instrument_Serif, Instrument_Sans, IBM_Plex_Mono } from 'next/font/google'
import { SiteFooter } from './site-footer'

// The three faces DESIGN.md names, fetched once at build time and served from
// this instance. A <link> to Google Fonts would be a request leaving the
// machine on every page view; tests/design-tokens.test.ts forbids it.
const serif = Instrument_Serif({ weight: '400', style: ['normal', 'italic'], subsets: ['latin'], variable: '--font-serif', display: 'swap' })
const sans = Instrument_Sans({ weight: ['400', '500', '600'], subsets: ['latin'], variable: '--font-sans', display: 'swap' })
const mono = IBM_Plex_Mono({ weight: ['400', '500'], subsets: ['latin'], variable: '--font-mono', display: 'swap' })

export const metadata = { title: 'Steno Personal' }

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${serif.variable} ${sans.variable} ${mono.variable}`}>
      <body>
        {children}
        <SiteFooter />
      </body>
    </html>
  )
}
