import { useCallback, useEffect, useRef, useState } from 'react'

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
  const [mode, setMode] = useState<UprightMode>('off')
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

  const postRender = useCallback((request: RenderRequest) => {
    if (inFlight.current) pending.current = request
    else {
      inFlight.current = true
      workerRef.current?.postMessage(request)
    }
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
        setMode('off')
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
          setError('processing')
          setAnalysis(null)
          setLoading(false)
          setRendering(false)
          worker.terminate()
        }
        worker.onmessage = ({
          data,
        }: MessageEvent<TransformWorkerResponse>) => {
          if (data.sourceId !== sourceId.current) return
          if (data.type === 'analyzed') {
            setError(null)
            setAnalysis(data.analysis)
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
    dispose()
    setSource(null)
    setAnalysis(null)
    setResult(null)
    setError(null)
    setLoading(false)
    setRendering(false)
    setMode('off')
    setManual(NEUTRAL_TRANSFORM)
    setConstrainCrop(true)
  }, [dispose])

  useEffect(() => {
    if (autoLoadSample) void loadSource()
    return dispose
  }, [autoLoadSample, dispose, loadSource])

  useEffect(() => {
    if (!source || !analysis) return
    const id = ++requestId.current
    setRendering(true)
    postRender({
      type: 'render',
      sourceId: sourceId.current,
      requestId: id,
      matrix: composeManualTransform(
        analysis.solutions[mode].matrix,
        manual,
        source.frame.width / source.frame.height,
      ),
      constrainCrop,
    })
  }, [analysis, constrainCrop, manual, mode, postRender, source])

  const reset = () => {
    setMode('off')
    setManual({ ...NEUTRAL_TRANSFORM })
    setConstrainCrop(true)
  }

  return {
    source,
    analysis,
    result,
    mode,
    setMode,
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
    ready: Boolean(analysis && source),
    solution: analysis?.solutions[mode] ?? {
      matrix: identityMatrix(),
      confidence: 0,
      status: 'unchanged' as const,
      reason: '',
      rotationDegrees: 0,
    },
  }
}
