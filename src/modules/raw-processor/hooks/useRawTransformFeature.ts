import type { ExportGeometry } from '@lumaforge/render-engine/export'
import { planExportGeometry } from '@lumaforge/render-engine/export'
import type { Matrix3 } from '@lumaforge/render-engine/geometry'
import type { CpuPreviewFrame } from '@lumaforge/render-engine/preview'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type { UprightMode } from '~/lib/transform/geometry/types'
import type { PreviewSource } from '~/lib/transform/preview-types'
import type { ManualTransform } from '~/lib/transform/transform-types'
import { NEUTRAL_TRANSFORM } from '~/lib/transform/transform-types'

import {
  captureTransformSource,
  transformInputKey,
} from '../services/preview/capture-transform-source'
import type { UseRawWorkflowReturn } from './useRawWorkflow.types'
import { useTransformPreview } from './useTransformPreview'

/**
 * Why a full-resolution export cannot reproduce the Transform the controls
 * ask for: its newest render has not been answered on a frame captured for
 * this RAW and its current inputs yet (`pending`), the worker or the export
 * engine refused the geometry (`invalid`), or the frame could not be
 * captured or processed (`unavailable`).
 */
export type TransformExportBlock = 'pending' | 'invalid' | 'unavailable'

interface CapturedFrame {
  sourceId: string
  /** The decoded source the frame was drawn from. */
  decodedKey: string
  /** That source as processed when the frame was read back. */
  key: string
}

function hasTransform(mode: UprightMode, manual: ManualTransform) {
  return (
    mode !== 'off' ||
    (Object.keys(NEUTRAL_TRANSFORM) as Array<keyof ManualTransform>).some(
      (key) => manual[key] !== NEUTRAL_TRANSFORM[key],
    )
  )
}

function geometryKey(geometry: ExportGeometry | null) {
  return geometry
    ? JSON.stringify({
        matrix: Array.from(geometry.matrix),
        constrainCrop: geometry.constrainCrop,
      })
    : null
}

/**
 * The answered geometry as the session stores it, or null when the export
 * engine would refuse to plan it. Planning is resolution independent, so the
 * preview frame stands in for the sensor.
 */
function plannedGeometry(
  answered: { matrix: Matrix3; constrainCrop: boolean },
  frame: { width: number; height: number },
): ExportGeometry | null {
  const geometry = {
    matrix: Array.from(answered.matrix),
    constrainCrop: answered.constrainCrop,
  }
  try {
    planExportGeometry(geometry, frame)
    return geometry
  } catch {
    return null
  }
}

