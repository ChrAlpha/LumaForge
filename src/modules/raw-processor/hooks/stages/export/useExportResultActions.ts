import type { MutableRefObject } from 'react'
import { useCallback } from 'react'

import { emitExportDebugEvent } from '~/lib/export/execution-profile'
import type { PipelineStats, RawProcessingPipeline } from '~/lib/gl/pipeline'

import type { ExportResult } from '../../../model/export-result'
import type {
  ExportOutputMaterializationAction,
  ExportOutputMaterializationEvent,
} from '../../../services/export/export-result-actions'
import {
  copyCanvasToClipboard,
  copyExportResultToClipboard,
  downloadExportManifest as downloadStoredExportManifest,
  downloadExportResult as downloadStoredExportResult,
  shareExportResult as shareStoredExportResult,
} from '../../../services/export/export-result-actions'

type ExportResultActionSession = {
  exportState: {
    result?: ExportResult
  }
}

type ExportResultActionToast = {
  success: (message: string) => void
  error: (message: string, options?: { description?: string }) => void
}

type UseExportResultActionsInput = {
  sessionRef: MutableRefObject<ExportResultActionSession | null>
  pipelineRef: MutableRefObject<Pick<
    RawProcessingPipeline,
    'renderToHiddenCanvas'
  > | null>
  previewCopyCanvasRef: MutableRefObject<HTMLCanvasElement | null>
  previewSize?: PipelineStats['previewSize']
  scheduleToast: (notify: () => void) => void
  toast: ExportResultActionToast
}

export function useExportResultActions({
  sessionRef,
  pipelineRef,
  previewCopyCanvasRef,
  previewSize,
  scheduleToast,
  toast,
}: UseExportResultActionsInput) {
  const createMaterializationDiagnostics = useCallback(
    (action: ExportOutputMaterializationAction) => ({
      onMaterialize(event: ExportOutputMaterializationEvent) {
        emitExportDebugEvent({
          type: 'output-materialized',
          payload: {
            ...event,
            action,
          },
        })
      },
    }),
    [],
  )

  const downloadExportResult = useCallback(async () => {
    const result = sessionRef.current?.exportState.result
    if (!result) return

    try {
      await downloadStoredExportResult(
        result,
        createMaterializationDiagnostics('download'),
      )
    } catch (err) {
      const description =
        err instanceof Error ? err.message : 'Download action failed.'
      scheduleToast(() =>
        toast.error('Download failed', {
          description,
        }),
      )
    }
  }, [createMaterializationDiagnostics, scheduleToast, sessionRef, toast])

  const downloadExportManifest = useCallback(async () => {
    const result = sessionRef.current?.exportState.result
    if (!result?.manifest) return

    try {
      await downloadStoredExportManifest(
        result,
        createMaterializationDiagnostics('manifest'),
      )
    } catch (err) {
      const description =
        err instanceof Error ? err.message : 'Manifest download failed.'
      scheduleToast(() =>
        toast.error('Manifest download failed', {
          description,
        }),
      )
    }
  }, [createMaterializationDiagnostics, scheduleToast, sessionRef, toast])

  const shareExportResult = useCallback(async () => {
    const result = sessionRef.current?.exportState.result
    if (!result) return

    try {
      await shareStoredExportResult(
        result,
        navigator,
        createMaterializationDiagnostics('share'),
      )
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        return
      }

      const description =
        err instanceof Error ? err.message : 'Share action failed.'
      scheduleToast(() =>
        toast.error('Share failed', {
          description,
        }),
      )
    }
  }, [createMaterializationDiagnostics, scheduleToast, sessionRef, toast])

  const copyExportResult = useCallback(async () => {
    const result = sessionRef.current?.exportState.result
    if (!result) return

    try {
      if (result.copyCapability.mode === 'full-resolution') {
        await copyExportResultToClipboard(
          result,
          globalThis,
          createMaterializationDiagnostics('copy'),
        )
        scheduleToast(() => toast.success('Full-resolution image copied'))
        return
      }

      if (result.copyCapability.mode === 'hq-preview') {
        await copyExportResultToClipboard(
          result,
          globalThis,
          createMaterializationDiagnostics('copy'),
        )
        scheduleToast(() => toast.success('HQ preview image copied'))
        return
      }

      if (result.copyCapability.mode === 'preview-size') {
        const previewCopyCanvas = previewCopyCanvasRef.current
        if (previewCopyCanvas) {
          await copyCanvasToClipboard(previewCopyCanvas)
          scheduleToast(() => toast.success('Preview-size image copied'))
          return
        }

        const pipeline = pipelineRef.current
        if (!pipeline || !previewSize) {
          throw new Error('Preview image is not ready to copy.')
        }

        const canvas = await pipeline.renderToHiddenCanvas({
          width: previewSize.width,
          height: previewSize.height,
        })
        await copyCanvasToClipboard(canvas)
        scheduleToast(() => toast.success('Preview-size image copied'))
        return
      }

      throw new Error(result.copyCapability.reason)
    } catch (err) {
      const description =
        err instanceof Error ? err.message : 'Copy action failed.'
      scheduleToast(() =>
        toast.error('Copy failed', {
          description,
        }),
      )
    }
  }, [
    createMaterializationDiagnostics,
    pipelineRef,
    previewCopyCanvasRef,
    previewSize,
    scheduleToast,
    sessionRef,
    toast,
  ])

  return {
    downloadExportResult,
    downloadExportManifest,
    shareExportResult,
    copyExportResult,
  }
}
