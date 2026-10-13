import type { RefObject } from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'

/** The lifetime surface of a preview GPU pipeline. */
export interface PreviewLifecyclePipeline {
  initialize: () => Promise<void>
  dispose: () => void
  /** Tells the owner when anyone disposes the pipeline, so it forgets it. */
  onDisposed?: (listener: () => void) => () => void
  getResourceStats?: () => { estimatedBytes: number }
}

/** What a published pipeline holds while its owner keeps it. */
export interface PreviewPipelineSnapshot {
  live: boolean
  estimatedBytes: number
}

/**
 * The handle an owner publishes with its pipeline. It is bound to that one
 * pipeline: disposing releases it and its GPU context once, however often it
 * runs, and a stale handle never touches a successor.
 */
export interface PreviewPipelineHandle {
  dispose: () => void
  snapshot: () => PreviewPipelineSnapshot
}

export interface PreviewPipelineLifecycleOptions<
  TPipeline extends PreviewLifecyclePipeline,
> {
  canvasRef: RefObject<HTMLCanvasElement | null>
  /** Builds the pipeline; a new function builds a new pipeline. */
  createPipeline: (canvas: HTMLCanvasElement) => TPipeline
  /**
   * Receives the pipeline once it has initialized, and `null` when it is
   * forgotten or its owner tears down. A new function rebuilds the pipeline.
   */
  publish: (
    pipeline: TPipeline | null,
    handle: PreviewPipelineHandle | null,
  ) => void
  /** Receives a build or initialization failure of the current pipeline. */
  onInitializationError: (error: unknown) => void
  /**
   * While suspended there is no pipeline; entering suspension releases the
   * current one.
   */
  suspended?: boolean
  /**
   * Whether a pipeline that failed to initialize is released before the
   * failure is reported, instead of being kept until its owner goes.
   */
  releaseOnInitializationFailure?: boolean
}

export interface PreviewPipelineLifecycle<
  TPipeline extends PreviewLifecyclePipeline,
> {
  /** The published pipeline, or `null`; it never holds a disposed one. */
  pipelineRef: RefObject<TPipeline | null>
  isInitialized: boolean
  /** Releases the current pipeline once; later calls are no-ops. */
  release: () => void
}

/**
 * The sole owner of one preview GPU pipeline's lifetime.
 *
 * It builds the pipeline for the canvas, publishes it only after it has
 * initialized, and forgets it exactly once, whoever disposes it: this owner on
 * unmount or suspension, its caller, a published handle, or another holder of
 * the pipeline such as export memory evacuation. A pipeline disposed or
 * abandoned while it initializes is never published.
 */
export function usePreviewPipelineLifecycle<
  TPipeline extends PreviewLifecyclePipeline,
>({
  canvasRef,
  createPipeline,
  publish,
  onInitializationError,
  suspended = false,
  releaseOnInitializationFailure = false,
}: PreviewPipelineLifecycleOptions<TPipeline>): PreviewPipelineLifecycle<TPipeline> {
  const pipelineRef = useRef<TPipeline | null>(null)
  const onInitializationErrorRef = useRef(onInitializationError)
  const releaseCurrentRef = useRef<() => void>(() => {})
  const [isInitialized, setIsInitialized] = useState(false)

  useEffect(() => {
    onInitializationErrorRef.current = onInitializationError
  }, [onInitializationError])

  useEffect(() => {
    if (suspended) {
      pipelineRef.current = null
      publish(null, null)
      setIsInitialized(false)
      return
    }

    const canvas = canvasRef.current
    if (!canvas) return

    let pipeline: TPipeline | null = null
    let unsubscribeDisposed: (() => void) | null = null
    let cancelled = false
    let disposed = false

    const forgetPipeline = () => {
      if (!pipeline || disposed) return
      const forgotten = pipeline
      pipeline = null
      disposed = true
      unsubscribeDisposed?.()
      unsubscribeDisposed = null
      if (pipelineRef.current === forgotten) {
        pipelineRef.current = null
        publish(null, null)
      }
      setIsInitialized(false)
    }

    // The publication port hears `null` once per pipeline it may know of,
    // before the pipeline is released.
    const releasePipeline = () => {
      const owned = pipeline
      if (!owned || disposed) return
      const wasPublished = pipelineRef.current === owned
      forgetPipeline()
      if (!wasPublished) publish(null, null)
      owned.dispose()
    }

    const handle: PreviewPipelineHandle = {
      dispose: releasePipeline,
      snapshot: () =>
        pipeline && !disposed
          ? {
              live: true,
              estimatedBytes: pipeline.getResourceStats?.().estimatedBytes ?? 0,
            }
          : { live: false, estimatedBytes: 0 },
    }
    releaseCurrentRef.current = releasePipeline

    const initialize = async () => {
      try {
        const created = createPipeline(canvas)
        pipeline = created
        unsubscribeDisposed = created.onDisposed?.(forgetPipeline) ?? null
        await created.initialize()
        if (cancelled || disposed) return

        pipelineRef.current = created
        publish(created, handle)
        setIsInitialized(true)
      } catch (error) {
        if (cancelled || disposed) return
        if (releaseOnInitializationFailure) releasePipeline()
        onInitializationErrorRef.current(error)
      }
    }

    void initialize()

    return () => {
      cancelled = true
      releasePipeline()
      if (releaseCurrentRef.current === releasePipeline) {
        releaseCurrentRef.current = () => {}
      }
      pipelineRef.current = null
    }
  }, [
    canvasRef,
    createPipeline,
    publish,
    releaseOnInitializationFailure,
    suspended,
  ])

  const release = useCallback(() => releaseCurrentRef.current(), [])

  return { pipelineRef, isInitialized, release }
}
