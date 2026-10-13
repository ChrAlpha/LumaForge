import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import type { CapabilityVector } from './capability-input'
import { deriveExportPolicy } from './export-policy'
import type { ExportRuntimeResources } from './export-runtime-resources'

const capArb: fc.Arbitrary<CapabilityVector> = fc
  .record({
    coi: fc.boolean(),
    pthread: fc.boolean(),
    deviceMemoryGB: fc.option(fc.integer({ min: 1, max: 64 }), { nil: null }),
    hwConcurrency: fc.integer({ min: 1, max: 64 }),
    webKitClass: fc.constantFrom(
      'chromium',
      'webkit-desktop-safari',
      'webkit-mobile',
      'unknown',
    ),
    deviceFormFactor: fc.constantFrom('desktop', 'mobile', 'unknown'),
    maybeOpfsSupported: fc.boolean(),
  })
  .map((v) => ({
    ...v,
    pthread: v.coi && v.pthread,
    deviceFormFactor:
      v.webKitClass === 'webkit-mobile' ? 'mobile' : v.deviceFormFactor,
  }))

const intentArb = fc.record({
  performancePreference: fc.constantFrom('safe', 'balanced', 'max'),
  previousResourceFailure: fc.boolean(),
  previousCrashLikeInterruption: fc.boolean(),
})

const imageArb = fc.record({
  width: fc.integer({ min: 100, max: 20_000 }),
  height: fc.integer({ min: 100, max: 20_000 }),
})

const runtimeArb: fc.Arbitrary<ExportRuntimeResources> = fc.record({
  opfsSinkAvailable: fc.boolean(),
  opfsAvailableMB: fc.option(fc.integer({ min: 0, max: 100_000 }), {
    nil: null,
  }),
})

describe('deriveExportPolicy invariants (property)', () => {
  it('always returns a sane policy', () => {
    fc.assert(
      fc.property(
        capArb,
        imageArb,
        intentArb,
        runtimeArb,
        (cap, image, intent, runtime) => {
          const p = deriveExportPolicy(cap, image, intent, runtime)

          expect(p.rowSlice).toBeGreaterThanOrEqual(64)
          expect(p.rowSlice).toBeLessThanOrEqual(2048)
          expect(p.concurrency).toBeGreaterThanOrEqual(1)
          expect(p.maxConcurrency).toBeGreaterThanOrEqual(1)
          expect(p.concurrency).toBeLessThanOrEqual(p.maxConcurrency)
          if (p.workerMemoryProfile === 'desktop') {
            expect(cap.coi).toBe(true)
            expect(cap.pthread).toBe(true)
            expect(cap.webKitClass).toBe('chromium')
            expect(cap.deviceFormFactor).toBe('desktop')
          }
        },
      ),
      { numRuns: 1_000 },
    )
  })

  it('resource failure weakly decreases rowSlice and concurrency', () => {
    fc.assert(
      fc.property(
        capArb,
        imageArb,
        intentArb,
        runtimeArb,
        (cap, image, intent, runtime) => {
          const clean = deriveExportPolicy(
            cap,
            image,
            {
              ...intent,
              previousResourceFailure: false,
              previousCrashLikeInterruption: false,
            },
            runtime,
          )
          const failed = deriveExportPolicy(
            cap,
            image,
            {
              ...intent,
              previousResourceFailure: true,
              previousCrashLikeInterruption: false,
            },
            runtime,
          )

          expect(failed.rowSlice).toBeLessThanOrEqual(clean.rowSlice)
          expect(failed.concurrency).toBeLessThanOrEqual(clean.concurrency)
        },
      ),
      { numRuns: 500 },
    )
  })
})
