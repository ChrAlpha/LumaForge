import type { CapabilityVector } from '@lumaforge/render-engine/policy'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let detectCapabilityVector: typeof import('./capability-vector').detectCapabilityVector
let getCapabilityVectorSnapshot: typeof import('./capability-vector').getCapabilityVectorSnapshot

beforeEach(async () => {
  vi.resetModules()
  ;({ detectCapabilityVector, getCapabilityVectorSnapshot } =
    await import('./capability-vector'))
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('detectCapabilityVector', () => {
  it('produces a frozen vector with sane defaults when navigator fields are missing', async () => {
    vi.stubGlobal('navigator', {
      userAgent: '',
      hardwareConcurrency: undefined,
      deviceMemory: undefined,
      storage: undefined,
    } as never)
    vi.stubGlobal('crossOriginIsolated', false)

    const vector: CapabilityVector = await detectCapabilityVector()

    expect(Object.isFrozen(vector)).toBe(true)
    expect(vector.coi).toBe(false)
    expect(vector.pthread).toBe(false)
    expect(vector.hwConcurrency).toBeGreaterThanOrEqual(1)
    expect(vector.deviceMemoryGB).toBeNull()
    expect(vector.webKitClass).toBe('unknown')
    expect(vector.maybeOpfsSupported).toBe(false)
  })

  it.each([
    [
      'chromium',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
      0,
      'chromium',
      'desktop',
    ],
    [
      'headless-chromium',
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/147.0.7727.15 Safari/537.36',
      0,
      'chromium',
      'desktop',
    ],
    [
      'android-chromium',
      'Mozilla/5.0 (Linux; Android 15; Pixel 9 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Mobile Safari/537.36',
      5,
      'chromium',
      'mobile',
    ],
    [
      'android-firefox',
      'Mozilla/5.0 (Android 15; Mobile; rv:136.0) Gecko/136.0 Firefox/136.0',
      5,
      'unknown',
      'mobile',
    ],
    [
      'touch-windows-chromium',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
      10,
      'chromium',
      'desktop',
    ],
    [
      'webkit-mobile',
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1',
      5,
      'webkit-mobile',
      'mobile',
    ],
    [
      'webkit-mobile (iPadOS desktop-mode UA + touch)',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
      5,
      'webkit-mobile',
      'mobile',
    ],
    [
      'webkit-desktop-safari',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.4 Safari/605.1.15',
      0,
      'webkit-desktop-safari',
      'desktop',
    ],
    ['unknown', 'LumaForgeTest/1.0', 0, 'unknown', 'unknown'],
  ] as const)(
    'classifies %s user agents',
    async (
      _label,
      userAgent,
      maxTouchPoints,
      expectedWebKitClass,
      expectedDeviceFormFactor,
    ) => {
      vi.stubGlobal('navigator', {
        userAgent,
        maxTouchPoints,
        hardwareConcurrency: 8,
        deviceMemory: 16,
        storage: {
          getDirectory: vi.fn(),
          estimate: vi.fn(),
        },
      } as never)
      vi.stubGlobal('crossOriginIsolated', true)

      const vector = await detectCapabilityVector()

      expect(vector.webKitClass).toBe(expectedWebKitClass)
      expect(vector.deviceFormFactor).toBe(expectedDeviceFormFactor)
      expect(vector.maybeOpfsSupported).toBe(true)
    },
  )

  it('never reports pthread without cross-origin isolation', async () => {
    vi.stubGlobal('navigator', {
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X) AppleWebKit/537.36 Chrome/126 Safari/537.36',
      hardwareConcurrency: 8,
    } as never)
    vi.stubGlobal('crossOriginIsolated', false)
    vi.stubGlobal('SharedArrayBuffer', class SharedArrayBuffer {})

    const vector = await detectCapabilityVector()

    expect(vector.coi).toBe(false)
    expect(vector.pthread).toBe(false)
  })

  it.each([0, -8, Number.NaN, Number.POSITIVE_INFINITY, 'many'] as const)(
    'normalizes hostile hardwareConcurrency %s to at least one',
    async (hardwareConcurrency) => {
      vi.stubGlobal('navigator', {
        userAgent: '',
        hardwareConcurrency,
      } as never)
      vi.stubGlobal('crossOriginIsolated', false)

      const vector = await detectCapabilityVector()

      expect(vector.hwConcurrency).toBeGreaterThanOrEqual(1)
    },
  )

  it.each([
    [7.9, 7],
    [128, 64],
    [1, 1],
  ] as const)(
    'floors and caps hardwareConcurrency %s to %s',
    async (hardwareConcurrency, expected) => {
      vi.stubGlobal('navigator', {
        userAgent: '',
        hardwareConcurrency,
      } as never)
      vi.stubGlobal('crossOriginIsolated', false)

      const vector = await detectCapabilityVector()

      expect(vector.hwConcurrency).toBe(expected)
    },
  )

  it.each([
    [8, 8],
    [0.5, 0.5],
    [0, null],
    [-4, null],
    [Number.NaN, null],
    [Number.POSITIVE_INFINITY, null],
  ] as const)(
    'reports deviceMemory %s as %s GB',
    async (deviceMemory, expected) => {
      vi.stubGlobal('navigator', { userAgent: '', deviceMemory } as never)
      vi.stubGlobal('crossOriginIsolated', false)

      const vector = await detectCapabilityVector()

      expect(vector.deviceMemoryGB).toBe(expected)
    },
  )

  it.each([
    ['both accessors', { getDirectory: vi.fn(), estimate: vi.fn() }, true],
    ['no estimate', { getDirectory: vi.fn() }, false],
    ['no directory accessor', { estimate: vi.fn() }, false],
  ] as const)(
    'reports maybe-OPFS support with %s',
    async (_label, storage, expected) => {
      vi.stubGlobal('navigator', { userAgent: '', storage } as never)
      vi.stubGlobal('crossOriginIsolated', false)

      const vector = await detectCapabilityVector()

      expect(vector.maybeOpfsSupported).toBe(expected)
    },
  )

  it('reports pthread under cross-origin isolation with SharedArrayBuffer', async () => {
    vi.stubGlobal('navigator', { userAgent: '' } as never)
    vi.stubGlobal('crossOriginIsolated', true)
    vi.stubGlobal('SharedArrayBuffer', class SharedArrayBuffer {})

    const vector = await detectCapabilityVector()

    expect(vector.coi).toBe(true)
    expect(vector.pthread).toBe(true)
  })

  it('caches the first detection for the module lifetime', () => {
    vi.stubGlobal('navigator', {
      userAgent: '',
      hardwareConcurrency: 4,
    } as never)
    vi.stubGlobal('crossOriginIsolated', false)
    expect(getCapabilityVectorSnapshot()).toBeNull()

    const first = detectCapabilityVector()
    vi.stubGlobal('navigator', {
      userAgent: '',
      hardwareConcurrency: 16,
    } as never)

    expect(detectCapabilityVector()).toBe(first)
    expect(getCapabilityVectorSnapshot()).toBe(first)
    expect(first.hwConcurrency).toBe(4)
  })
})
