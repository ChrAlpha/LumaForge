import type { ColorGraphIntent, LUTData } from '@lumaforge/luma-color-runtime'
import type { MutableRefObject } from 'react'
import { useCallback } from 'react'
import { toast as sonnerToast } from 'sonner'

import type { DecodedImage } from '~/lib/raw/decoder'
import type { RawProcessingPipeline } from '~/lib/webgpu/raw-processing-pipeline'

import type {
  ExportCopyCapability,
  ExportResult,
  HqPreviewExportReasonCode,
} from '../../../model/export-result'
import type { ImageSession } from '../../../model/session'
import type { ProcessingStatus } from '../../../model/workflow'
import { deriveTransformExportRefusalReason } from '../../../services/export/export-readiness'
import {
  resolveExportCopyCapability,
  unavailableExportCopy,
} from '../../../services/export/export-result-actions'
import { captureExportResultIdentity } from '../../../services/export/export-result-identity'
import { createCompletedExportResult } from '../../../services/export/export-result-materialization'
import {
  beginExportAttempt,
  clearExportResultState,
  isExportAttemptLive,
  patchExportState,
} from '../../../services/export/export-state'
import {
  buildPreviewExportFilename,
  EXPORT_JPEG_QUALITY,
  resolveHqPreviewExportSize,
  runPreviewExportJob,
} from '../../../services/export/export-system'
import { resolveHqPreviewLookRefusal } from '../../../services/export/hq-preview-look'
import { pipelineHoldsLook } from '../../../services/preview/pipeline-holds-look'
import { HQ_PREVIEW_EXPORT_REASON_COPY } from '../../../services/surface/raw-reason'
import type { SetImageSession } from '../../../state/session.atoms'
import { useLatestTranslate } from '../../useLatestTranslate'

type HqPreviewPipeline = Pick<
  RawProcessingPipeline,
  'renderToHiddenCanvas' | 'getParams' | 'getLutData'
>

type HqPreviewExportToast = {
  success: (message: string) => void
  error: (message: string, options?: { description?: string }) => void
}

type UseHqPreviewExportActionInput = {
  /** Reads the session from the store when called. */
  getSession: () => ImageSession | null
  /** Reads the color intent the photo renders with from the store when called. */
  getColorIntent: () => ColorGraphIntent
  /** Reads the LUT the store holds when called. */
  getLutData: () => LUTData | null
  decodedImageRef: MutableRefObject<DecodedImage | null>
  pipelineRef: MutableRefObject<HqPreviewPipeline | null>
  isMountedRef: MutableRefObject<boolean>
  exportGraphVersionRef: MutableRefObject<number>
  exportAbortControllerRef: MutableRefObject<AbortController | null>
  previewSuspended: boolean
  /** Why the surfaces refuse the HQ preview export as last rendered. */
  previewExportRefusal?: HqPreviewExportReasonCode
  abortExportWork: () => void
  queueExportResultResourceDisposal: () => void
  registerExportResultResource: (result: ExportResult) => void
  scheduleToast: (notify: () => void) => void
  setProgress: (progress: number) => void
  setSession: SetImageSession
  setStatus: (status: ProcessingStatus) => void
  toast?: HqPreviewExportToast
}

let lastHqPreviewAttempt = 0

function createHqPreviewAttemptId() {
  lastHqPreviewAttempt += 1
  return (
    globalThis.crypto?.randomUUID?.() ??
    `hq-preview-${Date.now()}-${lastHqPreviewAttempt}`
  )
}

function resolveHqPreviewExportCopyCapability(): ExportCopyCapability {
  const capability = resolveExportCopyCapability()
  if (capability.mode === 'full-resolution') {
    return { mode: 'hq-preview' }
  }

  if (capability.mode === 'unavailable') return capability

  return unavailableExportCopy('hq-preview-copy-unsupported')
}

