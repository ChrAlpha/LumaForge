import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { createDemoSample } from './demo-sample'
import { identityMatrix } from './geometry/matrix'
import type { UprightAnalysis, UprightMode } from './geometry/types'
import { loadImageInput } from './image-input'
import type { PreviewSource } from './preview-types'
import { ImageInputError } from './preview-types'
import { composeManualTransform } from './transform-render'
import type { ManualTransform, RenderedPreview } from './transform-types'
import { NEUTRAL_TRANSFORM } from './transform-types'
import type {
  TransformWorkerRequest,
  TransformWorkerResponse,
} from './worker-protocol'

type RenderRequest = Extract<TransformWorkerRequest, { type: 'render' }>

export function useTransformDemo({ autoLoadSample = true } = {}) {
  const [source, setSource] = useState<PreviewSource | null>(null)
  const [analysis, setAnalysis] = useState<UprightAnalysis | null>(null)
  const [result, setResult] = useState<RenderedPreview | null>(null)
  const [mode, setModeState] = useState<UprightMode>('off')
  const [solutions, setSolutions] = useState<
    UprightAnalysis['solutions'] | null
  >(null)
  const modeRef = useRef(mode)
  const [manual, setManual] = useState<ManualTransform>(NEUTRAL_TRANSFORM)
  const [constrainCrop, setConstrainCrop] = useState(true)
  const [loading, setLoading] = useState(false)
  const [rendering, setRendering] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [analysisMs, setAnalysisMs] = useState(0)
  const workerRef = useRef<Worker | null>(null)
  const sourceId = useRef(0)
  const requestId = useRef(0)
  const inFlight = useRef(false)
  const pending = useRef<RenderRequest | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  /**
   * Returns false when there is no worker to answer the request. Marking a
   * render in flight against a terminated worker would strand `inFlight`
   * (and `rendering`) forever, because only a response clears them.
   */
  const postRender = useCallback((request: RenderRequest) => {
    const worker = workerRef.current
    if (!worker) return false
    if (inFlight.current) pending.current = request
    else {
      inFlight.current = true
      worker.postMessage(request)
    }
    return true
  }, [])

  const loadSource = useCallback(
    async (
      input?: File | PreviewSource,
      { preserveTransform = false } = {},
    ) => {
      const id = ++sourceId.current
      abortRef.current?.abort()
      const abort = new AbortController()
      abortRef.current = abort
      inFlight.current = false
      pending.current = null
      setLoading(true)
      setRendering(false)
      setError(null)
      setAnalysis(null)
      setResult(null)
      setSource(null)
      if (!preserveTransform) {
        setModeState('off')
        modeRef.current = 'off'
        setSolutions(null)
        setManual(NEUTRAL_TRANSFORM)
        setConstrainCrop(true)
      }
      try {
        const next = input
          ? 'frame' in input
            ? input
            : await loadImageInput(input, abort.signal)
          : createDemoSample()
        if (id !== sourceId.current || abort.signal.aborted) return
        setSource(next)
        const worker =
          workerRef.current ??
          new Worker(new URL('./transform.worker.ts', import.meta.url), {
            type: 'module',
          })
        workerRef.current = worker
        worker.onerror = () => {
          if (workerRef.current !== worker) return
          workerRef.current = null
          worker.terminate()
          if (id !== sourceId.current || abort.signal.aborted) return
          setError('processing')
          setAnalysis(null)
          // The rendered frame cannot be refreshed without a worker, so it
          // must not survive as something the UI can report as current.
          setSolutions(null)
          setResult(null)
          setLoading(false)
          setRendering(false)
        }
        worker.onmessage = ({
          data,
        }: MessageEvent<TransformWorkerResponse>) => {
          if (data.sourceId !== sourceId.current) return
          if (data.type === 'analyzed') {
            setError(null)
            setAnalysis(data.analysis)
            setSolutions((previous) =>
              preserveTransform && modeRef.current !== 'off' && previous
                ? previous
                : data.analysis.solutions,
            )
            setAnalysisMs(data.elapsedMs)
            setLoading(false)
          } else {
            inFlight.current = false
            if (data.requestId === requestId.current) {
              if (data.type === 'rendered') {
                setResult(data.result)
                setError(null)
              } else
                setError(
                  data.message === 'invalid-transform'
                    ? 'transform'
                    : 'processing',
                )
              setRendering(false)
            } else if (data.type === 'error' && data.requestId === undefined) {
              setError('processing')
              setLoading(false)
            }
            if (pending.current) {
              const latest = pending.current
              pending.current = null
              postRender(latest)
            }
          }
        }
        worker.postMessage({
          type: 'analyze',
          sourceId: id,
          frame: next.frame,
        } satisfies TransformWorkerRequest)
      } catch (cause) {
        if (id !== sourceId.current || abort.signal.aborted) return
        setError(cause instanceof ImageInputError ? cause.code : 'decode')
        setLoading(false)
      }
    },
    [postRender],
  )

  const dispose = useCallback(() => {
    ++sourceId.current
    abortRef.current?.abort()
    workerRef.current?.terminate()
    workerRef.current = null
    inFlight.current = false
    pending.current = null
  }, [])

  const clearSource = useCallback(() => {
    const id = ++sourceId.current
    abortRef.current?.abort()
    inFlight.current = false
    pending.current = null
    workerRef.current?.postMessage({
      type: 'clear',
      sourceId: id,
    } satisfies TransformWorkerRequest)
    setSource(null)
    setAnalysis(null)
    setSolutions(null)
    setResult(null)
    setError(null)
    setLoading(false)
    setRendering(false)
    setModeState('off')
    modeRef.current = 'off'
    setManual(NEUTRAL_TRANSFORM)
    setConstrainCrop(true)
  }, [])

  useEffect(() => {
    if (autoLoadSample) void loadSource()
    return dispose
  }, [autoLoadSample, dispose, loadSource])

  /**
   * The geometry currently on screen. The export commits this exact matrix, so
   * the full-resolution render reproduces the framing the user approved rather
   * than recomposing it from parts and hoping the two agree.
   */
  const matrix = useMemo(
    () =>
      source && solutions
        ? composeManualTransform(
            solutions[mode].matrix,
            manual,
            source.frame.width / source.frame.height,
          )
        : null,
    [manual, mode, solutions, source],
  )

  useEffect(() => {
    if (!source || !analysis || !solutions || !matrix) return
    const id = ++requestId.current
    const posted = postRender({
      type: 'render',
      sourceId: sourceId.current,
      requestId: id,
      matrix,
      constrainCrop,
    })
    if (posted) setRendering(true)
  }, [analysis, constrainCrop, matrix, postRender, solutions, source])

  const selectMode = (next: UprightMode) => {
    modeRef.current = next
    setModeState(next)
    if (analysis) setSolutions(analysis.solutions)
  }

  const reset = () => {
    setModeState('off')
    modeRef.current = 'off'
    setManual({ ...NEUTRAL_TRANSFORM })
    setConstrainCrop(true)
    // Reset retires the geometry that failed, so the failure it raised must
    // not outlive it; the neutral render this queues re-reports any new one.
    setError(null)
  }

  return {
    source,
    analysis,
    result,
    mode,
    setMode: selectMode,
    manual,
    setManual,
    constrainCrop,
    setConstrainCrop,
    loading,
    rendering,
    error,
    analysisMs,
    loadSource,
    clearSource,
    reset,
    matrix,
    ready: Boolean(analysis && source),
    solution: solutions?.[mode] ?? {
      matrix: identityMatrix(),
      confidence: 0,
      status: 'unchanged' as const,
      reason: '',
      rotationDegrees: 0,
    },
  }
}
