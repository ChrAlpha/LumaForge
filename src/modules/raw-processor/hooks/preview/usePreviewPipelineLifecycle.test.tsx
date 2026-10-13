import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type {
  PreviewPipelineHandle,
  PreviewPipelineLifecycleOptions,
} from './usePreviewPipelineLifecycle'
import { usePreviewPipelineLifecycle } from './usePreviewPipelineLifecycle'

function deferred() {
  let resolve!: () => void
  let reject!: (error: unknown) => void
  const promise = new Promise<void>((onResolve, onReject) => {
    resolve = onResolve
    reject = onReject
  })
  return { promise, resolve, reject }
}

/**
 * A pipeline that releases once and tells its disposal subscribers once,
 * like the preview facade. `release` counts actual releases.
 */
function createPipeline({
  initialize = () => Promise.resolve(),
  estimatedBytes = 4096,
  subscribes = true,
}: {
  initialize?: () => Promise<void>
  estimatedBytes?: number
  subscribes?: boolean
} = {}) {
  const listeners = new Set<() => void>()
  let disposed = false
  const release = vi.fn()
  const unsubscribe = vi.fn()
  const pipeline = {
    initialize: vi.fn(initialize),
    release,
    unsubscribe,
    dispose: vi.fn(() => {
      if (disposed) return
      disposed = true
      release()
      const pending = [...listeners]
      listeners.clear()
      for (const listener of pending) listener()
    }),
    getResourceStats: vi.fn(() => ({ estimatedBytes })),
    ...(subscribes
      ? {
          onDisposed: vi.fn((listener: () => void) => {
            if (disposed) {
              listener()
              return unsubscribe
            }
            listeners.add(listener)
            return () => {
              unsubscribe()
              listeners.delete(listener)
            }
          }),
        }
      : {}),
  }
  return pipeline
}

type TestPipeline = ReturnType<typeof createPipeline>

function renderLifecycle(
  pipelines: TestPipeline[],
  initial: Partial<PreviewPipelineLifecycleOptions<TestPipeline>> = {},
) {
  const canvas = document.createElement('canvas')
  const canvasRef = { current: canvas }
  let next = 0
  const createPipelineFn = vi.fn(() => {
    const pipeline = pipelines[next++]
    if (!pipeline) throw new Error('no more test pipelines')
    return pipeline
  })
  const publish =
    vi.fn<
      (
        pipeline: TestPipeline | null,
        handle: PreviewPipelineHandle | null,
      ) => void
    >()
  const onInitializationError = vi.fn()
  const result = renderHook(
    (props: Partial<PreviewPipelineLifecycleOptions<TestPipeline>>) =>
      usePreviewPipelineLifecycle<TestPipeline>({
        canvasRef,
        createPipeline: createPipelineFn,
        publish,
        onInitializationError,
        ...props,
      }),
    { initialProps: initial },
  )
  const published = () =>
    publish.mock.calls.filter(([pipeline]) => pipeline !== null)
  const nulls = () =>
    publish.mock.calls.filter(([pipeline]) => pipeline === null).length
  return {
    ...result,
    canvas,
    createPipeline: createPipelineFn,
    publish,
    published,
    nulls,
    onInitializationError,
  }
}

async function flush() {
  await act(async () => {
    await Promise.resolve()
  })
}

