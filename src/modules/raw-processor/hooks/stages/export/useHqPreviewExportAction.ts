import type {
  ColorGraphIntent,
  ColorGraphIntentSource,
  LUTData,
} from '@lumaforge/luma-color-runtime'
import { colorGraphIntentSignature } from '@lumaforge/luma-color-runtime'
import type { Dispatch, MutableRefObject, SetStateAction } from 'react'
import { useCallback } from 'react'
import { toast as sonnerToast } from 'sonner'

import { useI18n } from '~/lib/i18n'
import type { DecodedImage } from '~/lib/raw/decoder'
import type { RawProcessingPipeline } from '~/lib/webgpu/raw-processing-pipeline'

import type {
  ExportCopyCapability,
  ExportResult,
  HqPreviewExportReasonCode,
} from '../../../model/export-result'
import type { ImageSession, TransformIntent } from '../../../model/session'
import type { ProcessingStatus } from '../../../model/workflow'
import { deriveTransformExportRefusalReason } from '../../../services/export/export-readiness'
import {
  resolveExportCopyCapability,
  unavailableExportCopy,
} from '../../../services/export/export-result-actions'
import { captureExportResultIdentity } from '../../../services/export/export-result-identity'
import { createCompletedExportResult } from '../../../services/export/export-result-materialization'
import {
  claimExportSlot,
  clearExportResultForActiveExport,
  clearExportResultState,
} from '../../../services/export/export-state'
import {
  buildPreviewExportFilename,
  EXPORT_JPEG_QUALITY,
  resolveHqPreviewExportSize,
  runPreviewExportJob,
} from '../../../services/export/export-system'
import { resolveHqPreviewLookRefusal } from '../../../services/export/hq-preview-look'
import { HQ_PREVIEW_EXPORT_REASON_COPY } from '../../../services/surface/raw-reason'

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
  previewCopyCanvasRef: MutableRefObject<HTMLCanvasElement | null>
  previewSuspended: boolean
  /** Why the surfaces refuse the HQ preview export as last rendered. */
  previewExportRefusal?: HqPreviewExportReasonCode
  abortExportWork: () => void
  queueExportResultResourceDisposal: () => void
  registerExportResultResource: (result: ExportResult) => void
  scheduleToast: (notify: () => void) => void
  setProgress: (progress: number) => void
  setSession: Dispatch<SetStateAction<ImageSession | null>>
  setStatus: (status: ProcessingStatus) => void
  toast?: HqPreviewExportToast
}

/**
 * One HQ preview export attempt, fixed when it starts: the source, the
 * export graph generation, the neutral Transform intent it was admitted
 * with, and its own abort controller.
 */
type HqPreviewExportAttempt = Readonly<{
  sessionId: string
  graphVersion: number
  transformIntent: TransformIntent | undefined
  controller: AbortController
}>

/**
 * Whether the pipeline holds the color and the LUT an attempt admitted. The
 * HQ JPEG is drawn from what the pipeline holds, which follows the store
 * only once the preview's effects run, so a write that has not reached it
 * yet would put other pixels under the admitted identity. The LUT counts
 * only when the look draws one, as in the identity; a table counts as held
 * only when the pipeline holds the same table, domain and contract.
 */
function pipelineHoldsLook(
  pipeline: HqPreviewPipeline,
  intent: ColorGraphIntentSource,
  lut: LUTData | null,
): boolean {
  let held: ColorGraphIntentSource
  try {
    held = pipeline.getParams()
  } catch {
    return false
  }
  if (colorGraphIntentSignature(held) !== colorGraphIntentSignature(intent)) {
    return false
  }
  if (intent.styleKind !== 'custom') return true
  const heldLut = pipeline.getLutData()
  if (!heldLut || !lut) return heldLut === lut
  return (
    heldLut.data === lut.data &&
    heldLut.size === lut.size &&
    heldLut.domainMin === lut.domainMin &&
    heldLut.domainMax === lut.domainMax &&
    heldLut.profileResolution === lut.profileResolution
  )
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
  previewCopyCanvasRef,
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
  const { t } = useI18n()
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
    // The pipeline draws the JPEG, so it starts only once the pipeline holds
    // the look admitted here.
    if (!pipelineHoldsLook(pipeline, intent, lut)) {
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
    const exportGraphVersion = exportGraphVersionRef.current
    abortExportWork()
    const attempt: HqPreviewExportAttempt = Object.freeze({
      sessionId: exportSessionId,
      graphVersion: exportGraphVersion,
      transformIntent: activeSession.transform?.intent,
      controller: new AbortController(),
    })
    const exportAbortController = attempt.controller
    claimExportSlot(
      exportAbortControllerRef,
      exportAbortController,
      identity.attemptId,
    )
    previewCopyCanvasRef.current = null
    queueExportResultResourceDisposal()
    setStatus('exporting')
    setProgress(0)
    setSession((prev) =>
      prev && prev.id === exportSessionId
        ? (() => {
            const cleared = clearExportResultForActiveExport(prev)
            return {
              ...cleared,
              exportState: {
                ...cleared.exportState,
                status: 'exporting',
              },
            } satisfies ImageSession
          })()
        : prev,
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
     * Whether this attempt may still write anything: the view is mounted,
     * its signal is live, it still holds the export slot, the export graph
     * has not moved, and the same source still asks for the same neutral
     * Transform. Every edit makes a new intent, so the first edit ends it,
     * and whoever ended it settles the workflow. A live Transform the HQ JPEG
     * cannot leave out refuses the attempt, which then ends itself and hands
     * the workflow back with the reason.
     */
    const isCurrentExport = () => {
      const live = getSession()
      if (
        !isMountedRef.current ||
        attempt.controller.signal.aborted ||
        exportAbortControllerRef.current !== attempt.controller ||
        exportGraphVersionRef.current !== attempt.graphVersion ||
        !live ||
        live.id !== attempt.sessionId ||
        live.transform?.intent !== attempt.transformIntent
      ) {
        return false
      }
      const refusal = deriveTransformExportRefusalReason(live, 'hq-preview')
      if (!refusal) return true
      endRefused(refusal)
      return false
    }

    /**
     * Whether this attempt is current and the pipeline still holds the look
     * it admitted; a pipeline that has moved on ends the attempt.
     */
    const drawsAdmittedLook = () => {
      if (!isCurrentExport()) return false
      if (pipelineHoldsLook(pipeline, intent, lut)) return true
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

      setSession((prev) =>
        prev && prev.id === exportSessionId
          ? {
              ...prev,
              exportState: {
                ...prev.exportState,
                status: 'ready',
                result: exportResult,
                retryRecommended: false,
                lastSuccessfulSize: outputSize,
              },
            }
          : prev,
      )
      setProgress(100)
      setStatus('ready')
      scheduleToast(() => toast.success('HQ preview JPEG ready'))
    } catch (err) {
      if (!isCurrentExport()) return

      const description =
        err instanceof Error ? err.message : 'HQ preview export failed.'
      setSession((prev) =>
        prev && prev.id === exportSessionId
          ? {
              ...prev,
              exportState: {
                ...prev.exportState,
                status: 'idle',
                result: undefined,
              },
            }
          : prev,
      )
      setStatus('ready')
      setProgress(0)
      scheduleToast(() =>
        toast.error('HQ preview export failed', { description }),
      )
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
    previewCopyCanvasRef,
    previewExportRefusal,
    previewSuspended,
    queueExportResultResourceDisposal,
    refuse,
    registerExportResultResource,
    scheduleToast,
    setProgress,
    setSession,
    setStatus,
    toast,
  ])

  return { exportPreviewImage }
}
