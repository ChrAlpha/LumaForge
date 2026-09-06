import type { Dispatch, MutableRefObject, SetStateAction } from 'react'
import { useCallback } from 'react'
import { toast as sonnerToast } from 'sonner'

import type { RawProcessingPipeline } from '~/lib/gl/pipeline'
import type { DecodedImage } from '~/lib/raw/decoder'

import { PREVIEW_TRANSFORM_EXPORT_REASON } from '../../../model/derive-session'
import type { ExportResult } from '../../../model/export-result'
import type { ImageSession } from '../../../model/session'
import type { ProcessingStatus } from '../../../model/workflow'
import { resolveExportCopyCapability } from '../../../services/export/export-result-actions'
import { createCompletedExportResult } from '../../../services/export/export-result-materialization'
import { clearExportResultForActiveExport } from '../../../services/export/export-state'
import {
  buildPreviewExportFilename,
  HQ_PREVIEW_EXPORT_QUALITY,
  resolveHqPreviewExportSize,
  runPreviewExportJob,
} from '../../../services/export/export-system'

type HqPreviewExportToast = {
  success: (message: string) => void
  error: (message: string, options?: { description?: string }) => void
}

type UseHqPreviewExportActionInput = {
  sessionRef: MutableRefObject<ImageSession | null>
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

    if (activeSession?.previewTransformActive) {
      scheduleToast(() =>
        toast.error('HQ preview export is not ready', {
          description: PREVIEW_TRANSFORM_EXPORT_REASON,
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

    const exportSessionId = activeSession.id
    const exportGraphVersion = exportGraphVersionRef.current
    abortExportWork()
    const exportAbortController = new AbortController()
    exportAbortControllerRef.current = exportAbortController
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

    const isCurrentExport = () =>
      isMountedRef.current &&
      !exportAbortController.signal.aborted &&
      exportGraphVersionRef.current === exportGraphVersion &&
      sessionRef.current?.id === exportSessionId

    try {
      const outputSize = resolveHqPreviewExportSize({
        width: image.width,
        height: image.height,
      })
      const filename = buildPreviewExportFilename(
        activeSession.sourceFile.name,
        activeSession.activeStyle?.name ?? 'neutral',
      )
      const result = await runPreviewExportJob({
        filename,
        quality: HQ_PREVIEW_EXPORT_QUALITY,
        renderToCanvas: async () => {
          if (exportAbortController.signal.aborted) {
            throw new Error('HQ_PREVIEW_EXPORT_ABORTED')
          }

          return await pipeline.renderToHiddenCanvas(outputSize)
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
      if (
        exportAbortController.signal.aborted ||
        !isMountedRef.current ||
        sessionRef.current?.id !== exportSessionId
      ) {
        return
      }

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
