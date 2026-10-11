import { act, renderHook } from '@testing-library/react'
import { useCallback, useRef } from 'react'
import { describe, expect, it, vi } from 'vitest'

import { createResourceRegistry } from '~/lib/export/resource-registry'

import type { PreviewPipelineHandle } from '../../preview/usePreviewPipelineLifecycle'
import { usePreviewPipelineLifecycle } from '../../preview/usePreviewPipelineLifecycle'
import { usePreviewPipelineEvacuation } from './usePreviewPipelineEvacuation'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((onResolve) => {
    resolve = onResolve
  })
  return { promise, resolve }
}

/**
 * A pipeline that releases once and tells its disposal subscribers once,
 * like the preview facade. `release` counts actual releases.
 */
function createPipeline({
  initialize = () => Promise.resolve(),
  estimatedBytes = 4096,
}: {
  initialize?: () => Promise<void>
  estimatedBytes?: number
} = {}) {
  const listeners = new Set<() => void>()
  let disposed = false
  const release = vi.fn()
  return {
    initialize: vi.fn(initialize),
    release,
    dispose: vi.fn((options?: { releaseContext?: boolean }) => {
      if (disposed) return
      disposed = true
      if (options) release(options)
      else release()
      const pending = [...listeners]
      listeners.clear()
      for (const listener of pending) listener()
    }),
    getResourceStats: vi.fn(() => ({ estimatedBytes })),
    onDisposed: vi.fn((listener: () => void) => {
      if (disposed) {
        listener()
        return () => {}
      }
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    }),
  }
}

type TestPipeline = ReturnType<typeof createPipeline>

function sequence(pipelines: TestPipeline[]) {
  let next = 0
  return () => {
    const pipeline = pipelines[next++]
    if (!pipeline) throw new Error('no more test pipelines')
    return pipeline
  }
}

/**
 * The two preview GPU owners as the stage mounts them: the processed one
 * publishes its pipeline into the workflow's ref, the original one publishes
 * its handle through the evacuation port. Evacuation only registers what they
 * published.
 */
function renderOwners({
  processed,
  original = [],
}: {
  processed: TestPipeline[]
  original?: TestPipeline[]
}) {
  const registry = createResourceRegistry()
  const resourceRegistryRef = { current: registry }
  const pipelineRef = { current: null as TestPipeline | null }
  const processedCanvasRef = { current: document.createElement('canvas') }
  const originalCanvasRef = { current: document.createElement('canvas') }
  const createProcessed = sequence(processed)
  const createOriginal = sequence(original)

  const rendered = renderHook(
    ({ suspended }: { suspended: boolean }) => {
      const evacuation = usePreviewPipelineEvacuation({
        resourceRegistryRef,
        pipelineRef,
      })
      const { setOriginalPreviewPipeline } = evacuation
      const publishProcessed = useCallback((pipeline: TestPipeline | null) => {
        pipelineRef.current = pipeline
      }, [])
      const publishOriginal = useCallback(
        (
          _pipeline: TestPipeline | null,
          handle: PreviewPipelineHandle | null,
        ) => setOriginalPreviewPipeline(handle),
        [setOriginalPreviewPipeline],
      )
      const onInitializationError = useRef(vi.fn()).current
      usePreviewPipelineLifecycle({
        canvasRef: processedCanvasRef,
        createPipeline: createProcessed,
        publish: publishProcessed,
        onInitializationError,
        suspended,
      })
      usePreviewPipelineLifecycle({
        canvasRef: originalCanvasRef,
        createPipeline: createOriginal,
        publish: publishOriginal,
        onInitializationError,
        releaseOnInitializationFailure: true,
        suspended: suspended || original.length === 0,
      })
      return evacuation
    },
    { initialProps: { suspended: false } },
  )
  return { ...rendered, registry, pipelineRef }
}

async function flush() {
  await act(async () => {
    await Promise.resolve()
  })
}

/**
 * Disposal reaches the owners, which unpublish their pipelines through React
 * state, so it runs inside act.
 */
async function disposeGpuOwners(
  registry: ReturnType<typeof createResourceRegistry>,
) {
  await act(async () => {
    await registry.disposeOwners(['gpu'])
  })
}