export function useHqPreviewExportAction({
  getSession,
  getColorIntent,
  getLutData,
  decodedImageRef,
  pipelineRef,
  isMountedRef,
  exportGraphVersionRef,
  exportAbortControllerRef,
  previewSuspended,
  previewExportRefusal,
  abortExportWork,
  queueExportResultResourceDisposal,
  registerExportResultResource,
  scheduleToast,
  setProgress,
  setSession,
  setStatus,
  toast = sonnerToast,
}: UseHqPreviewExportActionInput) {
  const t = useLatestTranslate()
  // A refusal stays a code up to the toast, which is the only place it
  // becomes copy, in the current locale.
  const refuse = useCallback(
    (refusal: HqPreviewExportReasonCode) => {
      const title = t('raw.export.toast.hqPreviewNotReady')
      const description = t(HQ_PREVIEW_EXPORT_REASON_COPY[refusal])
      scheduleToast(() => toast.error(title, { description }))
    },
    [scheduleToast, t, toast],
  )

  const exportPreviewImage = useCallback(async () => {
    // Every read below goes to the store when the action runs, so an action
    // a surface captured from an older render admits the session, color and
    // LUT a write in the same tick left there, before any rerender.
    const activeSession = getSession()
    const sourceFile = activeSession?.sourceFile.file
    const image = decodedImageRef.current
    const pipeline = pipelineRef.current

    // Read from the live session as the action runs: the HQ JPEG never
    // applies Transform, so it starts only while the source asks for none.
    const transformRefusal = activeSession
      ? deriveTransformExportRefusalReason(activeSession, 'hq-preview')
      : undefined
    if (transformRefusal) {
      refuse(transformRefusal)
      return
    }

    if (
      !activeSession ||
      !sourceFile ||
      !image ||
      image.source !== 'bounded-hq' ||
      !pipeline ||
      previewSuspended
    ) {
      refuse(previewExportRefusal ?? 'hq-preview-pending')
      return
    }

    // Read when the action runs, so an action a surface captured before the
    // look changed still refuses a look the preview has since left out.
    const intent = getColorIntent()
    const lut = getLutData()
    if (resolveHqPreviewLookRefusal({ intent, lut })) {
      refuse('look-dropped')
      return
    }
    // The HQ JPEG is drawn from what the pipeline holds, which follows the
    // store only once the preview's effects run, so it starts only once the
    // published pipeline holds the look admitted here, over a frame that
    // carries the admitted frame's exposure.
    const drawsLook = () =>
      pipelineHoldsLook({
        pipeline,
        publishedPipeline: pipelineRef.current,
        frameExposure: decodedImageRef.current?.renderExposure ?? null,
        intent,
        lut,
        rawRenderExposure: image.renderExposure,
      })
    if (!drawsLook()) {
      refuse('not-ready')
      return
    }

    // The request this attempt answers, fixed before anything renders, so
    // the result names what was asked for rather than what the store holds
    // when the JPEG arrives.
    const identity = captureExportResultIdentity({
      resultKind: 'hq-preview',
      attemptId: createHqPreviewAttemptId(),
      sessionId: activeSession.id,
      sourceFile,
      intent,
      lut,
      rawRenderExposure: image.renderExposure,
      geometry: activeSession.exportGeometry ?? null,
    })

    const exportSessionId = activeSession.id
    const refs = {
      isMountedRef,
      exportGraphVersionRef,
      exportAbortControllerRef,
      abortExportWork,
    }
    const attempt = beginExportAttempt(activeSession, identity.attemptId, refs)
    const exportAbortController = attempt.controller
    queueExportResultResourceDisposal()
    setStatus('exporting')
    setProgress(0)
    setSession(
      patchExportState(exportSessionId, {
        status: 'exporting',
        result: undefined,
        lastProgress: undefined,
      }),
    )

    /** Ends this attempt with a refusal and hands the workflow back. */
    const endRefused = (refusal: HqPreviewExportReasonCode) => {
      attempt.controller.abort()
      setSession((prev) =>
        prev &&
        prev.id === exportSessionId &&
        prev.exportState.status === 'exporting'
          ? clearExportResultState(prev)
          : prev,
      )
      setStatus('ready')
      setProgress(0)
      refuse(refusal)
    }

    /**
     * Whether this attempt may still write anything: nothing has made it
     * obsolete, and the source still asks for the neutral Transform it was
     * admitted with. A live Transform the HQ JPEG cannot leave out refuses
     * the attempt, which then ends itself and hands the workflow back with
     * the reason.
     */
    const isCurrentExport = () => {
      const live = getSession()
      if (!isExportAttemptLive(attempt, live, refs)) return false
      const refusal = deriveTransformExportRefusalReason(live, 'hq-preview')
      if (!refusal) return true
      endRefused(refusal)
      return false
    }

    /**
     * Whether this attempt is current and the preview still publishes the
     * pipeline it admitted, holding the look and the exposure it names; a
     * pipeline that has moved on or been replaced ends the attempt.
     */
    const drawsAdmittedLook = () => {
      if (!isCurrentExport()) return false
      if (drawsLook()) return true
      endRefused('not-ready')
      return false
    }

    try {
      const outputSize = resolveHqPreviewExportSize({
        width: image.width,
        height: image.height,
      })
      // The preview draws the selected look, so the file names it; with no
      // look drawn it names none.
      const filename = buildPreviewExportFilename(
        activeSession.sourceFile.name,
        intent.styleKind === 'none'
          ? 'neutral'
          : (activeSession.activeStyle?.name ?? 'neutral'),
      )
      const result = await runPreviewExportJob({
        filename,
        quality: EXPORT_JPEG_QUALITY,
        renderToCanvas: async () => {
          if (!drawsAdmittedLook()) {
            throw new Error('HQ_PREVIEW_EXPORT_ABORTED')
          }

          const canvas = await pipeline.renderToHiddenCanvas(outputSize)
          // A canvas rendered for an attempt that has ended, or by a
          // pipeline that took another look while it drew, is never encoded.
          if (!drawsAdmittedLook()) {
            throw new Error('HQ_PREVIEW_EXPORT_ABORTED')
          }
          return canvas
        },
      })

      if (!isCurrentExport()) return

      const exportResult = createCompletedExportResult({
        jobResult: result,
        kind: 'hq-preview',
        metadata: activeSession.sourceFile.metadata ?? null,
        width: outputSize.width,
        height: outputSize.height,
        copyCapability: resolveHqPreviewExportCopyCapability(),
        identity,
      })
      registerExportResultResource(exportResult)

      setSession(
        patchExportState(exportSessionId, {
          status: 'ready',
          result: exportResult,
        }),
      )
      setProgress(100)
      setStatus('ready')
      const message = t('raw.export.toast.hqPreviewReady')
      scheduleToast(() => toast.success(message))
    } catch (err) {
      if (!isCurrentExport()) return

      // A runtime's own message is shown as given.
      const title = t('raw.export.toast.hqPreviewFailed')
      const description =
        err instanceof Error
          ? err.message
          : t('raw.export.toast.hqPreviewFallback')
      setSession(
        patchExportState(exportSessionId, {
          status: 'idle',
          result: undefined,
        }),
      )
      setStatus('ready')
      setProgress(0)
      scheduleToast(() => toast.error(title, { description }))
    } finally {
      if (exportAbortControllerRef.current === exportAbortController) {
        exportAbortControllerRef.current = null
      }
    }
  }, [
    abortExportWork,
    decodedImageRef,
    exportAbortControllerRef,
    exportGraphVersionRef,
    getColorIntent,
    getLutData,
    getSession,
    isMountedRef,
    pipelineRef,
    previewExportRefusal,
    previewSuspended,
    queueExportResultResourceDisposal,
    refuse,
    registerExportResultResource,
    scheduleToast,
    setProgress,
    setSession,
    setStatus,
    t,
    toast,
  ])

  return { exportPreviewImage }
}
