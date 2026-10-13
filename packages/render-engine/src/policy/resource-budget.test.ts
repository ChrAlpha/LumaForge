import { describe, expect, it } from 'vitest'

import {
  BOUNDED_HQ_PREVIEW_LOW_MEMORY_MAX_PIXELS,
  BOUNDED_HQ_PREVIEW_MAX_PIXELS,
  QUICK_PREVIEW_MAX_PIXELS,
} from '../preview/preview-plan'
import type { CapabilityVector } from './capability-input'
import { deriveRuntimeResourceBudget } from './resource-budget'

const baseCap: CapabilityVector = {
  coi: true,
  pthread: true,
  deviceMemoryGB: 16,
  hwConcurrency: 8,
  webKitClass: 'chromium',
  deviceFormFactor: 'desktop',
  maybeOpfsSupported: true,
}

describe('deriveRuntimeResourceBudget', () => {
  it('keeps Chromium desktop on the performance budget', () => {
    expect(deriveRuntimeResourceBudget(baseCap)).toMatchObject({
      boundedHqMaxPixels: 16_000_000,
      workerMemoryProfile: 'desktop',
      exportRowSliceCeiling: 2048,
      exportConcurrencyCeiling: 3,
    })
  })

  it('gives strong WebKit mobile 12MP preview while keeping export single-worker', () => {
    expect(
      deriveRuntimeResourceBudget({
        ...baseCap,
        deviceMemoryGB: null,
        webKitClass: 'webkit-mobile',
        deviceFormFactor: 'mobile',
      }),
    ).toMatchObject({
      boundedHqMaxPixels: BOUNDED_HQ_PREVIEW_MAX_PIXELS,
      workerMemoryProfile: 'low-memory',
      exportRowSliceCeiling: 128,
      exportConcurrencyCeiling: 1,
    })
  })

  it('uses the low-memory budget when threads or known memory headroom are absent', () => {
    expect(
      deriveRuntimeResourceBudget({
        ...baseCap,
        pthread: false,
        deviceMemoryGB: 2,
        webKitClass: 'webkit-mobile',
        deviceFormFactor: 'mobile',
      }),
    ).toMatchObject({
      boundedHqMaxPixels: BOUNDED_HQ_PREVIEW_LOW_MEMORY_MAX_PIXELS,
      workerMemoryProfile: 'low-memory',
      exportRowSliceCeiling: 128,
      exportConcurrencyCeiling: 1,
    })
  })

  it('gives strong Chromium mobile a larger HQ preview without desktop workers', () => {
    expect(
      deriveRuntimeResourceBudget({
        ...baseCap,
        deviceMemoryGB: 8,
        webKitClass: 'chromium',
        deviceFormFactor: 'mobile',
      }),
    ).toMatchObject({
      boundedHqMaxPixels: BOUNDED_HQ_PREVIEW_MAX_PIXELS,
      workerMemoryProfile: 'low-memory',
      exportRowSliceCeiling: 256,
      exportConcurrencyCeiling: 1,
    })
  })

  it('keeps unknown mobile engines single-worker even when preview can be balanced', () => {
    expect(
      deriveRuntimeResourceBudget({
        ...baseCap,
        deviceMemoryGB: null,
        webKitClass: 'unknown',
        deviceFormFactor: 'mobile',
      }),
    ).toMatchObject({
      boundedHqMaxPixels: BOUNDED_HQ_PREVIEW_MAX_PIXELS,
      workerMemoryProfile: 'low-memory',
      exportRowSliceCeiling: 128,
      exportConcurrencyCeiling: 1,
    })
  })

  it('keeps known-low-memory desktops off the desktop worker budget', () => {
    expect(
      deriveRuntimeResourceBudget({
        ...baseCap,
        deviceMemoryGB: 4,
      }),
    ).toMatchObject({
      boundedHqMaxPixels: BOUNDED_HQ_PREVIEW_LOW_MEMORY_MAX_PIXELS,
      workerMemoryProfile: 'low-memory',
      exportRowSliceCeiling: 128,
      exportConcurrencyCeiling: 1,
    })
  })

  it('does not treat touch-capable desktop Chromium as mobile', () => {
    expect(
      deriveRuntimeResourceBudget({
        ...baseCap,
        deviceFormFactor: 'desktop',
      }),
    ).toMatchObject({
      workerMemoryProfile: 'desktop',
      exportRowSliceCeiling: 2048,
      exportConcurrencyCeiling: 3,
    })
  })

  it('does not cap bounded HQ below the quick preview floor', () => {
    expect(
      deriveRuntimeResourceBudget({
        ...baseCap,
        deviceMemoryGB: 0.25,
      }),
    ).toMatchObject({
      boundedHqMaxPixels: QUICK_PREVIEW_MAX_PIXELS,
    })
  })
})
