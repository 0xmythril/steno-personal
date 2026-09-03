// Renders a login token as a scannable inline SVG, on the server.
//
// No new dependency: qrcode-terminal vendors the classic davidshimjs encoder,
// which computes the actual module matrix (qrcode-terminal's own public API
// only turns that into ASCII art). We reuse that same well-tested encoder and
// draw our own SVG from the grid.
import QRCode from 'qrcode-terminal/vendor/QRCode'
import QRErrorCorrectLevel from 'qrcode-terminal/vendor/QRCode/QRErrorCorrectLevel'

const MODULE_SIZE = 6
const QUIET_ZONE_MODULES = 4 // the QR spec's minimum quiet zone

// Only the label is ever interpolated into markup, and only as an attribute
// value; the payload becomes coordinates, never text. Escaped anyway so the
// function does not depend on every caller passing a literal.
function escapeForSvg(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

// Deliberately NOT theme-aware: a QR code has to be dark modules on a light
// ground to scan, so it paints its own colours instead of inheriting the
// page's.
export function renderQrSvg(data: string, label: string): string {
  const qr = new QRCode(-1, QRErrorCorrectLevel.M) // -1 = pick the smallest version that fits
  qr.addData(data)
  qr.make()

  const count = qr.getModuleCount()
  const size = (count + QUIET_ZONE_MODULES * 2) * MODULE_SIZE

  let path = ''
  for (let row = 0; row < count; row++) {
    for (let col = 0; col < count; col++) {
      if (!qr.isDark(row, col)) continue
      const x = (col + QUIET_ZONE_MODULES) * MODULE_SIZE
      const y = (row + QUIET_ZONE_MODULES) * MODULE_SIZE
      path += `M${x},${y}h${MODULE_SIZE}v${MODULE_SIZE}h-${MODULE_SIZE}z`
    }
  }

  return `<svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="${escapeForSvg(label)}">`
    + `<rect width="${size}" height="${size}" fill="#ffffff" />`
    + `<path d="${path}" fill="#000000" />`
    + `</svg>`
}