describe('usePreviewPipelineEvacuation', () => {
  it('accounts for both GPU owners with the bytes their pipelines hold', async () => {
    const processed = createPipeline({ estimatedBytes: 4096 })
    const original = createPipeline({ estimatedBytes: 8192 })
    const { result, registry } = renderOwners({
      processed: [processed],
      original: [original],
    })
    await flush()

    result.current.registerCurrentPreviewPipelineForEvacuation()

    expect(registry.snapshot().live).toEqual([
      {
        id: 'gpu-pipeline-1-processed',
        owner: 'gpu',
        kind: 'gpu-pipeline',
        estimatedBytes: 4096,
      },
      {
        id: 'gpu-pipeline-2-original',
        owner: 'gpu',
        kind: 'gpu-pipeline',
        estimatedBytes: 8192,
      },
    ])
    expect(registry.snapshot().totalEstimatedBytes).toBe(12288)
  })

  it('releases each pipeline once through its owner, which unpublishes it', async () => {
    const processed = createPipeline()
    const original = createPipeline()
    const { result, registry, pipelineRef, unmount } = renderOwners({
      processed: [processed],
      original: [original],
    })
    await flush()

    result.current.registerCurrentPreviewPipelineForEvacuation()
    await disposeGpuOwners(registry)

    expect(processed.release).toHaveBeenCalledExactlyOnceWith({
      releaseContext: true,
    })
    expect(original.release).toHaveBeenCalledExactlyOnceWith({
      releaseContext: true,
    })
    expect(pipelineRef.current).toBeNull()
    expect(registry.snapshot().live).toEqual([])

    // Neither owner publishes a pipeline any more, so nothing is registered,
    // and repeated cleanup releases nothing again.
    result.current.registerCurrentPreviewPipelineForEvacuation()
    await disposeGpuOwners(registry)
    unmount()
    expect(registry.snapshot().live).toEqual([])
    expect(processed.release).toHaveBeenCalledOnce()
    expect(original.release).toHaveBeenCalledOnce()
  })

  it('registers each published pipeline once however often it is asked', async () => {
    const { result, registry } = renderOwners({
      processed: [createPipeline({ estimatedBytes: 4096 })],
      original: [createPipeline({ estimatedBytes: 8192 })],
    })
    await flush()

    result.current.registerCurrentPreviewPipelineForEvacuation()
    result.current.registerCurrentPreviewPipelineForEvacuation()

    expect(registry.snapshot().live.map(({ id }) => id)).toEqual([
      'gpu-pipeline-1-processed',
      'gpu-pipeline-2-original',
    ])
    expect(registry.snapshot().totalEstimatedBytes).toBe(12288)
  })

  it('never lets a registration of a replaced pipeline touch its successor', async () => {
    const first = createPipeline()
    const second = createPipeline()
    const { result, registry, pipelineRef, rerender } = renderOwners({
      processed: [first, second],
    })
    await flush()
    result.current.registerCurrentPreviewPipelineForEvacuation()

    // The owner releases the first pipeline and publishes a successor
    // before the stale registration is disposed.
    rerender({ suspended: true })
    rerender({ suspended: false })
    await flush()
    expect(pipelineRef.current).toBe(second)

    await disposeGpuOwners(registry)

    expect(first.release).toHaveBeenCalledOnce()
    expect(second.dispose).not.toHaveBeenCalled()
    expect(pipelineRef.current).toBe(second)
  })

  it('registers the pipelines a restore publishes after an export released the first ones', async () => {
    const first = createPipeline({ estimatedBytes: 1024 })
    const firstOriginal = createPipeline({ estimatedBytes: 2048 })
    const restored = createPipeline({ estimatedBytes: 4096 })
    const restoredOriginal = createPipeline({ estimatedBytes: 8192 })
    const { result, registry, pipelineRef, rerender } = renderOwners({
      processed: [first, restored],
      original: [firstOriginal, restoredOriginal],
    })
    await flush()

    // Export evacuates the preview, then holds it suspended.
    result.current.registerCurrentPreviewPipelineForEvacuation()
    await disposeGpuOwners(registry)
    rerender({ suspended: true })

    // Restore resumes the preview; its owners build and publish anew.
    rerender({ suspended: false })
    await flush()
    expect(pipelineRef.current).toBe(restored)

    result.current.registerCurrentPreviewPipelineForEvacuation()
    expect(registry.snapshot().totalEstimatedBytes).toBe(12288)
    await disposeGpuOwners(registry)

    expect(first.release).toHaveBeenCalledOnce()
    expect(firstOriginal.release).toHaveBeenCalledOnce()
    expect(restored.release).toHaveBeenCalledExactlyOnceWith({
      releaseContext: true,
    })
    expect(restoredOriginal.release).toHaveBeenCalledExactlyOnceWith({
      releaseContext: true,
    })
    expect(pipelineRef.current).toBeNull()
  })

  it('registers nothing for a pipeline disposed externally while it initializes', async () => {
    const initialized = deferred()
    const processed = createPipeline({
      initialize: () => initialized.promise,
    })
    const { result, registry, pipelineRef } = renderOwners({
      processed: [processed],
    })

    processed.dispose()
    await act(async () => initialized.resolve())

    result.current.registerCurrentPreviewPipelineForEvacuation()
    expect(pipelineRef.current).toBeNull()
    expect(registry.snapshot().live).toEqual([])
    expect(processed.release).toHaveBeenCalledOnce()
  })

  it('registers nothing for an original handle whose pipeline is gone', () => {
    const registry = createResourceRegistry()
    const { result } = renderHook(() =>
      usePreviewPipelineEvacuation({
        resourceRegistryRef: { current: registry },
        pipelineRef: { current: null },
      }),
    )
    const released: PreviewPipelineHandle = {
      dispose: vi.fn(),
      snapshot: () => ({ live: false, estimatedBytes: 0 }),
    }

    result.current.setOriginalPreviewPipeline(released)
    result.current.registerCurrentPreviewPipelineForEvacuation()

    expect(registry.snapshot().live).toEqual([])
  })
})
