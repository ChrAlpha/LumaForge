import { describe, expect, it } from 'vitest'

import type { CapabilityVector } from './capability-input'
import { deriveExportPolicy } from './export-policy'
import type { ExportRuntimeResources } from './export-runtime-resources'

const baseCap: CapabilityVector = {
  coi: true,
  pthread: true,
  deviceMemoryGB: 16,
  hwConcurrency: 8,
  webKitClass: 'chromium',
  deviceFormFactor: 'desktop',
  maybeOpfsSupported: true,
}
const opfsRuntime: ExportRuntimeResources = Object.freeze({
  opfsSinkAvailable: true,
  opfsAvailableMB: 4_000,
})

describe('deriveExportPolicy', () => {
  it('produces high-performance on chromium desktop / balanced preference', () => {
    const p = deriveExportPolicy(
      baseCap,
      { width: 6000, height: 4000 },
      {
        performancePreference: 'balanced',
        previousResourceFailure: false,
        previousCrashLikeInterruption: false,
      },
      opfsRuntime,
    )

    expect(p.rowSlice).toBe(512)
    expect(p.concurrency).toBe(2)
    expect(p.workerMemoryProfile).toBe('desktop')
    expect(p.outputSink).toBe('opfs-file')
    expect(p.productCopy).toBe('high-performance')
    expect(p.derivedLabel).toBe(
      'desktop-thr2-rs512-opfs-file-wkchromium-ffdesktop',
    )
  })

  it('caps webkit-mobile to rowSlice 128 / conc 1 / low-memory', () => {
    const p = deriveExportPolicy(
      { ...baseCap, webKitClass: 'webkit-mobile', deviceFormFactor: 'mobile' },
      { width: 6000, height: 4000 },
      {
        performancePreference: 'max',
        previousResourceFailure: false,
        previousCrashLikeInterruption: false,
      },
      opfsRuntime,
    )

    expect(p.rowSlice).toBeLessThanOrEqual(128)
    expect(p.concurrency).toBe(1)
    expect(p.workerMemoryProfile).toBe('low-memory')
  })

  it('keeps strong WebKit mobile export on the safe single-worker budget', () => {
    const p = deriveExportPolicy(
      {
        ...baseCap,
        deviceMemoryGB: null,
        hwConcurrency: 8,
        webKitClass: 'webkit-mobile',
        deviceFormFactor: 'mobile',
      },
      { width: 6000, height: 4000 },
      {
        performancePreference: 'max',
        previousResourceFailure: false,
        previousCrashLikeInterruption: false,
      },
      opfsRuntime,
    )

    expect(p.rowSlice).toBe(128)
    expect(p.concurrency).toBe(1)
    expect(p.workerMemoryProfile).toBe('low-memory')
  })

  it('previousResourceFailure halves rowSlice and floors concurrency', () => {
    const p = deriveExportPolicy(
      baseCap,
      { width: 6000, height: 4000 },
      {
        performancePreference: 'max',
        previousResourceFailure: true,
        previousCrashLikeInterruption: false,
      },
      opfsRuntime,
    )

    expect(p.rowSlice).toBe(256)
    expect(p.concurrency).toBe(1)
    expect(p.productCopy).toBe('resource-retry')
  })

  it('previousCrashLikeInterruption quarters rowSlice', () => {
    const p = deriveExportPolicy(
      baseCap,
      { width: 6000, height: 4000 },
      {
        performancePreference: 'max',
        previousResourceFailure: false,
        previousCrashLikeInterruption: true,
      },
      opfsRuntime,
    )

    expect(p.rowSlice).toBe(128)
    expect(p.concurrency).toBe(1)
    expect(p.productCopy).toBe('interrupted-retry')
  })

  it('falls through to blob handoff when OPFS cannot fit', () => {
    const p = deriveExportPolicy(
      baseCap,
      { width: 20_000, height: 15_000 },
      {
        performancePreference: 'balanced',
        previousResourceFailure: false,
        previousCrashLikeInterruption: false,
      },
      Object.freeze({
        opfsSinkAvailable: true,
        opfsAvailableMB: 100,
      }),
    )

    expect(p.outputSink).toBe('blob-handoff')
  })

  it('keeps known-low-memory desktop export single-worker', () => {
    const p = deriveExportPolicy(
      {
        ...baseCap,
        deviceMemoryGB: 4,
      },
      { width: 6000, height: 4000 },
      {
        performancePreference: 'max',
        previousResourceFailure: false,
        previousCrashLikeInterruption: false,
      },
      opfsRuntime,
    )

    expect(p.rowSlice).toBe(128)
    expect(p.maxConcurrency).toBe(1)
    expect(p.concurrency).toBe(1)
    expect(p.workerMemoryProfile).toBe('low-memory')
    expect(p.productCopy).toBe('safe-export')
  })

  it('cannot-safely-complete on webkit-mobile + 60MP + blob-handoff', () => {
    const p = deriveExportPolicy(
      { ...baseCap, webKitClass: 'webkit-mobile', deviceFormFactor: 'mobile' },
      { width: 9000, height: 6700 },
      {
        performancePreference: 'safe',
        previousResourceFailure: false,
        previousCrashLikeInterruption: false,
      },
      Object.freeze({
        opfsSinkAvailable: false,
        opfsAvailableMB: null,
      }),
    )

    expect(p.outputSink).toBe('blob-handoff')
    expect(p.productCopy).toBe('cannot-safely-complete')
  })

  it('cannot-safely-complete on mobile Chromium + 60MP + blob-handoff', () => {
    const p = deriveExportPolicy(
      {
        ...baseCap,
        deviceMemoryGB: 8,
        webKitClass: 'chromium',
        deviceFormFactor: 'mobile',
      },
      { width: 9000, height: 6700 },
      {
        performancePreference: 'safe',
        previousResourceFailure: false,
        previousCrashLikeInterruption: false,
      },
      Object.freeze({
        opfsSinkAvailable: false,
        opfsAvailableMB: null,
      }),
    )

    expect(p.rowSlice).toBe(256)
    expect(p.concurrency).toBe(1)
    expect(p.workerMemoryProfile).toBe('low-memory')
    expect(p.outputSink).toBe('blob-handoff')
    expect(p.productCopy).toBe('cannot-safely-complete')
  })

  it('cannot-safely-complete on unknown mobile engine + 60MP + blob-handoff', () => {
    const p = deriveExportPolicy(
      {
        ...baseCap,
        deviceMemoryGB: null,
        webKitClass: 'unknown',
        deviceFormFactor: 'mobile',
      },
      { width: 9000, height: 6700 },
      {
        performancePreference: 'max',
        previousResourceFailure: false,
        previousCrashLikeInterruption: false,
      },
      Object.freeze({
        opfsSinkAvailable: false,
        opfsAvailableMB: null,
      }),
    )

    expect(p.rowSlice).toBe(128)
    expect(p.concurrency).toBe(1)
    expect(p.workerMemoryProfile).toBe('low-memory')
    expect(p.outputSink).toBe('blob-handoff')
    expect(p.productCopy).toBe('cannot-safely-complete')
  })
})
