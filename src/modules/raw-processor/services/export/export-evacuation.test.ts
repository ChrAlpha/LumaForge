import type { ColorGraphIntent } from '@lumaforge/luma-color-runtime'
import {
  NEUTRAL_SELECTIVE_COLOR,
  NEUTRAL_USER_COLOR_INTENT,
} from '@lumaforge/luma-color-runtime'
import { describe, expect, it, vi } from 'vitest'

import type { LargeResourceOwner } from '~/lib/export/resource-registry'
import { createResourceRegistry } from '~/lib/export/resource-registry'

import type {
  ExportEvacuationError,
  PreExportSnapshot,
} from './export-evacuation'
import {
  createPreExportSnapshot,
  evacuateBeforeExport,
  getPreExportEvacuationOwners,
  toResourceCleanupDebugPayload,
  toResourceEvacuatedDebugPayload,
} from './export-evacuation'

const expectedFullEvacuationOwners: LargeResourceOwner[] = [
  'preview',
  'bounded-hq',
  'gpu',
  'export-result',
  'lut-fetch',
]

function fullEvacuationOwners() {
  return getPreExportEvacuationOwners('desktop-fast')
}

const NEUTRAL_INTENT: ColorGraphIntent = {
  styleKind: 'custom',
  builtinPreset: null,
  intensity: 0.7,
  ...NEUTRAL_USER_COLOR_INTENT,
}

function snapshotInput(
  intent: ColorGraphIntent = NEUTRAL_INTENT,
): PreExportSnapshot {
  return {
    file: new File(['raw'], 'frame.RAF', { lastModified: 123 }),
    metadata: { make: 'Fujifilm', model: 'GFX100RF' },
    graph: {
      supported: true,
      outputGamut: 'srgb-rec709',
      outputTransfer: 'srgb',
      lutProfile: null,
      steps: [{ kind: 'input-linear-prophoto' }, { kind: 'output-srgb' }],
    },
    graphFingerprint: '[{"kind":"input-linear-prophoto"}]',
    lutTitle: 'V-Log',
    quickPreviewReady: true,
    intent,
    style: { kind: 'custom', name: 'V-Log' },
  }
}

function snapshot() {
  return createPreExportSnapshot(snapshotInput())
}

describe('pre-export snapshot', () => {
  const editedIntent = (): ColorGraphIntent => ({
    styleKind: 'custom',
    builtinPreset: null,
    // Between the Light (0.4) and Standard (0.7) detents.
    intensity: 0.37,
    userExposureEv: 0.5,
    userContrast: 12,
    userHighlights: -20,
    userShadows: 15,
    userWhites: -8,
    userBlacks: 6,
    userTemperature: 10,
    userTint: -4,
    userSaturation: 7,
    userVibrance: 18,
    selectiveColor: {
      ...NEUTRAL_SELECTIVE_COLOR,
      red: { hue: 10, saturation: 0, lightness: 0 },
    },
  })

  it('records the full color graph intent, a non-detent strength included', () => {
    const recorded = createPreExportSnapshot(snapshotInput(editedIntent()))

    expect(recorded.intent).toEqual(editedIntent())
    expect(recorded.intent.intensity).toBe(0.37)
  })

  it('keeps the intent it recorded when the source record changes later', () => {
    const source = editedIntent() as {
      -readonly [K in keyof ColorGraphIntent]: ColorGraphIntent[K]
    }
    const recorded = createPreExportSnapshot(snapshotInput(source))

    source.intensity = 1
    source.userContrast = 0
    source.styleKind = 'none'

    expect(recorded.intent).toEqual(editedIntent())
  })

  it('records a zero strength as a strength, not as a cleared look', () => {
    const recorded = createPreExportSnapshot(
      snapshotInput({ ...NEUTRAL_INTENT, intensity: 0 }),
    )

    expect(recorded.intent).toMatchObject({ styleKind: 'custom', intensity: 0 })
  })

  it('hands the recorded snapshot through evacuation unchanged', async () => {
    const recorded = createPreExportSnapshot(snapshotInput(editedIntent()))

    const result = await evacuateBeforeExport({
      registry: createResourceRegistry(),
      snapshot: recorded,
      owners: fullEvacuationOwners(),
    })

    expect(result.snapshot).toBe(recorded)
    expect(result.snapshot.intent).toEqual(editedIntent())
  })
})

