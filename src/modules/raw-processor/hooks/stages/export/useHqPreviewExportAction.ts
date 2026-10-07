import type {
  ColorGraphIntentSource,
  LUTData,
} from '@lumaforge/luma-color-runtime'
import type { Dispatch, MutableRefObject, SetStateAction } from 'react'
import { useCallback } from 'react'
import { toast as sonnerToast } from 'sonner'

import type { DecodedImage } from '~/lib/raw/decoder'
import type { RawProcessingPipeline } from '~/lib/webgpu/raw-processing-pipeline'

import type { ExportResult } from '../../../model/export-result'
import type { ImageSession, TransformIntent } from '../../../model/session'
import type { ProcessingStatus } from '../../../model/workflow'
import { deriveTransformExportRefusal } from '../../../services/export/export-readiness'
import { resolveExportCopyCapability } from '../../../services/export/export-result-actions'
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
import {
  HQ_PREVIEW_LOOK_EXPORT_REASON,
  resolveHqPreviewLookRefusal,
} from '../../../services/export/hq-preview-look'

type HqPreviewExportToast = {
  success: (message: string) => void
  error: (message: string, options?: { description?: string }) => void
}

type UseHqPreviewExportActionInput = {
  sessionRef: MutableRefObject<ImageSession | null>
  /** The look and user color the preview pipeline renders with. */
  paramsRef: MutableRefObject<ColorGraphIntentSource>
  /** The custom LUT data the preview pipeline renders with. */
  lutDataRef: MutableRefObject<LUTData | null>
  decodedImageRef: MutableRefObject<DecodedImage | null>
  pipelineRef: MutableRefObject<Pick<
    RawProcessingPipeline,
    'renderToHiddenCanvas'
  > | null>
  isMountedRef: MutableRefObject<boolean>
  exportGraphVersionRef: MutableRefObject<number>
  exportAbortControllerRef: MutableRefObject<AbortController | null>
  previewCopyCanvasRef: MutableRefObject<HTMLCanvasElement | null>
  previewSuspended: boolean
  previewExportDisabledReason?: string
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

let lastHqPreviewAttempt = 0

function createHqPreviewAttemptId() {
  lastHqPreviewAttempt += 1
  return (
    globalThis.crypto?.randomUUID?.() ??
    `hq-preview-${Date.now()}-${lastHqPreviewAttempt}`
  )
}

function resolveHqPreviewExportCopyCapability() {
  const capability = resolveExportCopyCapability()
  if (capability.mode === 'full-resolution') {
    return {
      mode: 'hq-preview' as const,
      label: 'Copy HQ preview image' as const,
    }
  }

  if (capability.mode === 'unavailable') return capability

  return {
    mode: 'unavailable' as const,
    reason: 'This browser cannot copy HQ preview JPEG files.',
  }
}

export function useHqPreviewExportAction({
  sessionRef,
  paramsRef,
  lutDataRef,
  decodedImageRef,
  pipelineRef,
  isMountedRef,
  exportGraphVersionRef,
  exportAbortControllerRef,
  previewCopyCanvasRef,
  previewSuspended,
  previewExportDisabledReason,
  abortExportWork,
  queueExportResultResourceDisposal,
  registerExportResultResource,
  scheduleToast,
  setProgress,
  setSession,
  setStatus,
  toast = sonnerToast,
}: UseHqPreviewExportActionInput) {
  const exportPreviewImage = useCallback(async () => {
    const activeSession = sessionRef.current
    const sourceFile = activeSession?.sourceFile.file
    const image = decodedImageRef.current
    const pipeline = pipelineRef.current

    // Read from the live session as the action runs: the HQ JPEG never
    // applies Transform, so it starts only while the source asks for none.
    const transformRefusal = activeSession
      ? deriveTransformExportRefusal(activeSession, 'hq-preview')
      : undefined
    if (transformRefusal) {
      scheduleToast(() =>
        toast.error('HQ preview export is not ready', {
          description: transformRefusal,
        }),
      )
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
      scheduleToast(() =>
        toast.error('HQ preview export is not ready', {
          description:
            previewExportDisabledReason ??
            'HQ preview export is available after the bounded HQ preview finishes.',
        }),
      )
      return
    }

    // Read when the action runs, so an action a surface captured before the
    // look changed still refuses a look the preview has since left out.
    const intent = paramsRef.current
    if (resolveHqPreviewLookRefusal({ intent, lut: lutDataRef.current })) {
      scheduleToast(() =>
        toast.error('HQ preview export is not ready', {
          description: HQ_PREVIEW_LOOK_EXPORT_REASON,
        }),
      )
      return
    }

    // The request this attempt answers, fixed before anything renders, so
    // the result names what was asked for rather than what the refs hold
    // when the JPEG arrives.
    const identity = captureExportResultIdentity({
      resultKind: 'hq-preview',
      attemptId: createHqPreviewAttemptId(),
      sessionId: activeSession.id,
      sourceFile,
      intent,
      lut: lutDataRef.current,
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
      const live = sessionRef.current
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
      const refusal = deriveTransformExportRefusal(live, 'hq-preview')
      if (!refusal) return true
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
      scheduleToast(() =>
        toast.error('HQ preview export is not ready', {
          description: refusal,
        }),
      )
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
          if (!isCurrentExport()) {
            throw new Error('HQ_PREVIEW_EXPORT_ABORTED')
          }

          const canvas = await pipeline.renderToHiddenCanvas(outputSize)
          // A canvas rendered for an attempt that has ended is never encoded.
          if (!isCurrentExport()) {
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
    isMountedRef,
    lutDataRef,
    paramsRef,
    pipelineRef,
    previewCopyCanvasRef,
    previewExportDisabledReason,
    previewSuspended,
    queueExportResultResourceDisposal,
    registerExportResultResource,
    scheduleToast,
    sessionRef,
    setProgress,
    setSession,
    setStatus,
    toast,
  ])

  return { exportPreviewImage }
}
