import { describe, expect, it } from 'vitest'

import type { CapabilityVector } from './capability-input'
import { deriveInteractivePolicy } from './interactive-policy'

const baseCap: CapabilityVector = {
  coi: true,
  pthread: true,
  deviceMemoryGB: 16,
  hwConcurrency: 8,
  webKitClass: 'chromium',
  deviceFormFactor: 'desktop',
  maybeOpfsSupported: true,
}

describe('deriveInteractivePolicy', () => {
  it('grants 16MP HQ on chromium desktop', () => {
    const p = deriveInteractivePolicy(baseCap)

    expect(p.boundedHqMaxPixels).toBe(16_000_000)
    expect(p.previewWorkerMemoryProfile).toBe('desktop')
  })

  it('caps to 8MP on webkit-mobile', () => {
    const p = deriveInteractivePolicy({
      ...baseCap,
      webKitClass: 'webkit-mobile',
      deviceFormFactor: 'mobile',
      pthread: false,
    })

    expect(p.boundedHqMaxPixels).toBe(8_000_000)
    expect(p.previewWorkerMemoryProfile).toBe('low-memory')
  })

  it('grants 12MP bounded HQ to strong WebKit mobile without using desktop memory', () => {
    const p = deriveInteractivePolicy({
      ...baseCap,
      deviceMemoryGB: null,
      hwConcurrency: 8,
      webKitClass: 'webkit-mobile',
      deviceFormFactor: 'mobile',
    })

    expect(p.boundedHqMaxPixels).toBe(12_000_000)
    expect(p.previewWorkerMemoryProfile).toBe('low-memory')
  })

  it('caps by deviceMemory when known', () => {
    const p = deriveInteractivePolicy({ ...baseCap, deviceMemoryGB: 2 })

    expect(p.boundedHqMaxPixels).toBe(8_000_000)
  })

  it('forces low-memory when !pthread', () => {
    const p = deriveInteractivePolicy({ ...baseCap, pthread: false })

    expect(p.boundedHqMaxPixels).toBe(8_000_000)
    expect(p.previewWorkerMemoryProfile).toBe('low-memory')
  })

  it('uses the GPU preview budget without promoting the worker memory profile', () => {
    const p = deriveInteractivePolicy(
      { ...baseCap, pthread: false },
      { boundedHqMaxPixels: 12_000_000 },
    )

    expect(p.boundedHqMaxPixels).toBe(12_000_000)
    expect(p.previewWorkerMemoryProfile).toBe('low-memory')
  })

  it('gates desktop memory profile to chromium only', () => {
    const p = deriveInteractivePolicy({
      ...baseCap,
      webKitClass: 'webkit-desktop-safari',
    })

    expect(p.previewWorkerMemoryProfile).toBe('low-memory')
  })

  it('keeps strong Chromium phones on the low-memory worker', () => {
    const p = deriveInteractivePolicy({
      ...baseCap,
      deviceMemoryGB: 8,
      webKitClass: 'chromium',
      deviceFormFactor: 'mobile',
    })

    expect(p.boundedHqMaxPixels).toBe(12_000_000)
    expect(p.previewWorkerMemoryProfile).toBe('low-memory')
  })
})
