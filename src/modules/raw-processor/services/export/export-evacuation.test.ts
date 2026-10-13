import { describe, expect, it, vi } from 'vitest'

import { createResourceRegistry } from '~/lib/export/resource-registry'

import {
  evacuateBeforeExport,
  toResourceCleanupDebugPayload,
} from './export-evacuation'

const OWNERS = ['preview', 'bounded-hq', 'gpu', 'export-result', 'lut-fetch']

describe('evacuateBeforeExport', () => {
  it('stops the preview and drops the previous result before disposing every evacuated owner', async () => {
    const registry = createResourceRegistry()
    const events: string[] = []
    for (const [id, owner] of [
      ['preview-worker', 'preview'],
      ['bounded-hq-buffer', 'bounded-hq'],
      ['gpu-pipeline', 'gpu'],
      ['stale-result', 'export-result'],
    ] as const) {
      registry.register({
        id,
        owner,
        kind: 'blob',
        estimatedBytes: 1024,
        dispose: () => {
          events.push(`dispose-${id}`)
        },
      })
    }

    const payload = await evacuateBeforeExport({
      registry,
      profile: 'desktop-fast',
      stopPreview: () => events.push('stop-preview'),
      releasePreviousExportResult: () => events.push('release-export-result'),
    })

    expect(events.slice(0, 2)).toEqual([
      'stop-preview',
      'release-export-result',
    ])
    expect(events.slice(2).sort()).toEqual([
      'dispose-bounded-hq-buffer',
      'dispose-gpu-pipeline',
      'dispose-preview-worker',
      'dispose-stale-result',
    ])
    expect(payload).toEqual({
      profile: 'desktop-fast',
      requiredOwners: OWNERS,
      disposedOwners: OWNERS,
      registryCheck: { ok: true },
      remainingLive: [],
      estimatedBytesByOwner: {},
      totalEstimatedBytes: 0,
      evacuatedAt: expect.any(String),
    })
  })

  it('reports what a dispose left live without registry internals', async () => {
    const registry = createResourceRegistry()
    registry.register({
      id: 'gpu-pipeline',
      owner: 'gpu',
      kind: 'gpu-pipeline',
      dispose: () => {
        registry.register({
          id: 'late-preview-frame',
          owner: 'preview',
          kind: 'array-buffer',
          estimatedBytes: 4096,
          dispose: () => {},
        })
      },
    })

    const payload = await evacuateBeforeExport({
      registry,
      profile: 'mobile-balanced',
      stopPreview: vi.fn(),
      releasePreviousExportResult: vi.fn(),
    })

    const late = {
      id: 'late-preview-frame',
      owner: 'preview',
      kind: 'array-buffer',
    }
    expect(payload).toMatchObject({
      registryCheck: { ok: false, live: [late] },
      remainingLive: [{ ...late, estimatedBytes: 4096 }],
      estimatedBytesByOwner: { preview: 4096 },
      totalEstimatedBytes: 4096,
    })
  })

  it('fails with the stable evacuation code when a dispose throws', async () => {
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
        profile: 'desktop-fast',
        stopPreview: vi.fn(),
        releasePreviousExportResult: vi.fn(),
      }),
    ).rejects.toMatchObject({ code: 'EXPORT_RESOURCE_EVICTION_INCOMPLETE' })
  })
})

describe('toResourceCleanupDebugPayload', () => {
  it('serializes lifecycle cleanup diagnostics without registry internals', () => {
    const gpu = {
      id: 'gpu-pipeline',
      owner: 'gpu',
      kind: 'gpu-pipeline',
    } as const
    const payload = toResourceCleanupDebugPayload({
      reason: 'reset-session',
      disposedOwners: ['export-result'],
      registryCheck: { ok: false, live: [gpu] },
      snapshot: {
        live: [{ ...gpu, estimatedBytes: 4096 }],
        liveByOwner: { gpu: 1 },
        estimatedBytesByOwner: { gpu: 4096 },
        totalEstimatedBytes: 4096,
      },
      cleanedAt: '2026-05-04T00:00:02.000Z',
    })

    expect(payload).toEqual({
      reason: 'reset-session',
      disposedOwners: ['export-result'],
      registryCheck: { ok: false, live: [gpu] },
      remainingLive: [{ ...gpu, estimatedBytes: 4096 }],
      estimatedBytesByOwner: { gpu: 4096 },
      totalEstimatedBytes: 4096,
      cleanedAt: '2026-05-04T00:00:02.000Z',
    })
  })
})
