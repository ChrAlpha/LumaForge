import type {
  ColorGraphIntentSource,
  LUTData,
} from '@lumaforge/luma-color-runtime'
import type { MutableRefObject } from 'react'
import { useCallback } from 'react'

import { emitExportDebugEvent } from '~/lib/export/execution-profile'
import type { MessageKey } from '~/lib/i18n'
import { useI18n } from '~/lib/i18n'
import type {
  PipelineStats,
  RawProcessingPipeline,
} from '~/lib/webgpu/raw-processing-pipeline'

import type { ExportResult } from '../../../model/export-result'
import type { ImageSession } from '../../../model/session'
import type {
  ExportActionReasonCode,
  ExportDeliveryGuard,
  ExportDeliveryLiveState,
  ExportOutputMaterializationAction,
  ExportOutputMaterializationEvent,
} from '../../../services/export/export-result-actions'
import {
  copyCanvasToClipboard,
  copyExportResultToClipboard,
  createExportDeliveryGuard,
  downloadExportManifest as downloadStoredExportManifest,
  downloadExportResult as downloadStoredExportResult,
  ExportActionUnavailableError,
  ExportDeliveryStaleError,
  openExportDelivery,
  shareExportResult as shareStoredExportResult,
  unavailableExportCopy,
} from '../../../services/export/export-result-actions'
import { readExportSlotAttempt } from '../../../services/export/export-state'
import {
  EXPORT_COPY_REASON_COPY,
  EXPORT_SHARE_REASON_COPY,
} from '../../../services/surface/raw-reason'

type ExportResultActionToast = {
  success: (message: string) => void
  error: (message: string, options?: { description?: string }) => void
}

type UseExportResultActionsInput = {
  sessionRef: MutableRefObject<ImageSession | null>
  /** The latest color intent; read at every delivery check. */
  paramsRef: MutableRefObject<ColorGraphIntentSource>
  lutDataRef: MutableRefObject<LUTData | null>
  exportGraphVersionRef: MutableRefObject<number>
  exportAbortControllerRef: MutableRefObject<AbortController | null>
  isMountedRef: MutableRefObject<boolean>
  pipelineRef: MutableRefObject<Pick<
    RawProcessingPipeline,
    'renderToHiddenCanvas'
  > | null>
  previewCopyCanvasRef: MutableRefObject<HTMLCanvasElement | null>
  previewSize?: PipelineStats['previewSize']
  scheduleToast: (notify: () => void) => void
  toast: ExportResultActionToast
}

const EXPORT_ACTION_REASON_COPY = {
  ...EXPORT_COPY_REASON_COPY,
  ...EXPORT_SHARE_REASON_COPY,
} as const satisfies Record<ExportActionReasonCode, MessageKey>

const STALE_DELIVERY_DESCRIPTION =
  'This export no longer matches the photo. Export again to deliver it.'

type OpenedDelivery = { result: ExportResult; guard: ExportDeliveryGuard }