describe('export evacuation', () => {
  it('uses the full evacuation owner set for every legacy metadata label', () => {
    expect(getPreExportEvacuationOwners('ios-safe')).toEqual(
      expectedFullEvacuationOwners,
    )
    expect(getPreExportEvacuationOwners('mobile-balanced')).toEqual(
      expectedFullEvacuationOwners,
    )
    expect(getPreExportEvacuationOwners('desktop-fast')).toEqual(
      expectedFullEvacuationOwners,
    )
  })

  it('runs the shared memory-efficient callbacks before export', async () => {
    const registry = createResourceRegistry()
    const events: string[] = []
    registry.register({
      id: 'gpu-pipeline',
      owner: 'gpu',
      kind: 'gpu-pipeline',
      dispose: () => {
        events.push('dispose-gpu-pipeline')
      },
    })
    registry.register({
      id: 'stale-result',
      owner: 'export-result',
      kind: 'blob',
      dispose: () => {
        events.push('dispose-stale-result')
      },
    })

    const result = await evacuateBeforeExport({
      registry,
      snapshot: snapshot(),
      owners: fullEvacuationOwners(),
      abortPreview: () => events.push('abort-preview'),
      abortBoundedHq: () => events.push('abort-bounded-hq'),
      releasePreviousExportResult: () => events.push('release-export-result'),
      stopLutFetches: () => events.push('stop-lut-fetches'),
    })

    expect(events).toEqual([
      'abort-preview',
      'abort-bounded-hq',
      'release-export-result',
      'stop-lut-fetches',
      'dispose-gpu-pipeline',
      'dispose-stale-result',
    ])
    expect(result.requiredOwners).toEqual([
      'preview',
      'bounded-hq',
      'gpu',
      'export-result',
      'lut-fetch',
    ])
    expect(result.disposedOwners).toEqual([
      'preview',
      'bounded-hq',
      'gpu',
      'export-result',
      'lut-fetch',
    ])
    expect(result.registryCheck).toEqual({ ok: true })
    expect(result.remainingLive).toEqual([])
    expect(result.estimatedBytesByOwner).toEqual({})
    expect(result.totalEstimatedBytes).toBe(0)
  })

  it('releases all low-memory owners before export', async () => {
    const registry = createResourceRegistry()
    const events: string[] = []
    registry.register({
      id: 'preview-worker',
      owner: 'preview',
      kind: 'worker',
      estimatedBytes: 1024,
      dispose: () => {
        events.push('dispose-preview-worker')
      },
    })
    registry.register({
      id: 'bounded-hq-buffer',
      owner: 'bounded-hq',
      kind: 'array-buffer',
      estimatedBytes: 2048,
      dispose: () => {
        events.push('dispose-bounded-hq-buffer')
      },
    })
    registry.register({
      id: 'gpu-pipeline',
      owner: 'gpu',
      kind: 'gpu-pipeline',
      estimatedBytes: 4096,
      dispose: () => {
        events.push('dispose-gpu-pipeline')
      },
    })

    const result = await evacuateBeforeExport({
      registry,
      snapshot: snapshot(),
      owners: fullEvacuationOwners(),
      abortPreview: () => events.push('abort-preview'),
      abortBoundedHq: () => events.push('abort-bounded-hq'),
      releasePreviousExportResult: () => events.push('release-export-result'),
      stopLutFetches: () => events.push('stop-lut-fetches'),
    })

    expect(events).toEqual([
      'abort-preview',
      'abort-bounded-hq',
      'release-export-result',
      'stop-lut-fetches',
      'dispose-bounded-hq-buffer',
      'dispose-gpu-pipeline',
      'dispose-preview-worker',
    ])
    expect(result.registryCheck).toEqual({ ok: true })
    expect(result.remainingLive).toEqual([])
    expect(result.estimatedBytesByOwner).toEqual({})
    expect(result.totalEstimatedBytes).toBe(0)
  })

  it('throws a stable evacuation error when owner disposal fails', async () => {
    const registry = createResourceRegistry()
    registry.register({
      id: 'stuck-gpu',
      owner: 'gpu',
      kind: 'gpu-pipeline',
      dispose: () => {
        throw new Error('dispose failed')
      },
    })

    await expect(
      evacuateBeforeExport({
        registry,
        snapshot: snapshot(),
        owners: fullEvacuationOwners(),
        abortPreview: vi.fn(),
        abortBoundedHq: vi.fn(),
        releasePreviousExportResult: vi.fn(),
        stopLutFetches: vi.fn(),
      }),
    ).rejects.toMatchObject({
      code: 'EXPORT_RESOURCE_EVICTION_INCOMPLETE',
    } satisfies Partial<ExportEvacuationError>)
  })

  it('serializes resource evacuation diagnostics without registry internals', () => {
    const payload = toResourceEvacuatedDebugPayload({
      profile: 'mobile-balanced',
      evacuation: {
        snapshot: snapshot(),
        registryCheck: {
          ok: false,
          live: [
            {
              id: 'gpu-pipeline',
              owner: 'gpu',
              kind: 'gpu-pipeline',
            },
          ],
        },
        requiredOwners: ['preview', 'gpu'],
        disposedOwners: ['preview'],
        remainingLive: [
          {
            id: 'gpu-pipeline',
            owner: 'gpu',
            kind: 'gpu-pipeline',
            estimatedBytes: 4096,
          },
        ],
        estimatedBytesByOwner: { gpu: 4096 },
        totalEstimatedBytes: 4096,
        evacuatedAt: '2026-05-04T00:00:00.000Z',
      },
    })

    expect(payload).toEqual({
      profile: 'mobile-balanced',
      requiredOwners: ['preview', 'gpu'],
      disposedOwners: ['preview'],
      registryCheck: {
        ok: false,
        live: [
          {
            id: 'gpu-pipeline',
            owner: 'gpu',
            kind: 'gpu-pipeline',
          },
        ],
      },
      remainingLive: [
        {
          id: 'gpu-pipeline',
          owner: 'gpu',
          kind: 'gpu-pipeline',
          estimatedBytes: 4096,
        },
      ],
      estimatedBytesByOwner: { gpu: 4096 },
      totalEstimatedBytes: 4096,
      evacuatedAt: '2026-05-04T00:00:00.000Z',
    })
  })

  it('serializes lifecycle cleanup diagnostics after export-result disposal', () => {
    const payload = toResourceCleanupDebugPayload({
      reason: 'reset-session',
      disposedOwners: ['export-result'],
      registryCheck: {
        ok: false,
        live: [
          {
            id: 'gpu-pipeline',
            owner: 'gpu',
            kind: 'gpu-pipeline',
          },
        ],
      },
      snapshot: {
        live: [
          {
            id: 'gpu-pipeline',
            owner: 'gpu',
            kind: 'gpu-pipeline',
            estimatedBytes: 4096,
          },
        ],
        liveByOwner: { gpu: 1 },
        estimatedBytesByOwner: { gpu: 4096 },
        totalEstimatedBytes: 4096,
      },
      cleanedAt: '2026-05-04T00:00:02.000Z',
    })

    expect(payload).toEqual({
      reason: 'reset-session',
      disposedOwners: ['export-result'],
      registryCheck: {
        ok: false,
        live: [
          {
            id: 'gpu-pipeline',
            owner: 'gpu',
            kind: 'gpu-pipeline',
          },
        ],
      },
      remainingLive: [
        {
          id: 'gpu-pipeline',
          owner: 'gpu',
          kind: 'gpu-pipeline',
          estimatedBytes: 4096,
        },
      ],
      estimatedBytesByOwner: { gpu: 4096 },
      totalEstimatedBytes: 4096,
      cleanedAt: '2026-05-04T00:00:02.000Z',
    })
  })
})
