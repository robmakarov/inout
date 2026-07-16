export interface Capabilities {
  chromium: boolean
  screenCapture: boolean
  camera: boolean
  webCodecs: boolean
  opfs: boolean
  /** Full support = every capture + compose feature works. */
  full: boolean
}

export function detectCapabilities(): Capabilities {
  const nav = typeof navigator !== 'undefined' ? navigator : undefined
  const chromium = !!(nav && 'userAgentData' in nav)
  const screenCapture = !!nav?.mediaDevices?.getDisplayMedia
  const camera = !!nav?.mediaDevices?.getUserMedia
  const webCodecs = typeof VideoEncoder !== 'undefined' && typeof AudioEncoder !== 'undefined'
  const opfs = !!nav?.storage?.getDirectory
  return {
    chromium,
    screenCapture,
    camera,
    webCodecs,
    opfs,
    full: screenCapture && camera && webCodecs && opfs,
  }
}
