import './globals.css'
import type { ReactNode } from 'react'
import { SiteFooter } from './site-footer'

export const metadata = { title: 'steno-personal' }

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        {children}
        <SiteFooter />
      </body>
    </html>
  )
}
