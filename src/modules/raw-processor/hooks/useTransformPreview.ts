import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { identityMatrix } from '~/lib/transform/geometry/matrix'
import type { UprightAnalysis } from '~/lib/transform/geometry/types'
import type { PreviewSource } from '~/lib/transform/preview-types'
import type {
  TransformRenderFailure,
  TransformRenderRequest,
} from '~/lib/transform/transform-client'
import { createTransformClient } from '~/lib/transform/transform-client'
import { composeManualTransform } from '~/lib/transform/transform-render'
import type { RenderedPreview } from '~/lib/transform/transform-types'

import type { TransformIntent } from '../model/session'

/**
 * What the preview reports as it happens, for whoever owns the intent. Each
 * render callback names the request as posted, geometry included; only the
 * newest request on the loaded frame is ever answered.
 */
export interface TransformPreviewObserver {
  /** A render was asked of the loaded frame, answerable or not. */
  requested?: (request: TransformRenderRequest) => void
  /** `frame` is the size of the frame the request was rendered on. */
  rendered?: (
    request: TransformRenderRequest,
    frame: { width: number; height: number },
  ) => void
  renderFailed?: (
    request: TransformRenderRequest,
    failure: TransformRenderFailure,
  ) => void
  /** The loaded frame could not be handed over, analysed or kept. */
  frameFailed?: () => void
}

/**
 * Upright analysis and transformed rendering of one preview frame at a time,
 * off the main thread. The caller hands it frames and owns the intent it
 * renders; this hook keeps only what the worker answered.
 */
