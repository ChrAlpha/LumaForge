import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { identityMatrix } from '~/lib/transform/geometry/matrix'
import type {
  UprightAnalysis,
  UprightMode,
} from '~/lib/transform/geometry/types'
import type { PreviewSource } from '~/lib/transform/preview-types'
import type {
  TransformRenderFailure,
  TransformRenderRequest,
} from '~/lib/transform/transform-client'
import { createTransformClient } from '~/lib/transform/transform-client'
import { composeManualTransform } from '~/lib/transform/transform-render'
import type {
  ManualTransform,
  RenderedPreview,
} from '~/lib/transform/transform-types'
import { NEUTRAL_TRANSFORM } from '~/lib/transform/transform-types'

/**
 * Why the preview cannot show the geometry the controls ask for: the worker
 * refused it (`transform`), or the frame could not be analysed or rendered
 * at all (`processing`).
 */
type TransformPreviewError = TransformRenderFailure

/**
 * Upright analysis and transformed rendering of one preview frame at a time,
 * off the main thread. The caller hands it frames; it never decodes files.
 */
export function useTransformPreview() {
  const [source, setSource] = useState<PreviewSource | null>(null)
  const [analysis, setAnalysis] = useState<UprightAnalysis | null>(null)
  const [result, setResult] = useState<RenderedPreview | null>(null)
  const [mode, setModeState] = useState<UprightMode>('off')
  const [solutions, setSolutions] = useState<
    UprightAnalysis['solutions'] | null
  >(null)
  const modeRef = useRef(mode)
  // Whether the frame under analysis refreshes the previous one in place.
  const preserveRef = useRef(false)
  const [manual, setManual] = useState<ManualTransform>(NEUTRAL_TRANSFORM)
  const [constrainCrop, setConstrainCrop] = useState(true)
  const [loading, setLoading] = useState(false)
  const [rendering, setRendering] = useState(false)
  const [error, setError] = useState<TransformPreviewError | null>(null)
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
      },
      rendered(request, frame) {
        setResult(frame)
        // The frame carries the geometry its request was posted with,
        // whatever the controls have moved to since.
        setRendered(request)
        setError(null)
        setRendering(false)
      },
      renderFailed(_request, failure) {
        setError(failure)
        setRendering(false)
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
      },
    }),
  )

  /**
   * Replace the frame under analysis. Everything answered for the previous
   * frame is retired; `preserveTransform` keeps the controls where they are,
   * so a refreshed frame of the same photo re-renders the same geometry.
   */
  const loadSource = useCallback(
    (next: PreviewSource, { preserveTransform = false } = {}) => {
      preserveRef.current = preserveTransform
      setLoading(true)
      setRendering(false)
      setError(null)
      setAnalysis(null)
      setResult(null)
      setRequested(null)
      setRendered(null)
      setSource(next)
      if (!preserveTransform) {
        setModeState('off')
        modeRef.current = 'off'
        setSolutions(null)
        setManual(NEUTRAL_TRANSFORM)
        setConstrainCrop(true)
      }
      if (!client.load(next.frame)) {
        setError('processing')
        setLoading(false)
      }
    },
    [client],
  )

  const clearSource = useCallback(() => {
    client.clear()
    setSource(null)
    setAnalysis(null)
    setSolutions(null)
    setResult(null)
    setRequested(null)
    setRendered(null)
    setError(null)
    setLoading(false)
    setRendering(false)
    setModeState('off')
    modeRef.current = 'off'
    setManual(NEUTRAL_TRANSFORM)
    setConstrainCrop(true)
  }, [client])

  useEffect(() => () => client.dispose(), [client])

  /**
   * The geometry the controls ask for. It is only a request: what reaches the
   * screen, and what an export may reproduce, is `acknowledged`.
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
    const { request, posted } = client.render({ matrix, constrainCrop })
    setRequested(request)
    if (posted) setRendering(true)
  }, [analysis, client, constrainCrop, matrix, solutions, source])

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
