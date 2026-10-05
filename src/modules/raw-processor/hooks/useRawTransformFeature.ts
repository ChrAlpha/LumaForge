import type { ExportGeometry } from '@lumaforge/render-engine/export'
import { planExportGeometry } from '@lumaforge/render-engine/export'
import type { CpuPreviewFrame } from '@lumaforge/render-engine/preview'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type {
  Matrix3,
  UprightMode,
} from '~/modules/transform-demo/geometry/types'
import type { ManualTransform } from '~/modules/transform-demo/transform-types'
import { NEUTRAL_TRANSFORM } from '~/modules/transform-demo/transform-types'
import { useTransformDemo } from '~/modules/transform-demo/useTransformDemo'

import {
  captureTransformSource,
  transformInputKey,
} from '../services/preview/capture-transform-source'
import type { UseRawWorkflowReturn } from './useRawWorkflow.types'

/**
 * Why a full-resolution export cannot reproduce the Transform the controls
 * ask for: its newest render has not been answered on a frame captured for
 * this RAW and its current inputs yet (`pending`), the worker or the export
 * engine refused the geometry (`invalid`), or the frame could not be
 * captured or processed (`unavailable`).
 */
export type TransformExportBlock = 'pending' | 'invalid' | 'unavailable'

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
  const demo = useTransformDemo({ autoLoadSample: false })
  const [observing, setObserving] = useState(false)
  const [cpuFrame, setCpuFrame] = useState<CpuPreviewFrame | null>(null)
  const [capturing, setCapturing] = useState(false)
  const [captureError, setCaptureError] = useState(false)
  const [showLines, setShowLines] = useState(false)
  const [showGrid, setShowGrid] = useState(false)
  // The RAW session and the inputs the demo's frame was captured for.
  const [captured, setCaptured] = useState<{
    sourceId: string
    key: string
  } | null>(null)
  const sourceId = workflow.previewTransform?.sourceId ?? null
  const lastSource = useRef<string | null>(null)
  const lastCapture = useRef<string | null>(null)
  const generation = useRef(0)
  const { loadSource, clearSource } = demo
  const image = workflow.decodedImageRef?.current
  const active = workflow.previewTransform?.active === true
  const activeRef = useRef(active)
  activeRef.current = active
  const intended = hasTransform(demo.mode, demo.manual)
  // A Transform the session does not hold yet still owns the export gate, so
  // its frame has to keep up with the photo after the panel closes.
  const needed = observing || active || intended
  const colorKey = sourceId
    ? transformInputKey(
        workflow.decodedImageVersion,
        workflow.lutDataVersion,
        workflow.params,
      )
    : ''
  const key = `${sourceId}|${colorKey}|${isCpuMode ? (cpuFrame?.requestId ?? 'none') : 'gpu'}`
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

  useEffect(() => {
    if (
      !needed ||
      !available ||
      !image ||
      !sourceId ||
      lastCapture.current === key
    ) {
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
        .then(async (source) => {
          if (generation.current !== token || lastSource.current !== sourceId)
            return
          lastCapture.current = key
          setCaptured({ sourceId, key })
          await loadSource(source, { preserveTransform: true })
        })
        .catch(() => {
          if (generation.current === token) setCaptureError(true)
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
    cpuFrame,
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
  const current =
    Boolean(demo.result) &&
    available &&
    lastCapture.current === key &&
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
    showOverlay:
      active ||
      (observing &&
        workflow.viewMode === 'processed' &&
        (showLines || showGrid)),
  }
}

export type RawTransformFeature = ReturnType<typeof useRawTransformFeature>
