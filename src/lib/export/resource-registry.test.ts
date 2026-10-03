import { describe, expect, it, vi } from 'vitest'

import type { LargeResourceOwner } from './resource-registry'
import { createResourceRegistry } from './resource-registry'

describe('resource registry', () => {
  it('registers resources and reports a deterministic owner snapshot', () => {
    const registry = createResourceRegistry()

    registry.register({
      id: 'gpu-pipeline',
      owner: 'gpu',
      kind: 'gpu-pipeline',
      estimatedBytes: 16,
      dispose: vi.fn(),
    })
    registry.register({
      id: 'preview-worker',
      owner: 'preview',
      kind: 'worker',
      estimatedBytes: 8,
      dispose: vi.fn(),
    })
    registry.register({
      id: 'preview-buffer',
      owner: 'preview',
      kind: 'array-buffer',
      estimatedBytes: 4,
      dispose: vi.fn(),
    })

    expect(registry.snapshot()).toEqual({
      live: [
        {
          id: 'gpu-pipeline',
          owner: 'gpu',
          kind: 'gpu-pipeline',
          estimatedBytes: 16,
        },
        {
          id: 'preview-buffer',
          owner: 'preview',
          kind: 'array-buffer',
          estimatedBytes: 4,
        },
        {
          id: 'preview-worker',
          owner: 'preview',
          kind: 'worker',
          estimatedBytes: 8,
        },
      ],
      liveByOwner: {
        preview: 2,
        gpu: 1,
      },
      estimatedBytesByOwner: {
        preview: 12,
        gpu: 16,
      },
      totalEstimatedBytes: 28,
    })
  })

  it('rejects duplicate live ids and allows reuse after disposal', async () => {
    const registry = createResourceRegistry()
    const firstDispose = vi.fn()

    const tracked = registry.register({
      id: 'preview-worker',
      owner: 'preview',
      kind: 'worker',
      dispose: firstDispose,
    })

    expect(() =>
      registry.register({
        id: 'preview-worker',
        owner: 'bounded-hq',
        kind: 'array-buffer',
        dispose: vi.fn(),
      }),
    ).toThrow('RESOURCE_REGISTRY_DUPLICATE_ID:preview-worker')

    await tracked.dispose()

    const secondDispose = vi.fn()
    registry.register({
      id: 'preview-worker',
      owner: 'bounded-hq',
      kind: 'array-buffer',
      dispose: secondDispose,
    })

    expect(firstDispose).toHaveBeenCalledTimes(1)
    expect(registry.snapshot().liveByOwner).toEqual({ 'bounded-hq': 1 })
  })

  it('makes tracked disposal idempotent', async () => {
    const registry = createResourceRegistry()
    const dispose = vi.fn()

    const tracked = registry.register({
      id: 'bounded-hq-buffer',
      owner: 'bounded-hq',
      kind: 'array-buffer',
      dispose,
    })

    await tracked.dispose()
    await tracked.dispose()

    expect(tracked.disposed).toBe(true)
    expect(dispose).toHaveBeenCalledTimes(1)
    expect(registry.assertZeroLive(['bounded-hq'])).toEqual({ ok: true })
  })

  it('keeps a resource live when disposal fails so evacuation cannot hide it', async () => {
    const registry = createResourceRegistry()
    const dispose = vi
      .fn()
      .mockRejectedValueOnce(new Error('release failed'))
      .mockResolvedValueOnce(undefined)

    const tracked = registry.register({
      id: 'preview-worker',
      owner: 'preview',
      kind: 'worker',
      dispose,
    })

    await expect(tracked.dispose()).rejects.toThrow('release failed')

    expect(tracked.disposed).toBe(false)
    expect(registry.assertZeroLive(['preview'])).toEqual({
      ok: false,
      live: [{ id: 'preview-worker', owner: 'preview', kind: 'worker' }],
    })

    await tracked.dispose()

    expect(dispose).toHaveBeenCalledTimes(2)
    expect(tracked.disposed).toBe(true)
    expect(registry.assertZeroLive(['preview'])).toEqual({ ok: true })
  })

  it('disposes matching owners in deterministic id order', async () => {
    const registry = createResourceRegistry()
    const disposed: string[] = []

    registry.register({
      id: 'z-preview',
      owner: 'preview',
      kind: 'worker',
      dispose: () => {
        disposed.push('z-preview')
      },
    })
    registry.register({
      id: 'a-preview',
      owner: 'preview',
      kind: 'array-buffer',
      dispose: () => {
        disposed.push('a-preview')
      },
    })
    registry.register({
      id: 'export-worker',
      owner: 'export-worker',
      kind: 'worker',
      dispose: () => {
        disposed.push('export-worker')
      },
    })

    await registry.disposeOwners(['preview'])

    expect(disposed).toEqual(['a-preview', 'z-preview'])
    expect(registry.snapshot().live.map((resource) => resource.id)).toEqual([
      'export-worker',
    ])
  })

  it('reports assertZeroLive failure and success with deterministic records', async () => {
    const registry = createResourceRegistry()
    const owners: LargeResourceOwner[] = ['preview', 'gpu']

    const gpu = registry.register({
      id: 'gpu-pipeline',
      owner: 'gpu',
      kind: 'gpu-pipeline',
      dispose: vi.fn(),
    })
    registry.register({
      id: 'preview-worker',
      owner: 'preview',
      kind: 'worker',
      dispose: vi.fn(),
    })

    expect(registry.assertZeroLive(owners)).toEqual({
      ok: false,
      live: [
        { id: 'gpu-pipeline', owner: 'gpu', kind: 'gpu-pipeline' },
        { id: 'preview-worker', owner: 'preview', kind: 'worker' },
      ],
    })

    await registry.disposeOwners(['preview'])
    await gpu.dispose()

    expect(registry.assertZeroLive(owners)).toEqual({ ok: true })
  })
})
