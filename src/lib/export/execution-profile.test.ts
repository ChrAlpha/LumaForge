import { afterEach, vi } from 'vitest'

import {
  emitExportDebugEvent,
  getExportModeCopy,
  toExportPlanSelectedDebugPayload,
} from './execution-profile'
import { selectExportPlan } from './export-plan'

const exportDebugEventStorageKey = 'lumaforge.exportDebugEvents.v1'

function clearExportDebugDiagnostics() {
  localStorage.clear()
  delete (
    window as unknown as {
      __LUMAFORGE_EXPORT_DEBUG_HISTORY__?: unknown
    }
  ).__LUMAFORGE_EXPORT_DEBUG_HISTORY__
}

describe('export execution profile selection', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('uses crash-retry policy after interrupted checkpoint regardless of platform', () => {
    const plan = selectExportPlan({
      preference: 'max',
      source: { width: 11662, height: 8746 },
      history: { previousCrashLikeInterruption: true },
      capability: {
        coi: true,
        pthread: true,
        deviceMemoryGB: null,
        hwConcurrency: 1,
        webKitClass: 'unknown',
        deviceFormFactor: 'unknown',
        maybeOpfsSupported: true,
      },
      runtime: {
        opfsSinkAvailable: true,
        opfsAvailableMB: Number.POSITIVE_INFINITY,
        streamingSinkAvailable: true,
      },
    })

    expect(plan.preferredRows).toBe(64)
    expect(plan.concurrency).toBe(1)
    expect(plan.runtimeMemoryProfile).toBe('low-memory')
    expect(plan.checkpointMode).toBe('safe-retry')
    expect(plan.outputSink).toBe('opfs-file')
    expect(plan.productCopy).toBe('interrupted-retry')
  })

  it('uses low-memory OPFS policy for webkit-mobile environments', () => {
    const plan = selectExportPlan({
      preference: 'balanced',
      source: { width: 11662, height: 8746 },
      capability: {
        coi: true,
        pthread: true,
        deviceMemoryGB: null,
        hwConcurrency: 1,
        webKitClass: 'webkit-mobile',
        deviceFormFactor: 'mobile',
        maybeOpfsSupported: true,
      },
      runtime: {
        opfsSinkAvailable: true,
        opfsAvailableMB: Number.POSITIVE_INFINITY,
        streamingSinkAvailable: false,
      },
    })

    expect(plan.maxConcurrency).toBe(1)
    expect(plan.preferredRows).toBe(128)
    expect(plan.concurrency).toBe(1)
    expect(plan.runtimeMemoryProfile).toBe('low-memory')
    expect(plan.outputSink).toBe('opfs-file')
    expect(plan.derivedLabel).toContain('wkwebkit-mobile')
    expect(plan.policyVector).toMatchObject({
      workerMemoryProfile: 'low-memory',
      rowSlice: 128,
      concurrency: 1,
      outputSink: 'opfs-file',
    })
  })

  it('marks webkit-mobile large blob handoff exports as unable to complete safely', () => {
    const plan = selectExportPlan({
      preference: 'balanced',
      source: { width: 9566, height: 6374 },
      capability: {
        coi: false,
        pthread: false,
        deviceMemoryGB: null,
        hwConcurrency: 1,
        webKitClass: 'webkit-mobile',
        deviceFormFactor: 'mobile',
        maybeOpfsSupported: false,
      },
      runtime: {
        opfsSinkAvailable: false,
        opfsAvailableMB: null,
        streamingSinkAvailable: false,
      },
    })

    expect(plan.outputSink).toBe('blob-handoff')
    expect(plan.runtimeMemoryProfile).toBe('low-memory')
    expect(plan.derivedLabel).toContain('wkwebkit-mobile')
    expect(plan.productCopy).toBe('cannot-safely-complete')
    expect(getExportModeCopy(plan.productCopy)).toMatch(
      /cannot safely complete this large local full-resolution export/i,
    )
  })

  it('keeps smaller webkit-mobile blob handoff exports allowed', () => {
    const plan = selectExportPlan({
      preference: 'balanced',
      source: { width: 6048, height: 4024 },
      capability: {
        coi: false,
        pthread: false,
        deviceMemoryGB: null,
        hwConcurrency: 1,
        webKitClass: 'webkit-mobile',
        deviceFormFactor: 'mobile',
        maybeOpfsSupported: false,
      },
      runtime: {
        opfsSinkAvailable: false,
        opfsAvailableMB: null,
        streamingSinkAvailable: false,
      },
    })

    expect(plan.outputSink).toBe('blob-handoff')
    expect(plan.runtimeMemoryProfile).toBe('low-memory')
    expect(plan.derivedLabel).toContain('wkwebkit-mobile')
    expect(plan.productCopy).toBe('safe-export')
  })

  it('uses low-memory policy for desktop Safari WebKit workers', () => {
    const plan = selectExportPlan({
      preference: 'balanced',
      source: { width: 5520, height: 8288 },
      capability: {
        coi: true,
        pthread: true,
        deviceMemoryGB: null,
        hwConcurrency: 8,
        webKitClass: 'webkit-desktop-safari',
        deviceFormFactor: 'desktop',
        maybeOpfsSupported: false,
      },
      runtime: {
        opfsSinkAvailable: false,
        opfsAvailableMB: null,
        streamingSinkAvailable: false,
      },
    })

    expect(plan.preferredRows).toBe(256)
    expect(plan.concurrency).toBe(1)
    expect(plan.runtimeMemoryProfile).toBe('low-memory')
    expect(plan.derivedLabel).toContain('wkwebkit-desktop-safari')
  })

  it.each([
    ['balanced', 2],
    ['max', 3],
  ] as Array<['balanced' | 'max', number]>)(
    'derives non-WebKit chromium %s throughput policy',
    (performancePreference, expectedConcurrency) => {
      const plan = selectExportPlan({
        preference: performancePreference,
        source: { width: 10000, height: 9000 },
        capability: {
          coi: true,
          pthread: true,
          deviceMemoryGB: null,
          hwConcurrency: 8,
          webKitClass: 'chromium',
          deviceFormFactor: 'desktop',
          maybeOpfsSupported: false,
        },
        runtime: {
          opfsSinkAvailable: false,
          opfsAvailableMB: null,
          streamingSinkAvailable: true,
        },
      })

      expect(plan.preferredRows).toBe(512)
      expect(plan.concurrency).toBe(expectedConcurrency)
      expect(plan.runtimeMemoryProfile).toBe('desktop')
      expect(plan.outputSink).toBe('streaming')
      expect(plan.derivedLabel).toContain('wkchromium')
      expect(plan.policyVector).toMatchObject({
        workerMemoryProfile: 'desktop',
        rowSlice: 512,
        concurrency: expectedConcurrency,
        outputSink: 'streaming',
      })
    },
  )

  it('accepts a preference, the three history flags, capability, and runtime resources', () => {
    const plan = selectExportPlan({
      preference: 'balanced',
      history: {
        previousResourceFailure: false,
        previousCrashLikeInterruption: false,
        previousUserInterrupted: false,
      },
      source: { width: 6000, height: 4000 },
      capability: {
        coi: true,
        pthread: true,
        deviceMemoryGB: 16,
        hwConcurrency: 8,
        webKitClass: 'chromium',
        deviceFormFactor: 'desktop',
        maybeOpfsSupported: true,
      },
      runtime: {
        opfsSinkAvailable: true,
        opfsAvailableMB: 4_000,
        streamingSinkAvailable: true,
      },
    })

    expect(plan.profile).not.toHaveProperty('checkpointOutput')
    expect(plan.runtimeMemoryProfile).toBe('desktop')
    expect(plan.derivedLabel).toMatch(/chromium/)
  })

  it('maps product copy without saying resume for safe retry', () => {
    expect(getExportModeCopy('interrupted-source-needed')).toBe(
      'The browser interrupted the previous export. Please reselect the same RAW file so LumaForge can retry with a safer setting.',
    )
    expect(getExportModeCopy('interrupted-source-needed')).not.toMatch(
      /resume/i,
    )
  })

  it('allows high-performance copy to be localized without coupling policy code to i18n', () => {
    expect(
      getExportModeCopy('high-performance', (key) => `translated:${key}`),
    ).toBe('translated:raw.export.highPerformance')
  })

  it('emits typed export debug events with machine-checkable payloads', () => {
    const events: unknown[] = []
    const listener = (event: Event) => {
      events.push((event as CustomEvent).detail)
    }

    window.addEventListener('lumaforge-export-debug', listener)
    try {
      emitExportDebugEvent({
        type: 'resource-evacuated',
        payload: {
          profile: 'ios-safe',
          requiredOwners: ['preview', 'bounded-hq', 'gpu', 'export-result'],
          disposedOwners: ['preview', 'bounded-hq', 'gpu', 'export-result'],
          registryCheck: { ok: true },
          remainingLive: [],
          estimatedBytesByOwner: { preview: 1024, gpu: 2048 },
          totalEstimatedBytes: 3072,
          evacuatedAt: '2026-05-03T00:00:00.000Z',
        },
      })
      emitExportDebugEvent({
        type: 'export-worker-attempt',
        payload: {
          attempt: 2,
          profile: 'ios-safe',
          preferredRows: 64,
          concurrency: 1,
          phase: 'retry-scheduled',
          retryReason: 'FULL_RES_EXPORT_RESOURCE_FAILURE',
          previousRows: 128,
          nextRows: 64,
          previousConcurrency: 1,
          nextConcurrency: 1,
          freshWorker: true,
          priorClientDisposed: true,
        },
      })
      emitExportDebugEvent({
        type: 'output-materialized',
        payload: {
          action: 'download',
          outputKind: 'file-backed',
          filename: 'frame_fullres.jpg',
          byteLength: 42,
          materializedAt: '2026-05-03T00:00:01.000Z',
          cleanup: 'scheduled',
        },
      })
    } finally {
      window.removeEventListener('lumaforge-export-debug', listener)
    }

    expect(events).toEqual([
      {
        type: 'resource-evacuated',
        payload: {
          profile: 'ios-safe',
          requiredOwners: ['preview', 'bounded-hq', 'gpu', 'export-result'],
          disposedOwners: ['preview', 'bounded-hq', 'gpu', 'export-result'],
          registryCheck: { ok: true },
          remainingLive: [],
          estimatedBytesByOwner: { preview: 1024, gpu: 2048 },
          totalEstimatedBytes: 3072,
          evacuatedAt: '2026-05-03T00:00:00.000Z',
        },
      },
      {
        type: 'export-worker-attempt',
        payload: {
          attempt: 2,
          profile: 'ios-safe',
          preferredRows: 64,
          concurrency: 1,
          phase: 'retry-scheduled',
          retryReason: 'FULL_RES_EXPORT_RESOURCE_FAILURE',
          previousRows: 128,
          nextRows: 64,
          previousConcurrency: 1,
          nextConcurrency: 1,
          freshWorker: true,
          priorClientDisposed: true,
        },
      },
      {
        type: 'output-materialized',
        payload: {
          action: 'download',
          outputKind: 'file-backed',
          filename: 'frame_fullres.jpg',
          byteLength: 42,
          materializedAt: '2026-05-03T00:00:01.000Z',
          cleanup: 'scheduled',
        },
      },
    ])
  })

  it('persists recent export debug events for post-reload Safari diagnostics', () => {
    clearExportDebugDiagnostics()
    const plan = selectExportPlan({
      preference: 'balanced',
      source: { width: 6000, height: 4000 },
      capability: {
        coi: false,
        pthread: false,
        deviceMemoryGB: null,
        hwConcurrency: 1,
        webKitClass: 'webkit-mobile',
        deviceFormFactor: 'mobile',
        maybeOpfsSupported: true,
      },
      runtime: {
        opfsSinkAvailable: true,
        opfsAvailableMB: 4_000,
        streamingSinkAvailable: false,
      },
    })

    emitExportDebugEvent({
      type: 'export-plan-selected',
      payload: toExportPlanSelectedDebugPayload(plan),
    })

    const stored = JSON.parse(
      localStorage.getItem(exportDebugEventStorageKey) ?? '[]',
    )

    expect(stored).toEqual([
      expect.objectContaining({
        recordedAt: expect.any(String),
        event: expect.objectContaining({
          type: 'export-plan-selected',
          payload: expect.objectContaining({
            profile: 'ios-safe',
            outputSink: 'opfs-file',
          }),
        }),
      }),
    ])
  })

  it('emits derivedLabel and policyVector alongside legacy profile in debug events', () => {
    const events: unknown[] = []
    const handler = (event: Event) => events.push((event as CustomEvent).detail)
    window.addEventListener('lumaforge-export-debug', handler)

    try {
      const plan = selectExportPlan({
        preference: 'balanced',
        history: {
          previousResourceFailure: false,
          previousCrashLikeInterruption: false,
          previousUserInterrupted: false,
        },
        source: { width: 6000, height: 4000 },
        capability: {
          coi: true,
          pthread: true,
          deviceMemoryGB: 16,
          hwConcurrency: 8,
          webKitClass: 'chromium',
          deviceFormFactor: 'desktop',
          maybeOpfsSupported: true,
        },
        runtime: {
          opfsSinkAvailable: true,
          opfsAvailableMB: 4_000,
          streamingSinkAvailable: true,
        },
      })

      emitExportDebugEvent({
        type: 'export-plan-selected',
        payload: toExportPlanSelectedDebugPayload(plan),
      })

      const selected = events.find(
        (event): event is { type: string; payload: Record<string, unknown> } =>
          typeof event === 'object' &&
          event !== null &&
          'type' in event &&
          event.type === 'export-plan-selected',
      )
      expect(selected?.payload.derivedLabel).toBeTruthy()
      expect(selected?.payload.policyVector).toBeDefined()
      expect(selected?.payload.profile).toBeDefined()
    } finally {
      window.removeEventListener('lumaforge-export-debug', handler)
    }
  })

  it('does not reread persisted diagnostics for every checkpoint event', () => {
    clearExportDebugDiagnostics()
    const getItem = vi.spyOn(Storage.prototype, 'getItem')

    for (
      let completedRowsForDiagnostics = 0;
      completedRowsForDiagnostics < 3;
      completedRowsForDiagnostics += 1
    ) {
      emitExportDebugEvent({
        type: 'checkpoint-written',
        payload: {
          exportId: 'export-1',
          completedRowsForDiagnostics,
          totalRows: 6374,
          updatedAt: `2026-05-20T08:30:0${completedRowsForDiagnostics}.000Z`,
        },
      })
    }

    expect(getItem).toHaveBeenCalledTimes(1)
  })

  it('throttles persisted checkpoint writes while keeping live checkpoint history', () => {
    clearExportDebugDiagnostics()
    const setItem = vi.spyOn(Storage.prototype, 'setItem')

    for (const completedRowsForDiagnostics of [0, 128, 256, 1024, 2048, 6374]) {
      emitExportDebugEvent({
        type: 'checkpoint-written',
        payload: {
          exportId: 'export-1',
          completedRowsForDiagnostics,
          totalRows: 6374,
          updatedAt: `2026-05-20T08:30:${completedRowsForDiagnostics}.000Z`,
        },
      })
    }

    const liveHistory = (
      window as unknown as {
        __LUMAFORGE_EXPORT_DEBUG_HISTORY__?: unknown[]
      }
    ).__LUMAFORGE_EXPORT_DEBUG_HISTORY__
    const stored = JSON.parse(
      localStorage.getItem(exportDebugEventStorageKey) ?? '[]',
    )

    expect(setItem).toHaveBeenCalledTimes(4)
    expect(liveHistory).toHaveLength(6)
    expect(stored).toHaveLength(6)
    expect(stored.at(-1)).toMatchObject({
      event: {
        type: 'checkpoint-written',
        payload: {
          completedRowsForDiagnostics: 6374,
          totalRows: 6374,
        },
      },
    })
  })

  it('keeps export progress diagnostics live-only to avoid completion-path storage writes', () => {
    clearExportDebugDiagnostics()
    const events: unknown[] = []
    const setItem = vi.spyOn(Storage.prototype, 'setItem')
    const listener = (event: Event) => {
      events.push((event as CustomEvent).detail)
    }

    window.addEventListener('lumaforge-export-debug', listener)
    try {
      emitExportDebugEvent({
        type: 'export-progress',
        payload: {
          completedStrips: 50,
          totalStrips: 50,
          progress: 99,
          recordedAt: '2026-05-20T10:03:49.472Z',
        },
      })
    } finally {
      window.removeEventListener('lumaforge-export-debug', listener)
    }

    expect(events).toEqual([
      {
        type: 'export-progress',
        payload: {
          completedStrips: 50,
          totalStrips: 50,
          progress: 99,
          recordedAt: '2026-05-20T10:03:49.472Z',
        },
      },
    ])
    expect(setItem).not.toHaveBeenCalled()
    expect(localStorage.getItem(exportDebugEventStorageKey)).toBeNull()
  })
})
