import type {
  CapabilityVector,
  ExportRuntimeResources,
  PerformancePreference,
} from '@lumaforge/render-engine/policy'
import { describe, expect, it } from 'vitest'

import { selectExportPlan } from './export-plan'

const CAPABILITIES = {
  desktop: {
    coi: true,
    pthread: true,
    deviceMemoryGB: 16,
    hwConcurrency: 8,
    webKitClass: 'chromium',
    deviceFormFactor: 'desktop',
    maybeOpfsSupported: true,
  },
  ios: {
    coi: false,
    pthread: false,
    deviceMemoryGB: null,
    hwConcurrency: 4,
    webKitClass: 'webkit-mobile',
    deviceFormFactor: 'mobile',
    maybeOpfsSupported: true,
  },
  android: {
    coi: true,
    pthread: true,
    deviceMemoryGB: 4,
    hwConcurrency: 8,
    webKitClass: 'chromium',
    deviceFormFactor: 'mobile',
    maybeOpfsSupported: true,
  },
} satisfies Record<string, CapabilityVector>

const RUNTIMES = {
  opfs: {
    opfsSinkAvailable: true,
    opfsAvailableMB: 10_000,
  },
  /** Reachable, but too small for the output it would have to hold. */
  opfsSmall: {
    opfsSinkAvailable: true,
    opfsAvailableMB: 100,
  },
  blob: {
    opfsSinkAvailable: false,
    opfsAvailableMB: null,
  },
} satisfies Record<string, ExportRuntimeResources>

const SOURCES = {
  mp24: { width: 6000, height: 4000 },
  mp60: { width: 9000, height: 6700 },
  mp102: { width: 11662, height: 8746 },
}

const HISTORIES = {
  none: {},
  crash: { previousCrashLikeInterruption: true },
  resource: { previousResourceFailure: true },
}

type PolicyRow = [
  capability: keyof typeof CAPABILITIES,
  runtime: keyof typeof RUNTIMES,
  source: keyof typeof SOURCES,
  preference: PerformancePreference,
  history: keyof typeof HISTORIES,
  profile: string,
  rows: number,
  concurrency: number,
  memory: string,
  sink: string,
  copy: string,
]

/**
 * Each profile the plan mapping picks, with a sink fallback, a retry
 * history and a refusal. The engine's policy tests own the full matrix.
 */
// prettier-ignore
const POLICY_TABLE: PolicyRow[] = [
  ['desktop', 'opfs', 'mp24', 'balanced', 'none', 'desktop-fast', 512, 2, 'desktop', 'opfs-file', 'high-performance'],
  ['desktop', 'opfs', 'mp102', 'balanced', 'none', 'mobile-balanced', 256, 2, 'desktop', 'opfs-file', 'safe-export'],
  ['desktop', 'opfs', 'mp24', 'safe', 'resource', 'mobile-balanced', 256, 1, 'desktop', 'opfs-file', 'resource-retry'],
  ['desktop', 'opfsSmall', 'mp24', 'max', 'none', 'desktop-fast', 512, 3, 'desktop', 'blob-handoff', 'high-performance'],
  ['ios', 'opfs', 'mp60', 'balanced', 'crash', 'ios-safe', 64, 1, 'low-memory', 'opfs-file', 'interrupted-retry'],
  ['android', 'blob', 'mp102', 'balanced', 'none', 'mobile-balanced', 128, 1, 'low-memory', 'blob-handoff', 'cannot-safely-complete'],
]

describe('selectExportPlan policy table', () => {
  it.each(POLICY_TABLE)(
    '%s / %s / %s / %s / %s',
    (
      capability,
      runtime,
      source,
      preference,
      history,
      profile,
      rows,
      concurrency,
      memory,
      sink,
      copy,
    ) => {
      const plan = selectExportPlan({
        preference,
        source: SOURCES[source],
        history: HISTORIES[history],
        capability: CAPABILITIES[capability],
        runtime: RUNTIMES[runtime],
      })

      expect({
        profile: plan.profileName,
        rows: plan.preferredRows,
        concurrency: plan.concurrency,
        memory: plan.runtimeMemoryProfile,
        sink: plan.outputSink,
        copy: plan.productCopy,
      }).toEqual({ profile, rows, concurrency, memory, sink, copy })
    },
  )
})

describe('selectExportPlan request', () => {
  it('records the request with absent history flags as false so a retry can re-derive it', () => {
    const plan = selectExportPlan({
      preference: 'max',
      source: { width: 6000, height: 4000 },
      history: { previousResourceFailure: true },
      capability: CAPABILITIES.desktop,
      runtime: RUNTIMES.opfs,
    })

    expect(plan.request).toEqual({
      preference: 'max',
      source: { width: 6000, height: 4000 },
      history: {
        previousCrashLikeInterruption: false,
        previousResourceFailure: true,
      },
    })
    // The device facts are not kept on the plan: a retry samples its own.
    expect(plan).not.toHaveProperty('capabilitySnapshot')
    expect(plan).not.toHaveProperty('runtimeSnapshot')
  })

  it('treats a missing history as a first attempt', () => {
    const facts = {
      capability: CAPABILITIES.desktop,
      runtime: RUNTIMES.opfs,
    }
    const request = {
      preference: 'balanced',
      source: { width: 6000, height: 4000 },
    } as const

    expect(selectExportPlan({ ...request, ...facts })).toEqual(
      selectExportPlan({
        ...request,
        history: {
          previousCrashLikeInterruption: false,
          previousResourceFailure: false,
        },
        ...facts,
      }),
    )
  })
})