export function useExportResultActions({
  sessionRef,
  paramsRef,
  lutDataRef,
  exportGraphVersionRef,
  exportAbortControllerRef,
  isMountedRef,
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

  // Everything a delivery check reads, read from the refs every time: a
  // result valid when the user asked can stop being current during an await.
  const readLive = useCallback(
    (): ExportDeliveryLiveState => ({
      mounted: isMountedRef.current,
      session: sessionRef.current,
      graphVersion: exportGraphVersionRef.current,
      exportAttempt: readExportSlotAttempt(exportAbortControllerRef),
      intent: paramsRef.current,
      lut: lutDataRef.current,
    }),
    [
      exportAbortControllerRef,
      exportGraphVersionRef,
      isMountedRef,
      lutDataRef,
      paramsRef,
      sessionRef,
    ],
  )

  /**
   * The result the session holds now, with a guard that every step of its
   * delivery asks before going on. Null when there is nothing to deliver; a
   * result the workflow cannot vouch for is refused with an error.
   */
  const openDelivery = useCallback((): OpenedDelivery | null => {
    const result = sessionRef.current?.exportState.result
    if (!result) return null
    const live = readLive()
    const opened = openExportDelivery(result, live)
    if (opened.kind === 'refused') {
      if (opened.refusal === 'unmounted') return null
      throw new ExportDeliveryStaleError(opened.refusal)
    }
    return {
      result,
      guard: createExportDeliveryGuard(opened.ticket, readLive),
    }
  }, [readLive, sessionRef])

  const { t } = useI18n()
  // A failure stays structured up to the toast, which is the only place a
  // refusal's code becomes copy, in the current locale.
  const describeFailure = useCallback(
    (err: unknown, fallback: string) =>
      err instanceof ExportDeliveryStaleError
        ? STALE_DELIVERY_DESCRIPTION
        : err instanceof ExportActionUnavailableError
          ? t(EXPORT_ACTION_REASON_COPY[err.reasonCode])
          : err instanceof Error
            ? err.message
            : fallback,
    [t],
  )

  const downloadExportResult = useCallback(async () => {
    try {
      const delivery = openDelivery()
      if (!delivery) return
      await downloadStoredExportResult(delivery.result, {
        ...createMaterializationDiagnostics('download'),
        guard: delivery.guard,
      })
    } catch (err) {
      const description = describeFailure(err, 'Download action failed.')
      scheduleToast(() =>
        toast.error('Download failed', {
          description,
        }),
      )
    }
  }, [
    createMaterializationDiagnostics,
    describeFailure,
    openDelivery,
    scheduleToast,
    toast,
  ])

  const downloadExportManifest = useCallback(async () => {
    if (!sessionRef.current?.exportState.result?.manifest) return

    try {
      const delivery = openDelivery()
      if (!delivery?.result.manifest) return
      await downloadStoredExportManifest(delivery.result, {
        ...createMaterializationDiagnostics('manifest'),
        guard: delivery.guard,
      })
    } catch (err) {
      const description = describeFailure(err, 'Manifest download failed.')
      scheduleToast(() =>
        toast.error('Manifest download failed', {
          description,
        }),
      )
    }
  }, [
    createMaterializationDiagnostics,
    describeFailure,
    openDelivery,
    scheduleToast,
    sessionRef,
    toast,
  ])

  const shareExportResult = useCallback(async () => {
    try {
      const delivery = openDelivery()
      if (!delivery) return
      await shareStoredExportResult(
        delivery.result,
        navigator,
        createMaterializationDiagnostics('share'),
        delivery.guard,
      )
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        return
      }

      const title = t('raw.export.toast.shareFailed')
      const description = describeFailure(err, 'Share action failed.')
      scheduleToast(() =>
        toast.error(title, {
          description,
        }),
      )
    }
  }, [
    createMaterializationDiagnostics,
    describeFailure,
    openDelivery,
    scheduleToast,
    t,
    toast,
  ])

  const copyExportResult = useCallback(async () => {
    try {
      const delivery = openDelivery()
      if (!delivery) return
      const { result, guard } = delivery

      if (result.copyCapability.mode === 'full-resolution') {
        await copyExportResultToClipboard(
          result,
          globalThis,
          createMaterializationDiagnostics('copy'),
          guard,
        )
        scheduleToast(() => toast.success('Full-resolution image copied'))
        return
      }

      if (result.copyCapability.mode === 'hq-preview') {
        await copyExportResultToClipboard(
          result,
          globalThis,
          createMaterializationDiagnostics('copy'),
          guard,
        )
        scheduleToast(() => toast.success('HQ preview image copied'))
        return
      }

      if (result.copyCapability.mode === 'preview-size') {
        // The snapshot the export kept is copied only while it is still the
        // one held: an edit or a later attempt drops or replaces it.
        const previewCopyCanvas = previewCopyCanvasRef.current
        if (previewCopyCanvas) {
          await copyCanvasToClipboard(previewCopyCanvas, globalThis, {
            assertCurrent() {
              guard.assertCurrent()
              if (previewCopyCanvasRef.current !== previewCopyCanvas) {
                throw new ExportDeliveryStaleError('result-replaced')
              }
            },
          })
          scheduleToast(() => toast.success('Preview-size image copied'))
          return
        }

        const pipeline = pipelineRef.current
        if (!pipeline || !previewSize) {
          throw new ExportActionUnavailableError(
            unavailableExportCopy('preview-copy-not-ready'),
          )
        }

        const canvas = await pipeline.renderToHiddenCanvas({
          width: previewSize.width,
          height: previewSize.height,
        })
        await copyCanvasToClipboard(canvas, globalThis, guard)
        scheduleToast(() => toast.success('Preview-size image copied'))
        return
      }

      throw new ExportActionUnavailableError(result.copyCapability)
    } catch (err) {
      const title = t('raw.export.toast.copyFailed')
      const description = describeFailure(err, 'Copy action failed.')
      scheduleToast(() =>
        toast.error(title, {
          description,
        }),
      )
    }
  }, [
    createMaterializationDiagnostics,
    describeFailure,
    openDelivery,
    pipelineRef,
    previewCopyCanvasRef,
    previewSize,
    scheduleToast,
    t,
    toast,
  ])

  return {
    downloadExportResult,
    downloadExportManifest,
    shareExportResult,
    copyExportResult,
  }
}