export function useRawTransformFeature(
  workflow: UseRawWorkflowReturn,
  isCpuMode: boolean,
) {
  const demo = useTransformPreview()
  const [observing, setObserving] = useState(false)
  const [cpuFrame, setCpuFrame] = useState<CpuPreviewFrame | null>(null)
  const [capturing, setCapturing] = useState(false)
  const [captureError, setCaptureError] = useState(false)
  const [showLines, setShowLines] = useState(false)
  const [showGrid, setShowGrid] = useState(false)
  // The decoded source and the processed frame the demo's frame was captured
  // from, for this RAW session.
  const [captured, setCaptured] = useState<CapturedFrame | null>(null)
  const sourceId = workflow.previewTransform?.sourceId ?? null
  const lastSource = useRef<string | null>(null)
  // The capture the demo holds; null asks the next pass to capture again.
  const lastCapture = useRef<Omit<CapturedFrame, 'sourceId'> | null>(null)
  // The frame a capture loaded, until its analysis lands. Matching the frame
  // tells that analysis apart from the one it replaces.
  const analysing = useRef<PreviewSource | null>(null)
  const generation = useRef(0)
  const {
    loadSource,
    clearSource,
    source: loaded,
    analysis: analysed,
    error: demoError,
    mode: uprightMode,
    setMode: selectUpright,
  } = demo
  const image = workflow.decodedImageRef?.current
  const active = workflow.previewTransform?.active === true
  const activeRef = useRef(active)
  activeRef.current = active
  const intended = hasTransform(demo.mode, demo.manual)
  // A Transform the session does not hold yet still owns the export gate, so
  // its frame has to keep up with the photo after the panel closes.
  const needed = observing || active || intended
  const showOverlay =
    active ||
    (observing && workflow.viewMode === 'processed' && (showLines || showGrid))
  // The frame's colour counts only where it is seen or a geometry is answered
  // on it. A neutral analysis needs the decoded source alone, so tone, colour,
  // LUT and strength edits do not read the frame back and analyse it again.
  const colorNeeded = intended || showOverlay
  // The CPU stage keeps rendering its quick source across HQ decodes and
  // names that source on every finished frame; WebGPU renders each decode.
  // Switching executor is a new source as well.
  const decodedKey = `${sourceId}|${isCpuMode ? `cpu:${cpuFrame?.sourceId ?? 'none'}` : `gpu:${workflow.decodedImageVersion}`}`
  const colorKey = sourceId
    ? transformInputKey(
        workflow.decodedImageVersion,
        workflow.lutDataVersion,
        workflow.params,
      )
    : ''
  const key = `${decodedKey}|${colorKey}|${isCpuMode ? (cpuFrame?.requestId ?? 'none') : 'gpu'}`
  const available = Boolean(
    sourceId &&
    image &&
    !workflow.previewSuspended &&
    // The CPU stage is keyed by RAW session and retains its quick frame
    // when an HQ decode replaces the workflow's image reference.
    (isCpuMode ? cpuFrame : workflow.pipelineRef.current),
  )

  useEffect(() => {
    if (lastSource.current === sourceId) return
    lastSource.current = sourceId
    lastCapture.current = null
    generation.current++
    clearSource()
    setCaptured(null)
    setCpuFrame(null)
    setCapturing(false)
    setCaptureError(false)
    setShowLines(false)
    setShowGrid(false)
  }, [clearSource, sourceId])

  const invalidateCapture = useCallback(() => {
    generation.current++
  }, [])

  // A frame the worker crashed on or could not analyse is no frame to keep:
  // the next change of input captures again. A refused geometry is the
  // geometry's failure, not the frame's.
  useEffect(() => {
    if (demoError && demoError !== 'transform') lastCapture.current = null
  }, [demoError])

  useEffect(() => {
    const last = lastCapture.current
    const stale =
      !last ||
      last.decodedKey !== decodedKey ||
      (colorNeeded && last.key !== key)
    if (!needed || !available || !image || !sourceId || !stale) {
      setCapturing(false)
      return
    }
    const token = ++generation.current
    setCapturing(true)
    setCaptureError(false)
    const timer = setTimeout(() => {
      void captureTransformSource({
        width: image.width,
        height: image.height,
        name: workflow.sourceFileName,
        pipeline: isCpuMode ? null : workflow.pipelineRef.current,
        cpuFrame: isCpuMode ? cpuFrame : null,
      })
        .then((source) => {
          if (generation.current !== token || lastSource.current !== sourceId)
            return
          lastCapture.current = { decodedKey, key }
          setCaptured({ sourceId, decodedKey, key })
          analysing.current = source
          loadSource(source, { preserveTransform: true })
        })
        .catch(() => {
          if (generation.current !== token) return
          // The demo still holds the earlier frame, but the next change of
          // input has to try again rather than trust it.
          lastCapture.current = null
          setCaptureError(true)
        })
        .finally(() => {
          if (generation.current === token) setCapturing(false)
        })
    }, 120)
    return () => {
      clearTimeout(timer)
      invalidateCapture()
    }
  }, [
    available,
    colorNeeded,
    cpuFrame,
    decodedKey,
    image,
    invalidateCapture,
    isCpuMode,
    key,
    loadSource,
    needed,
    sourceId,
    workflow.pipelineRef,
    workflow.sourceFileName,
    workflow.stats,
  ])

  // A new frame keeps the Upright solutions the demo holds, so a committed
  // geometry stays where it is when only the colour moves on. With nothing
  // committed, the Upright the controls ask for is solved again on the
  // frame captured for it, which is the photo as it now looks.
  useEffect(() => {
    if (!analysed || loaded !== analysing.current) return
    analysing.current = null
    if (!activeRef.current && uprightMode !== 'off') selectUpright(uprightMode)
  }, [analysed, loaded, selectUpright, uprightMode])

  const commitRef = useRef(workflow.previewTransform?.commit)
  commitRef.current = workflow.previewTransform?.commit
  const disposeIntent = useCallback(() => {
    if (activeRef.current) commitRef.current?.(null)
  }, [])
  useEffect(() => disposeIntent, [disposeIntent])

  /**
   * Commit only the geometry the preview has rendered, so a full-resolution
   * export reproduces the framing on screen. The answer has to come from the
   * frame captured for this RAW and its current inputs, answer the newest
   * request, and plan in the export engine; until then the session keeps
   * what it holds, which is the last valid geometry, and export is blocked.
   * A neutral Transform needs no render: it clears the geometry at once.
   */
  // An export releases the preview, so its inputs move on with no capture to
  // follow them; the frame that answered before the export still stands.
  const frameCurrent =
    captured !== null &&
    captured.sourceId === sourceId &&
    (captured.key === key || workflow.previewSuspended === true)
  const answered = frameCurrent ? demo.acknowledged : null
  const frame = demo.source?.frame
  const planned = useMemo(
    () => (answered && frame ? plannedGeometry(answered, frame) : null),
    [answered, frame],
  )
  const targetKey = !intended
    ? null
    : planned
      ? geometryKey(planned)
      : undefined
  const sessionKey = geometryKey(workflow.previewTransform?.geometry ?? null)
  useEffect(() => {
    if (targetKey === undefined || targetKey === sessionKey) return
    commitRef.current?.(targetKey === null ? null : JSON.parse(targetKey))
  }, [sessionKey, targetKey])
  // Export is blocked whenever the session does not hold what the controls
  // ask for on the current frame. Until a new frame is captured, what the old
  // one said no longer counts. Releasing the preview after an export changes
  // none of this, so a finished export never reads as a blocked one.
  const exportBlock: TransformExportBlock | null =
    targetKey === sessionKey
      ? null
      : !frameCurrent
        ? captureError
          ? 'unavailable'
          : 'pending'
        : demo.error === 'transform' || (answered && !planned)
          ? 'invalid'
          : demo.error || captureError
            ? 'unavailable'
            : 'pending'

  const observe = useCallback(() => {
    setObserving(true)
    return () => setObserving(false)
  }, [])

  const request = () => {
    workflow.setViewMode('processed')
  }
  const setMode = (mode: UprightMode) => {
    request()
    demo.setMode(mode)
  }
  const setManual = (manual: ManualTransform) => {
    request()
    demo.setManual(manual)
  }
  const setConstrainCrop = (crop: boolean) => {
    request()
    demo.setConstrainCrop(crop)
  }
  const reset = () => {
    demo.reset()
    setShowLines(false)
    setShowGrid(false)
  }
  // The demo's frame is the photo the tool works on: the same decoded source,
  // and the same colour wherever the colour counts.
  const frameMatches =
    captured !== null &&
    captured.sourceId === sourceId &&
    (colorNeeded ? captured.key === key : captured.decodedKey === decodedKey)
  const current =
    Boolean(demo.result) &&
    available &&
    frameMatches &&
    !capturing &&
    !demo.loading &&
    !demo.rendering &&
    !demo.error &&
    !captureError

  return {
    demo,
    active,
    available,
    // Export releases the preview to keep the delivered file stable. That is a
    // different state from "not ready yet", and it has its own way out.
    previewSuspended: workflow.previewSuspended === true,
    hasImage: workflow.hasImage,
    observe,
    busy: capturing || demo.loading || demo.rendering || (active && !current),
    captureError,
    current,
    exportBlock,
    showLines,
    setShowLines: (value: boolean) => {
      workflow.setViewMode('processed')
      setShowLines(value)
    },
    showGrid,
    setShowGrid: (value: boolean) => {
      workflow.setViewMode('processed')
      setShowGrid(value)
    },
    setMode,
    setManual,
    setConstrainCrop,
    reset,
    setCpuFrame,
    isProcessing:
      workflow.status === 'exporting' ||
      workflow.status === 'loading' ||
      workflow.status === 'decoding',
    showOverlay,
  }
}

export type RawTransformFeature = ReturnType<typeof useRawTransformFeature>
