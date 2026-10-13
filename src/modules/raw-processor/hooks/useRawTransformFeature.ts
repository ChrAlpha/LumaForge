import type { CpuPreviewFrame } from '@lumaforge/render-engine/preview'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type { UprightMode } from '~/lib/transform/geometry/types'
import type { PreviewSource } from '~/lib/transform/preview-types'
import type { TransformRenderRequest } from '~/lib/transform/transform-client'
import type { ManualTransform } from '~/lib/transform/transform-types'

import type { TransformIntent } from '../model/session'
import { createNeutralTransformIntent } from '../model/session-factory'
import {
  captureTransformSource,
  decodedFrameIdentity,
  transformInputKey,
} from '../services/preview/capture-transform-source'
import type {
  TransformEvent,
  TransformExportBlock,
} from '../services/transform/transform-state'
import {
  deriveTransformStatus,
  heldTransformGeometry,
  isNeutralTransformIntent,
} from '../services/transform/transform-state'
import type { UseRawWorkflowReturn } from './useRawWorkflow.types'
import type { TransformPreviewObserver } from './useTransformPreview'
import { useTransformPreview } from './useTransformPreview'

interface CapturedFrame {
  sourceId: string
  /** The decoded source the frame was drawn from. */
  decodedKey: string
  /** That source as processed when the frame was read back. */
  key: string
}

/** The intent shown while no RAW is loaded; nothing can edit it. */
const NO_SOURCE_INTENT = createNeutralTransformIntent()

function geometryOf(request: TransformRenderRequest) {
  return {
    matrix: Array.from(request.matrix),
    constrainCrop: request.constrainCrop,
  }
}

