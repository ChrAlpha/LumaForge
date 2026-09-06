import type { CpuPreviewFrame } from '@lumaforge/render-engine/preview'
import { useCallback, useEffect, useRef, useState } from 'react'

import type { UprightMode } from '~/modules/transform-demo/geometry/types'
import type { ManualTransform } from '~/modules/transform-demo/transform-types'
import { NEUTRAL_TRANSFORM } from '~/modules/transform-demo/transform-types'
import { usePreviewDownload } from '~/modules/transform-demo/usePreviewDownload'
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
  const [before, setBefore] = useState(false)
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
    setBefore(false)
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

  const setActiveRef = useRef(workflow.previewTransform?.setActive)
  setActiveRef.current = workflow.previewTransform?.setActive
  const disposeIntent = useCallback(() => {
    if (activeRef.current) setActiveRef.current?.(false)
  }, [])
  useEffect(() => disposeIntent, [disposeIntent])

  const observe = useCallback(() => {
    setObserving(true)
    return () => setObserving(false)
  }, [])

  const request = (mode: UprightMode, manual: ManualTransform) => {
    workflow.previewTransform?.setActive(hasTransform(mode, manual))
    workflow.setViewMode('processed')
    setBefore(false)
  }
  const setMode = (mode: UprightMode) => {
    request(mode, demo.manual)
    demo.setMode(mode)
  }
  const setManual = (manual: ManualTransform) => {
    request(demo.mode, manual)
    demo.setManual(manual)
  }
  const setConstrainCrop = (crop: boolean) => {
    request(demo.mode, demo.manual)
    demo.setConstrainCrop(crop)
  }
  const reset = () => {
    workflow.previewTransform?.setActive(false)
    demo.reset()
    setBefore(false)
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
  const download = usePreviewDownload(
    current ? demo.result?.frame : undefined,
    workflow.sourceFileName,
  )

  return {
    demo,
    active,
    available,
    hasImage: workflow.hasImage,
    observe,
    busy: capturing || demo.loading || demo.rendering || (active && !current),
    captureError,
    current,
    before,
    setBefore: (value: boolean) => {
      workflow.setViewMode('processed')
      setBefore(value)
    },
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
        (before || showLines || showGrid)),
    ...download,
  }
}

export type RawTransformFeature = ReturnType<typeof useRawTransformFeature>
