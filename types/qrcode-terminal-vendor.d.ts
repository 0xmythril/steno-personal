// Ambient types for qrcode-terminal's vendored QR encoder: no public types
// ship for these internal paths. See lib/qrcode.ts for why we reach into them
// instead of adding another dependency.
declare module 'qrcode-terminal/vendor/QRCode' {
  export default class QRCode {
    constructor(typeNumber: number, errorCorrectLevel: number)
    addData(data: string): void
    make(): void
    getModuleCount(): number
    isDark(row: number, col: number): boolean
  }
}

declare module 'qrcode-terminal/vendor/QRCode/QRErrorCorrectLevel' {
  const levels: { L: number; M: number; Q: number; H: number }
  export default levels
}
