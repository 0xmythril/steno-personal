import { describe, it, expect } from 'vitest'
import { renderQrSvg } from '@/lib/qrcode'

describe('renderQrSvg', () => {
  it('renders a square SVG with a path and an accessible name', () => {
    const svg = renderQrSvg('tg://login?token=abc', 'Telegram login QR code')
    expect(svg.startsWith('<svg ')).toBe(true)
    expect(svg).toMatch(/viewBox="0 0 (\d+) \1"/)
    expect(svg).toContain('role="img"')
    expect(svg).toContain('aria-label="Telegram login QR code"')
    expect(svg).toMatch(/<path d="M/)
  })

  it('renders dark on light regardless of the reader\'s theme', () => {
    // A QR that inherits a dark theme is a QR that cannot be scanned.
    const svg = renderQrSvg('x', 'l')
    expect(svg).toContain('fill="#ffffff"')
    expect(svg).toContain('fill="#000000"')
  })

  it('escapes the label and never interpolates the payload into markup', () => {
    const svg = renderQrSvg('tg://login?token=<script>', 'a "b" & <c>')
    expect(svg).toContain('aria-label="a &quot;b&quot; &amp; &lt;c&gt;"')
    expect(svg).not.toContain('<script>')
  })

  it('grows with the payload', () => {
    const small = renderQrSvg('a', 'l').length
    const large = renderQrSvg('a'.repeat(200), 'l').length
    expect(large).toBeGreaterThan(small)
  })
})