export function useRawTransformFeature(
  workflow: UseRawWorkflowReturn,
  isCpuMode: boolean,
) {
  // The session owns the intent and what was accepted for it; this hook
  // owns only the frame, the worker and what is drawn over the photo.
  const transformState = workflow.transform?.state ?? null
  const sourceId = transformState?.sourceId ?? null
  const intent = transformState?.intent ?? NO_SOURCE_INTENT
  const dispatchRef = useRef(workflow.transform?.dispatch)
  dispatchRef.current = workflow.transform?.dispatch
  const dispatch = useCallback(
    (event: TransformEvent) => dispatchRef.current?.(event),
    [],
  )
  const [observing, setObserving] = useState(false)
  // The processed frame the CPU stage shows, and whether its next frame is
  // still rendering. A frame being replaced keeps the Transform available;
  // only a settled one is the photo as it now looks, and only that one is
  // captured.
  const [cpuFrame, setCpuFrameShown] = useState<CpuPreviewFrame | null>(null)
  const [cpuRendering, setCpuRendering] = useState(false)
  const setCpuFrame = useCallback(
    (frame: CpuPreviewFrame | null, rendering = false) => {
      setCpuFrameShown(frame)
      setCpuRendering(frame !== null && rendering)
    },
    [],
  )
  const settledCpuFrame = cpuRendering ? null : cpuFrame
  const [capturing, setCapturing] = useState(false)
  const [captureError, setCaptureError] = useState(false)
  const [showLines, setShowLines] = useState(false)
  const [showGrid, setShowGrid] = useState(false)
  // The decoded source and the processed frame the preview's frame was
  // captured from, for this RAW session.
  const [captured, setCaptured] = useState<CapturedFrame | null>(null)
  const lastSource = useRef<string | null>(null)
  // The capture the preview holds; null asks the next pass to capture again.
  const lastCapture = useRef<Omit<CapturedFrame, 'sourceId'> | null>(null)
  // The source and inputs of the frame handed to the preview, and the client
  // lifetime it was handed to. Every request posted on that frame, and every
  // answer to one, is named after it.
  const loadedFrame = useRef<{
    sourceId: string
    key: string
    clientEpoch: number
  } | null>(null)
  // The frame a capture loaded, until its analysis lands. Matching the frame
  // tells that analysis apart from the one it replaces.
  const analysing = useRef<PreviewSource | null>(null)
  const generation = useRef(0)
  const observer = useMemo<TransformPreviewObserver>(
    () => ({
      requested(request) {
        const frame = loadedFrame.current
        if (!frame) return
        dispatch({
          type: 'request',
          sourceId: frame.sourceId,
          captureKey: frame.key,
          clientEpoch: frame.clientEpoch,
          requestId: request.requestId,
          geometry: geometryOf(request),
        })
      },
      rendered(request, size) {
        const frame = loadedFrame.current
        if (!frame) return
        dispatch({
          type: 'rendered',
          sourceId: frame.sourceId,
          captureKey: frame.key,
          clientEpoch: frame.clientEpoch,
          requestId: request.requestId,
          geometry: geometryOf(request),
          frame: size,
        })
      },
      renderFailed(request, failure) {
        const frame = loadedFrame.current
        if (!frame) return
        dispatch({
          type: 'render-failed',
          sourceId: frame.sourceId,
          captureKey: frame.key,
          clientEpoch: frame.clientEpoch,
          requestId: request.requestId,
          failure,
        })
      },
      frameFailed() {
        const frame = loadedFrame.current
        if (!frame) return
        dispatch({
          type: 'capture-failed',
          sourceId: frame.sourceId,
          captureKey: frame.key,
          clientEpoch: frame.clientEpoch,
        })
      },
    }),
    [dispatch],
  )
  // The client lifetime names every capture and request of this preview; the
  // tool surfaces read only what the preview shows.
  const transformPreview = useTransformPreview(intent, observer)
  const { clientEpoch, ...preview } = transformPreview
  const {
    loadSource,
    clearSource,
    source: loaded,
    analysis: analysed,
    error: previewError,
    solveUpright,
    retireFailure,
    requestRender,
  } = preview
  const image = workflow.decodedImageRef?.current
  const active = transformState
    ? heldTransformGeometry(transformState) !== null
    : false
  const activeRef = useRef(active)
  activeRef.current = active
  const intended = !isNeutralTransformIntent(intent)
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
  // names that source on every finished frame, so its frames keep their own
  // source and request identity and never have to be the workflow's newest
  // frame. WebGPU renders each accepted frame, named by the descriptor the
  // workflow minted for it. Switching executor is a new source as well.
  const decodedFrame = workflow.decodedFrame
  const decodedKey = `${sourceId}|${isCpuMode ? `cpu:${cpuFrame?.sourceId ?? 'none'}` : `gpu:${decodedFrameIdentity(decodedFrame)}`}`
  const colorKey = sourceId
    ? transformInputKey(decodedFrame, workflow.lutDataVersion, workflow.params)
    : ''
  const key = `${decodedKey}|${colorKey}|${isCpuMode ? (settledCpuFrame?.requestId ?? 'none') : 'gpu'}`
  const previewSuspended = workflow.previewSuspended === true
  const available = Boolean(
    sourceId &&
    image &&
    !previewSuspended &&
    // The CPU stage is keyed by RAW session and retains its quick frame
    // when an HQ decode replaces the workflow's image reference. WebGPU
    // draws only a frame the workflow accepted.
    (isCpuMode ? cpuFrame : decodedFrame && workflow.pipelineRef.current),
  )

  useEffect(() => {
    if (lastSource.current === sourceId) return
    lastSource.current = sourceId
    lastCapture.current = null
    loadedFrame.current = null
    generation.current++
    clearSource()
    setCaptured(null)
    setCpuFrame(null)
    setCapturing(false)
    setCaptureError(false)
    setShowLines(false)
    setShowGrid(false)
  }, [clearSource, setCpuFrame, sourceId])

  const invalidateCapture = useCallback(() => {
    generation.current++
  }, [])

  // A frame the worker crashed on or could not analyse is no frame to keep:
  // the next change of input captures again. A refused geometry is the
  // geometry's failure, not the frame's.
  useEffect(() => {
    if (previewError && previewError !== 'transform') lastCapture.current = null
  }, [previewError])

  // An answer counts only on a frame read with the inputs the photo has now
  // and held by this preview's client, so a Transform the controls ask for is
  // pending from the moment they move on. An export releases the preview, so
  // its inputs move on with no capture to follow them; the answers given
  // before the export still stand.
  const sessionCapture = transformState?.capture ?? null
  const sessionCaptureKey = sessionCapture?.key ?? null
  const sessionCaptureEpoch = sessionCapture?.clientEpoch ?? null
  useEffect(() => {
    if (!sourceId || !intended || previewSuspended) return
    if (sessionCaptureKey === key && sessionCaptureEpoch === clientEpoch) return
    dispatch({ type: 'capture', sourceId, captureKey: key, clientEpoch })
    // The loaded frame already shows these inputs, so no capture follows it:
    // that frame is asked again.
    const frame = loadedFrame.current
    if (frame?.sourceId === sourceId && frame.key === key) requestRender()
  }, [
    clientEpoch,
    dispatch,
    intended,
    key,
    previewSuspended,
    requestRender,
    sessionCaptureEpoch,
    sessionCaptureKey,
    sourceId,
  ])

  useEffect(() => {
    const last = lastCapture.current
    const stale =
      !last ||
      last.decodedKey !== decodedKey ||
      (colorNeeded && last.key !== key)
    const unsettled = isCpuMode && !settledCpuFrame
    if (!needed || !available || unsettled || !image || !sourceId || !stale) {
      setCapturing(false)
      return
    }
    const token = ++generation.current
    setCapturing(true)
    setCaptureError(false)
    // The frame this reads back replaces the one earlier answers were given
    // on, from now on.
    dispatch({ type: 'capture', sourceId, captureKey: key, clientEpoch })
    const timer = setTimeout(() => {
      void captureTransformSource({
        width: image.width,
        height: image.height,
        pipeline: isCpuMode ? null : workflow.pipelineRef.current,
        cpuFrame: isCpuMode ? settledCpuFrame : null,
      })
        .then((source) => {
          if (generation.current !== token || lastSource.current !== sourceId)
            return
          lastCapture.current = { decodedKey, key }
          loadedFrame.current = { sourceId, key, clientEpoch }
          setCaptured({ sourceId, decodedKey, key })
          analysing.current = source
          loadSource(source, { preserveTransform: true })
        })
        .catch(() => {
          if (generation.current !== token) return
          // The preview still holds the earlier frame, but the next change of
          // input has to try again rather than trust it.
          lastCapture.current = null
          setCaptureError(true)
          dispatch({
            type: 'capture-failed',
            sourceId,
            captureKey: key,
            clientEpoch,
          })
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
    clientEpoch,
    colorNeeded,
    decodedKey,
    dispatch,
    image,
    invalidateCapture,
    isCpuMode,
    key,
    loadSource,
    needed,
    settledCpuFrame,
    sourceId,
    workflow.pipelineRef,
    workflow.previewFacts,
  ])

  // A new frame keeps the Upright solutions the preview holds, so an
  // accepted geometry stays where it is when only the colour moves on. With
  // nothing accepted, the Upright the controls ask for is solved again on the
  // frame captured for it, which is the photo as it now looks.
  const uprightMode = intent.upright
  useEffect(() => {
    if (!analysed || loaded !== analysing.current) return
    analysing.current = null
    if (!activeRef.current && uprightMode !== 'off') solveUpright()
  }, [analysed, loaded, solveUpright, uprightMode])

  // Leaving the workspace ends the Transform: nothing keeps its frame up with
  // the photo any more, so the session must not keep asking for it.
  const sourceIdRef = useRef(sourceId)
  sourceIdRef.current = sourceId
  const disposeIntent = useCallback(() => {
    const id = sourceIdRef.current
    if (id) dispatchRef.current?.({ type: 'reset', sourceId: id })
  }, [])
  useEffect(() => disposeIntent, [disposeIntent])

  /**
   * Export may reproduce the Transform only once the session accepted the
   * preview's answer to the newest request on a frame of the photo as it now
   * looks; until then the session keeps the last accepted geometry, and
   * export is blocked. A neutral Transform needs no render. Releasing the
   * preview after an export changes none of this, so a finished export never
   * reads as a blocked one.
   */
  const status = transformState
    ? deriveTransformStatus(transformState)
    : 'neutral'
  const exportBlock: TransformExportBlock | null =
    status === 'neutral' || status === 'accepted' ? null : status

  const observe = useCallback(() => {
    setObserving(true)
    return () => setObserving(false)
  }, [])

  const edit = (next: Partial<TransformIntent>) => {
    if (sourceId) dispatch({ type: 'edit', sourceId, intent: next })
  }
  const request = () => {
    workflow.setViewMode('processed')
  }
  // The commands keep their identity for as long as the feature is mounted,
  // so a surface that holds them skips every render that moves nothing it
  // shows; each one runs what the latest render would.
  const latestCommands = {
    setMode: (mode: UprightMode) => {
      request()
      edit({ upright: mode })
      solveUpright()
    },
    setManual: (manual: ManualTransform) => {
      request()
      edit({ manual })
    },
    setConstrainCrop: (crop: boolean) => {
      request()
      edit({ constrainCrop: crop })
    },
    reset: () => {
      if (sourceId) dispatch({ type: 'reset', sourceId })
      retireFailure()
      setShowLines(false)
      setShowGrid(false)
    },
    setShowLines: (value: boolean) => {
      workflow.setViewMode('processed')
      setShowLines(value)
    },
    setShowGrid: (value: boolean) => {
      workflow.setViewMode('processed')
      setShowGrid(value)
    },
  }
  const commandsRef = useRef(latestCommands)
  commandsRef.current = latestCommands
  const [commands] = useState(() => ({
    setMode: (mode: UprightMode) => commandsRef.current.setMode(mode),
    setManual: (manual: ManualTransform) =>
      commandsRef.current.setManual(manual),
    setConstrainCrop: (crop: boolean) =>
      commandsRef.current.setConstrainCrop(crop),
    reset: () => commandsRef.current.reset(),
    setShowLines: (value: boolean) => commandsRef.current.setShowLines(value),
    setShowGrid: (value: boolean) => commandsRef.current.setShowGrid(value),
  }))
  // The preview's frame is the photo the tool works on: the same decoded
  // source, and the same colour wherever the colour counts.
  const frameMatches =
    captured !== null &&
    captured.sourceId === sourceId &&
    (colorNeeded ? captured.key === key : captured.decodedKey === decodedKey)
  const current =
    Boolean(preview.result) &&
    available &&
    frameMatches &&
    !capturing &&
    !preview.loading &&
    !preview.rendering &&
    !preview.error &&
    !captureError

  // What the preview shows, with the intent the session holds.
  const previewView = useMemo(() => {
    // The client epoch names the worker the preview renders with, which
    // only the capture above reads; keyed by the hook's own result, the view
    // keeps its identity while that result does.
    const { clientEpoch: _clientEpoch, ...shown } = transformPreview
    return {
      ...shown,
      mode: intent.upright,
      manual: intent.manual,
      constrainCrop: intent.constrainCrop,
    }
  }, [intent.constrainCrop, intent.manual, intent.upright, transformPreview])
  const busy =
    capturing || preview.loading || preview.rendering || (active && !current)
  const { hasImage } = workflow

  return useMemo(
    () => ({
      preview: previewView,
      active,
      available,
      // Export releases the preview to keep the delivered file stable. That
      // is a different state from "not ready yet", and it has its own way
      // out.
      previewSuspended,
      hasImage,
      observe,
      busy,
      captureError,
      current,
      exportBlock,
      showLines,
      showGrid,
      ...commands,
      setCpuFrame,
      showOverlay,
    }),
    [
      active,
      available,
      busy,
      captureError,
      commands,
      current,
      exportBlock,
      hasImage,
      observe,
      previewSuspended,
      previewView,
      setCpuFrame,
      showGrid,
      showLines,
      showOverlay,
    ],
  )
}

export type RawTransformFeature = ReturnType<typeof useRawTransformFeature>