describe('usePreviewPipelineLifecycle', () => {
  it('publishes a pipeline and its handle only once it has initialized', async () => {
    const initialized = deferred()
    const pipeline = createPipeline({ initialize: () => initialized.promise })
    const {
      result,
      publish,
      createPipeline: create,
      canvas,
    } = renderLifecycle([pipeline])

    expect(create).toHaveBeenCalledExactlyOnceWith(canvas)
    expect(publish).not.toHaveBeenCalled()
    expect(result.current.pipelineRef.current).toBeNull()
    expect(result.current.isInitialized).toBe(false)

    await act(async () => initialized.resolve())

    expect(result.current.pipelineRef.current).toBe(pipeline)
    expect(result.current.isInitialized).toBe(true)
    expect(publish).toHaveBeenCalledExactlyOnceWith(
      pipeline,
      expect.objectContaining({ dispose: expect.any(Function) }),
    )
    expect(pipeline.onDisposed).toHaveBeenCalledOnce()
    expect(pipeline.dispose).not.toHaveBeenCalled()
  })

  it('never publishes a pipeline whose owner unmounted while it initialized', async () => {
    const initialized = deferred()
    const pipeline = createPipeline({ initialize: () => initialized.promise })
    const { unmount, published, nulls, onInitializationError } =
      renderLifecycle([pipeline])

    unmount()
    expect(pipeline.release).toHaveBeenCalledOnce()
    expect(pipeline.unsubscribe).toHaveBeenCalledOnce()
    expect(nulls()).toBe(1)

    await act(async () => initialized.resolve())
    expect(published()).toEqual([])
    expect(pipeline.dispose).toHaveBeenCalledOnce()
    expect(onInitializationError).not.toHaveBeenCalled()
  })

  it('releases on suspension during initialization and builds anew on resume', async () => {
    const initialized = deferred()
    const first = createPipeline({ initialize: () => initialized.promise })
    const second = createPipeline()
    const {
      result,
      rerender,
      published,
      createPipeline: create,
    } = renderLifecycle([first, second])

    rerender({ suspended: true })
    expect(first.release).toHaveBeenCalledOnce()
    expect(result.current.pipelineRef.current).toBeNull()
    expect(result.current.isInitialized).toBe(false)

    await act(async () => initialized.resolve())
    expect(published()).toEqual([])
    expect(create).toHaveBeenCalledOnce()

    rerender({ suspended: false })
    await flush()
    expect(create).toHaveBeenCalledTimes(2)
    expect(published().map(([pipeline]) => pipeline)).toEqual([second])
    expect(result.current.pipelineRef.current).toBe(second)
    expect(first.dispose).toHaveBeenCalledOnce()
  })

  it.each([
    ['resolves', undefined],
    ['rejects', new Error('PREVIEW_PIPELINE_DISPOSED')],
  ] as const)(
    'never revives a pipeline disposed by another owner while it initialized (initialization %s late)',
    async (_outcome, failure) => {
      const initialized = deferred()
      const pipeline = createPipeline({
        initialize: () => initialized.promise,
      })
      const { result, unmount, published, onInitializationError } =
        renderLifecycle([pipeline], { releaseOnInitializationFailure: true })

      act(() => pipeline.dispose())
      expect(pipeline.unsubscribe).toHaveBeenCalledOnce()

      await act(async () => {
        if (failure) initialized.reject(failure)
        else initialized.resolve()
        await initialized.promise.catch(() => {})
      })

      expect(published()).toEqual([])
      expect(result.current.pipelineRef.current).toBeNull()
      expect(result.current.isInitialized).toBe(false)
      expect(onInitializationError).not.toHaveBeenCalled()

      unmount()
      expect(pipeline.dispose).toHaveBeenCalledOnce()
      expect(pipeline.release).toHaveBeenCalledOnce()
    },
  )

  it('forgets a pipeline once whoever disposes it, and its handle never releases a successor', async () => {
    const first = createPipeline()
    const second = createPipeline()
    const { result, rerender, published, nulls } = renderLifecycle([
      first,
      second,
    ])
    await flush()
    const [[, firstHandle]] = published()

    // The handle, another owner, and the handle again: one release, one null.
    act(() => firstHandle!.dispose())
    act(() => first.dispose())
    act(() => firstHandle!.dispose())
    expect(first.release).toHaveBeenCalledOnce()
    expect(nulls()).toBe(1)
    expect(result.current.pipelineRef.current).toBeNull()
    expect(result.current.isInitialized).toBe(false)

    rerender({ suspended: true })
    rerender({ suspended: false })
    await flush()
    expect(result.current.pipelineRef.current).toBe(second)
    const nullsBefore = nulls()

    act(() => firstHandle!.dispose())
    act(() => first.dispose())
    expect(second.dispose).not.toHaveBeenCalled()
    expect(result.current.pipelineRef.current).toBe(second)
    expect(result.current.isInitialized).toBe(true)
    expect(nulls()).toBe(nullsBefore)
  })

  it('tells its port null once per pipeline, never again for one already forgotten', async () => {
    const pipeline = createPipeline()
    const { published, nulls, unmount } = renderLifecycle([pipeline])
    await flush()
    const [[, handle]] = published()

    act(() => handle!.dispose())
    expect(nulls()).toBe(1)
    unmount()
    expect(nulls()).toBe(1)
    expect(pipeline.dispose).toHaveBeenCalledOnce()
  })

  it('works with pipelines that cannot report their disposal', async () => {
    const pipeline = createPipeline({ subscribes: false })
    const { result, published, nulls, unmount } = renderLifecycle([pipeline])
    await flush()
    const [[, handle]] = published()

    act(() => handle!.dispose())
    act(() => handle!.dispose())
    expect(pipeline.release).toHaveBeenCalledOnce()
    expect(result.current.pipelineRef.current).toBeNull()
    expect(nulls()).toBe(1)

    unmount()
    expect(pipeline.dispose).toHaveBeenCalledOnce()
  })

  it('reports through its handle whether its pipeline is live and what it holds', async () => {
    const pipeline = createPipeline({ estimatedBytes: 8192 })
    const { published } = renderLifecycle([pipeline])
    await flush()
    const [[, handle]] = published()

    expect(handle!.snapshot()).toEqual({ live: true, estimatedBytes: 8192 })
    act(() => handle!.dispose())
    expect(handle!.snapshot()).toEqual({ live: false, estimatedBytes: 0 })
    expect(pipeline.getResourceStats).toHaveBeenCalledOnce()
  })

  it('keeps a pipeline that failed to initialize until its owner goes, and reports the failure', async () => {
    const failure = new Error('Context restore failed')
    const pipeline = createPipeline({
      initialize: () => Promise.reject(failure),
    })
    const { result, published, onInitializationError, unmount } =
      renderLifecycle([pipeline])
    await flush()

    expect(onInitializationError).toHaveBeenCalledExactlyOnceWith(failure)
    expect(published()).toEqual([])
    expect(pipeline.dispose).not.toHaveBeenCalled()
    expect(result.current.isInitialized).toBe(false)

    unmount()
    expect(pipeline.release).toHaveBeenCalledExactlyOnceWith()
  })

  it('releases a pipeline that failed to initialize before reporting it when asked to', async () => {
    const failure = new Error('Original adapter lost')
    const pipeline = createPipeline({
      initialize: () => Promise.reject(failure),
    })
    const { onInitializationError, published, nulls, unmount } =
      renderLifecycle([pipeline], { releaseOnInitializationFailure: true })
    await flush()

    expect(onInitializationError).toHaveBeenCalledExactlyOnceWith(failure)
    expect(pipeline.release).toHaveBeenCalledExactlyOnceWith()
    expect(pipeline.release.mock.invocationCallOrder[0]).toBeLessThan(
      onInitializationError.mock.invocationCallOrder[0]!,
    )
    expect(published()).toEqual([])
    expect(nulls()).toBe(1)
    unmount()
    expect(pipeline.dispose).toHaveBeenCalledOnce()
  })

  it('reports a pipeline that could not be built', async () => {
    const failure = new Error('WebGPU is not supported on this device')
    const { onInitializationError, published } = renderLifecycle([], {
      createPipeline: () => {
        throw failure
      },
      releaseOnInitializationFailure: true,
    })
    await flush()

    expect(onInitializationError).toHaveBeenCalledExactlyOnceWith(failure)
    expect(published()).toEqual([])
  })

  it('lets its owner release the current pipeline with options, once', async () => {
    const pipeline = createPipeline()
    const { result, nulls, unmount } = renderLifecycle([pipeline])
    await flush()

    act(() => result.current.release())
    act(() => result.current.release())
    expect(pipeline.release).toHaveBeenCalledOnce()
    expect(result.current.pipelineRef.current).toBeNull()
    expect(result.current.isInitialized).toBe(false)
    expect(nulls()).toBe(1)

    unmount()
    expect(pipeline.dispose).toHaveBeenCalledOnce()
    act(() => result.current.release())
    expect(pipeline.dispose).toHaveBeenCalledOnce()
  })

  it('keeps its pipeline across callback changes and builds a new one for a new port', async () => {
    const first = createPipeline()
    const second = createPipeline()
    const {
      result,
      rerender,
      createPipeline: create,
    } = renderLifecycle([first, second])
    await flush()

    rerender({ onInitializationError: vi.fn() })
    await flush()
    expect(create).toHaveBeenCalledOnce()
    expect(first.dispose).not.toHaveBeenCalled()

    const nextPublish = vi.fn()
    rerender({ publish: nextPublish })
    await flush()
    expect(first.release).toHaveBeenCalledExactlyOnceWith()
    expect(create).toHaveBeenCalledTimes(2)
    expect(nextPublish).toHaveBeenLastCalledWith(second, expect.anything())
    expect(result.current.pipelineRef.current).toBe(second)
  })
})