export function useTransformPreview(
  intent: TransformIntent,
  observer?: TransformPreviewObserver,
) {
  const [source, setSource] = useState<PreviewSource | null>(null)
  const [analysis, setAnalysis] = useState<UprightAnalysis | null>(null)
  const [result, setResult] = useState<RenderedPreview | null>(null)
  // The Upright solutions the matrix is composed from. They are taken from
  // an analysis when a mode is solved, and kept across a refreshed frame so a
  // chosen Upright stays where it is.
  const [solutions, setSolutions] = useState<
    UprightAnalysis['solutions'] | null
  >(null)
  const modeRef = useRef(intent.upright)
  modeRef.current = intent.upright
  const observerRef = useRef(observer)
  observerRef.current = observer
  // The frame the client holds, for the size its answers were rendered on.
  const sourceRef = useRef<PreviewSource | null>(null)
  // Whether the frame under analysis refreshes the previous one in place.
  const preserveRef = useRef(false)
  const [loading, setLoading] = useState(false)
  const [rendering, setRendering] = useState(false)
  const [error, setError] = useState<TransformRenderFailure | null>(null)
  const [analysisMs, setAnalysisMs] = useState(0)
  // The newest render asked of the current frame, and the request whose
  // answer is on screen. Each keeps the geometry it was posted with.
  const [requested, setRequested] = useState<TransformRenderRequest | null>(
    null,
  )
  const [rendered, setRendered] = useState<TransformRenderRequest | null>(null)
  // The client publishes only replies to the newest frame and render, so
  // these handlers never see a superseded answer.
  const [client] = useState(() =>
    createTransformClient({
      analyzed(next, elapsedMs) {
        setError(null)
        setAnalysis(next)
        setSolutions((previous) =>
          preserveRef.current && modeRef.current !== 'off' && previous
            ? previous
            : next.solutions,
        )
        setAnalysisMs(elapsedMs)
        setLoading(false)
      },
      analysisFailed() {
        setError('processing')
        setLoading(false)
        observerRef.current?.frameFailed?.()
      },
      rendered(request, frame) {
        setResult(frame)
        // The frame carries the geometry its request was posted with,
        // whatever the controls have moved to since.
        setRendered(request)
        setError(null)
        setRendering(false)
        const loaded = sourceRef.current?.frame
        if (loaded)
          observerRef.current?.rendered?.(request, {
            width: loaded.width,
            height: loaded.height,
          })
      },
      renderFailed(request, failure) {
        setError(failure)
        setRendering(false)
        observerRef.current?.renderFailed?.(request, failure)
      },
      crashed() {
        setError('processing')
        setAnalysis(null)
        // The rendered frame cannot be refreshed without a worker, so it
        // must not survive as something the UI can report as current.
        setSolutions(null)
        setResult(null)
        setRendered(null)
        setLoading(false)
        setRendering(false)
        observerRef.current?.frameFailed?.()
      },
    }),
  )

  /**
   * Replace the frame under analysis. Everything answered for the previous
   * frame is retired; `preserveTransform` keeps the Upright solutions, so a
   * refreshed frame of the same photo re-renders the same geometry.
   */
  const loadSource = useCallback(
    (next: PreviewSource, { preserveTransform = false } = {}) => {
      preserveRef.current = preserveTransform
      sourceRef.current = next
      setLoading(true)
      setRendering(false)
      setError(null)
      setAnalysis(null)
      setResult(null)
      setRequested(null)
      setRendered(null)
      setSource(next)
      if (!preserveTransform) setSolutions(null)
      if (!client.load(next.frame)) {
        setError('processing')
        setLoading(false)
        observerRef.current?.frameFailed?.()
      }
    },
    [client],
  )

  const clearSource = useCallback(() => {
    client.clear()
    sourceRef.current = null
    setSource(null)
    setAnalysis(null)
    setSolutions(null)
    setResult(null)
    setRequested(null)
    setRendered(null)
    setError(null)
    setLoading(false)
    setRendering(false)
  }, [client])

  useEffect(() => () => client.dispose(), [client])

  const { upright: mode, manual, constrainCrop } = intent

  /**
   * The geometry the intent asks for. It is only a request: what reaches the
   * screen is `acknowledged`, and an export reproduces only an answer the
   * owner of the intent accepted.
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

  /** Ask the loaded frame for the geometry the controls ask for. */
  const requestRender = useCallback(() => {
    if (!source || !analysis || !solutions || !matrix) return
    const { request, posted } = client.render({ matrix, constrainCrop })
    setRequested(request)
    if (posted) setRendering(true)
    observerRef.current?.requested?.(request)
  }, [analysis, client, constrainCrop, matrix, solutions, source])

  useEffect(() => {
    requestRender()
  }, [requestRender])

  /**
   * The geometry of the frame on screen, while that frame answers the newest
   * request against the current source and the controls still ask for it.
   * Null while that request is pending, after it was refused, and before any
   * answer: a refused edit keeps the last valid frame on screen, but that
   * frame no longer answers what the controls ask.
   */
  const acknowledged = useMemo(
    () =>
      rendered &&
      requested &&
      matrix &&
      rendered.sourceId === requested.sourceId &&
      rendered.requestId === requested.requestId &&
      rendered.constrainCrop === constrainCrop &&
      rendered.matrix.every((value, index) => value === matrix[index])
        ? {
            sourceId: rendered.sourceId,
            requestId: rendered.requestId,
            matrix: rendered.matrix,
            constrainCrop: rendered.constrainCrop,
          }
        : null,
    [constrainCrop, matrix, rendered, requested],
  )

  /** Compose the Upright the intent names from the newest analysis. */
  const solveUpright = useCallback(() => {
    if (analysis) setSolutions(analysis.solutions)
  }, [analysis])

  /**
   * The intent moved away from the geometry that failed, so the failure it
   * raised must not outlive it; the render this queues re-reports any new
   * one.
   */
  const retireFailure = useCallback(() => setError(null), [])

  return {
    /**
     * The lifetime of the client this preview renders with. Its source and
     * request ids number work within that client only, so everything named
     * after a request also names this.
     */
    clientEpoch: client.epoch,
    source,
    analysis,
    result,
    loading,
    rendering,
    error,
    analysisMs,
    loadSource,
    clearSource,
    solveUpright,
    retireFailure,
    requestRender,
    matrix,
    acknowledged,
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
