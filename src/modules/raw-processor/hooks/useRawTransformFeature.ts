import type { CpuPreviewFrame } from '@lumaforge/render-engine/preview'
import { useCallback, useEffect, useRef, useState } from 'react'

import type { UprightMode } from '~/modules/transform-demo/geometry/types'
import type { ManualTransform } from '~/modules/transform-demo/transform-types'
import { NEUTRAL_TRANSFORM } from '~/modules/transform-demo/transform-types'
import { useTransformDemo } from '~/modules/transform-demo/useTransformDemo'

import {
  captureTransformSource,
  transformInputKey,
} from '../services/preview/capture-transform-source'
import type { UseRawWorkflowReturn } from './useRawWorkflow.types'

function hasTransform(mode: UprightMode, manual: ManualTransform) {
  return (
    mode !== 'off' ||
    (Object.keys(NEUTRAL_TRANSFORM) as Array<keyof ManualTransform>).some(
      (key) => manual[key] !== NEUTRAL_TRANSFORM[key],
    )
  )
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
  const sourceId = workflow.previewTransform?.sourceId ?? null
  const lastSource = useRef<string | null>(null)
  const lastCapture = useRef<string | null>(null)
  const generation = useRef(0)
  const { loadSource, clearSource } = demo
  const image = workflow.decodedImageRef?.current
  const active = workflow.previewTransform?.active === true
  const activeRef = useRef(active)
  activeRef.current = active
  const needed = observing || active
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
   * Commit the geometry the preview is showing, so a full-resolution export
   * reproduces it. Committing from an effect (rather than from each control)
   * keeps the session in step with the matrix that actually rendered instead
   * of one assembled a moment before the demo state caught up.
   */
  const committed =
    hasTransform(demo.mode, demo.manual) && demo.matrix
      ? { matrix: Array.from(demo.matrix), constrainCrop: demo.constrainCrop }
      : null
  const committedKey = committed ? JSON.stringify(committed) : null
  const lastCommitted = useRef<string | null>(null)
  useEffect(() => {
    if (lastCommitted.current === committedKey) return
    lastCommitted.current = committedKey
    commitRef.current?.(committedKey ? JSON.parse(committedKey) : null)
  }, [committedKey])

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
