import { afterEach, vi } from 'vitest'

import type { ExportDebugEvent } from './execution-profile'
import {
  emitExportDebugEvent,
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

  it('emits typed export debug events with machine-checkable payloads', () => {
    const sent: ExportDebugEvent[] = [
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
    ]
    const events: unknown[] = []
    const listener = (event: Event) => {
      events.push((event as CustomEvent).detail)
    }

    window.addEventListener('lumaforge-export-debug', listener)
    try {
      for (const event of sent) emitExportDebugEvent(structuredClone(event))
    } finally {
      window.removeEventListener('lumaforge-export-debug', listener)
    }

    expect(events).toEqual(sent)
  })

  it('reports the selected plan live and keeps it for post-reload Safari diagnostics', () => {
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
      },
    })
    const events: unknown[] = []
    const listener = (event: Event) => {
      events.push((event as CustomEvent).detail)
    }

    window.addEventListener('lumaforge-export-debug', listener)
    try {
      emitExportDebugEvent({
        type: 'export-plan-selected',
        payload: toExportPlanSelectedDebugPayload(plan),
      })
    } finally {
      window.removeEventListener('lumaforge-export-debug', listener)
    }

    const payload = expect.objectContaining({
      profile: 'ios-safe',
      outputSink: 'opfs-file',
      derivedLabel: plan.derivedLabel,
      policyVector: plan.policyVector,
    })
    expect(events).toEqual([{ type: 'export-plan-selected', payload }])
    expect(
      JSON.parse(localStorage.getItem(exportDebugEventStorageKey) ?? '[]'),
    ).toEqual([
      expect.objectContaining({
        recordedAt: expect.any(String),
        event: expect.objectContaining({
          type: 'export-plan-selected',
          payload,
        }),
      }),
    ])
  })

  it('does not reread persisted diagnostics for every event', () => {
    clearExportDebugDiagnostics()
    const getItem = vi.spyOn(Storage.prototype, 'getItem')

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      emitExportDebugEvent({
        type: 'export-worker-attempt',
        payload: {
          attempt,
          phase: 'started',
          freshWorker: true,
        },
      })
    }

    expect(getItem).toHaveBeenCalledTimes(1)
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
