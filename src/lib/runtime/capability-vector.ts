import type { CapabilityVector } from '@lumaforge/render-engine/policy'

type CapabilityNavigator = Navigator & {
  deviceMemory?: number
  storage?: {
    getDirectory?: () => unknown
    estimate?: () => unknown
  }
}

function clampInteger(
  value: unknown,
  min: number,
  max: number,
  fallback: number,
): number {
  const n =
    typeof value === 'number' && Number.isFinite(value)
      ? Math.floor(value)
      : fallback

  return Math.min(max, Math.max(min, n))
}

export function classifyUserAgent(
  ua: string,
  touch: boolean,
): CapabilityVector['webKitClass'] {
  if (!ua) return 'unknown'

  const isiOS = /\b(?:iPhone|iPad|iPod)\b/i.test(ua)
  const isIPadOsDesktopMode = /\bMacintosh\b/i.test(ua) && touch
  const webKit = /\bAppleWebKit\b/i.test(ua)
  const mobile = touch || /\bMobile\b/i.test(ua)
  if ((isiOS || isIPadOsDesktopMode) && webKit && mobile) {
    return 'webkit-mobile'
  }

  const desktopMac = /\bMacintosh\b/i.test(ua)
  const safari = /\bSafari\b/i.test(ua)
  const chromiumFamily =
    /\b(?:Chrome|Chromium|HeadlessChrome|CriOS|Edg|OPR|FxiOS)\b/i.test(ua)
  if (desktopMac && webKit && safari && !chromiumFamily && !touch) {
    return 'webkit-desktop-safari'
  }

  if (chromiumFamily) return 'chromium'

  return 'unknown'
}

export function classifyDeviceFormFactor(
  ua: string,
  touch: boolean,
): CapabilityVector['deviceFormFactor'] {
  if (!ua) return 'unknown'

  const isiOS = /\b(?:iPhone|iPad|iPod)\b/i.test(ua)
  const isIPadOsDesktopMode = /\bMacintosh\b/i.test(ua) && touch
  const mobileOrTablet =
    /\b(?:Android|Mobile|Mobi|Tablet|Silk|Kindle|Windows Phone)\b/i.test(ua)
  if (isiOS || isIPadOsDesktopMode || mobileOrTablet) {
    return 'mobile'
  }

  const desktop =
    /\b(?:Macintosh|Windows NT|Win64|WOW64|X11|CrOS|Linux x86_64)\b/i.test(ua)
  if (desktop) return 'desktop'

  return touch ? 'mobile' : 'unknown'
}

function detectThreads(coi: boolean): boolean {
  if (!coi) return false

  try {
    return typeof SharedArrayBuffer !== 'undefined'
  } catch {
    return false
  }
}

let cached: CapabilityVector | null = null

export function detectCapabilityVector(): CapabilityVector {
  if (cached) return cached

  const nav = globalThis.navigator as CapabilityNavigator | undefined
  const ua = nav?.userAgent ?? ''
  const touch =
    typeof nav?.maxTouchPoints === 'number' ? nav.maxTouchPoints > 0 : false
  const coi = Boolean(globalThis.crossOriginIsolated)
  const pthread = detectThreads(coi)
  const deviceMemory = nav?.deviceMemory
  const deviceMemoryGB =
    typeof deviceMemory === 'number' &&
    Number.isFinite(deviceMemory) &&
    deviceMemory > 0
      ? deviceMemory
      : null
  const maybeOpfsSupported =
    typeof nav?.storage?.getDirectory === 'function' &&
    typeof nav.storage.estimate === 'function'

  const vector: CapabilityVector = Object.freeze({
    coi,
    pthread,
    deviceMemoryGB,
    hwConcurrency: clampInteger(nav?.hardwareConcurrency, 1, 64, 1),
    webKitClass: classifyUserAgent(ua, touch),
    deviceFormFactor: classifyDeviceFormFactor(ua, touch),
    maybeOpfsSupported,
  })
  cached = vector

  return vector
}

export function getCapabilityVectorSnapshot(): CapabilityVector | null {
  return cached
}
