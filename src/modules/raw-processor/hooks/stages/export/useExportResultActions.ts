import type { ColorGraphIntent, LUTData } from '@lumaforge/luma-color-runtime'
import type { MutableRefObject } from 'react'
import { useCallback, useLayoutEffect, useRef } from 'react'

import { emitExportDebugEvent } from '~/lib/export/execution-profile'
import type { MessageKey, Translate } from '~/lib/i18n'
import { useI18n } from '~/lib/i18n'
import type { DecodedImage } from '~/lib/raw/decoder'
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
  PreviewCopyEncodeError,
  shareExportResult as shareStoredExportResult,
  unavailableExportCopy,
} from '../../../services/export/export-result-actions'
import { readExportSlotAttempt } from '../../../services/export/export-state'
import { pipelineHoldsLook } from '../../../services/preview/pipeline-holds-look'
import {
  EXPORT_COPY_REASON_COPY,
  EXPORT_SHARE_REASON_COPY,
} from '../../../services/surface/raw-reason'

type ExportResultActionToast = {
  success: (message: string) => void
  error: (message: string, options?: { description?: string }) => void
}

type UseExportResultActionsInput = {
  /** Reads the session from the store when called. */
  getSession: () => ImageSession | null
  /** Reads the color intent the photo renders with from the store when called. */
  getColorIntent: () => ColorGraphIntent
  /** Reads the LUT the store holds when called. */
  getLutData: () => LUTData | null
  exportGraphVersionRef: MutableRefObject<number>
  exportAbortControllerRef: MutableRefObject<AbortController | null>
  isMountedRef: MutableRefObject<boolean>
  pipelineRef: MutableRefObject<Pick<
    RawProcessingPipeline,
    'renderToHiddenCanvas' | 'getParams' | 'getLutData'
  > | null>
  /** The frame the preview draws; its RAW render exposure is read. */
  decodedImageRef: MutableRefObject<Pick<DecodedImage, 'renderExposure'> | null>
  previewCopyCanvasRef: MutableRefObject<HTMLCanvasElement | null>
  previewSize?: PipelineStats['previewSize']
  scheduleToast: (notify: () => void) => void
  toast: ExportResultActionToast
}

const EXPORT_ACTION_REASON_COPY = {
  ...EXPORT_COPY_REASON_COPY,
  ...EXPORT_SHARE_REASON_COPY,
} as const satisfies Record<ExportActionReasonCode, MessageKey>

type OpenedDelivery = { result: ExportResult; guard: ExportDeliveryGuard }

export function useExportResultActions({
  getSession,
  getColorIntent,
  getLutData,
  exportGraphVersionRef,
  exportAbortControllerRef,
  isMountedRef,
  pipelineRef,
  decodedImageRef,
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

  // Everything a delivery check reads, read afresh every time: a result
  // valid when the user asked can stop being current during an await. The
  // session, color and LUT come from the store, so a write in the same tick
  // is seen before any rerender or effect catches up with it.
  const readLive = useCallback(
    (): ExportDeliveryLiveState => ({
      mounted: isMountedRef.current,
      session: getSession(),
      graphVersion: exportGraphVersionRef.current,
      exportAttempt: readExportSlotAttempt(exportAbortControllerRef),
      intent: getColorIntent(),
      lut: getLutData(),
    }),
    [
      exportAbortControllerRef,
      exportGraphVersionRef,
      getColorIntent,
      getLutData,
      getSession,
      isMountedRef,
    ],
  )

  /**
   * The result the session holds now, with a guard that every step of its
   * delivery asks before going on. Null when there is nothing to deliver; a
   * result the workflow cannot vouch for is refused with an error.
   */
  const openDelivery = useCallback((): OpenedDelivery | null => {
    const live = readLive()
    const result = live.session?.exportState.result
    if (!result) return null
    const opened = openExportDelivery(result, live)
    if (opened.kind === 'refused') {
      if (opened.refusal === 'unmounted') return null
      throw new ExportDeliveryStaleError(opened.refusal)
    }
    return {
      result,
      guard: createExportDeliveryGuard(opened.ticket, readLive),
    }
  }, [readLive])

  const { t: renderedTranslate } = useI18n()
  // Copy is built when a notification is, usually after an await, so it is
  // read in the locale current then rather than the one this render saw.
  const translateRef = useRef(renderedTranslate)
  useLayoutEffect(() => {
    translateRef.current = renderedTranslate
  }, [renderedTranslate])
  const t = useCallback<Translate>(
    (key, values) => translateRef.current(key, values),
    [],
  )
  // A failure stays structured up to the toast, which is the only place a
  // refusal's code becomes copy, in the current locale; a runtime's own
  // message is shown as given.
  const describeFailure = useCallback(
    (err: unknown, fallback: MessageKey) =>
      err instanceof ExportDeliveryStaleError
        ? t('raw.export.toast.staleDelivery')
        : err instanceof ExportActionUnavailableError
          ? t(EXPORT_ACTION_REASON_COPY[err.reasonCode])
          : err instanceof PreviewCopyEncodeError
            ? t('raw.export.toast.previewCopyEncodeFailed')
            : err instanceof Error
              ? err.message
              : t(fallback),
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
      const title = t('raw.export.toast.downloadFailed')
      const description = describeFailure(
        err,
        'raw.export.toast.downloadFallback',
      )
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

  const downloadExportManifest = useCallback(async () => {
    if (!getSession()?.exportState.result?.manifest) return

    try {
      const delivery = openDelivery()
      if (!delivery?.result.manifest) return
      await downloadStoredExportManifest(delivery.result, {
        ...createMaterializationDiagnostics('manifest'),
        guard: delivery.guard,
      })
    } catch (err) {
      const title = t('raw.export.toast.manifestDownloadFailed')
      const description = describeFailure(
        err,
        'raw.export.toast.manifestDownloadFallback',
      )
      scheduleToast(() =>
        toast.error(title, {
          description,
        }),
      )
    }
  }, [
    createMaterializationDiagnostics,
    describeFailure,
    getSession,
    openDelivery,
    scheduleToast,
    t,
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
      const description = describeFailure(err, 'raw.export.toast.shareFallback')
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
        const message = t('raw.export.toast.fullResCopied')
        scheduleToast(() => toast.success(message))
        return
      }

      if (result.copyCapability.mode === 'hq-preview') {
        await copyExportResultToClipboard(
          result,
          globalThis,
          createMaterializationDiagnostics('copy'),
          guard,
        )
        const message = t('raw.export.toast.hqPreviewCopied')
        scheduleToast(() => toast.success(message))
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
          const message = t('raw.export.toast.previewSizeCopied')
          scheduleToast(() => toast.success(message))
          return
        }

        const notReady = () =>
          new ExportActionUnavailableError(
            unavailableExportCopy('preview-copy-not-ready'),
          )
        const pipeline = pipelineRef.current
        if (!pipeline || !previewSize) throw notReady()

        // The pipeline renders what it holds, which follows the store only
        // once the preview's effects run. The guard holds the store to the
        // result, so the render stands for the result only while the preview
        // still publishes this pipeline, holding the stored look, over a
        // frame with the result's exposure: asked before the render, after
        // every await, and right before the clipboard write.
        const drawsResult: ExportDeliveryGuard = {
          assertCurrent() {
            guard.assertCurrent()
            const drawn = pipelineHoldsLook({
              pipeline,
              publishedPipeline: pipelineRef.current,
              frameExposure: decodedImageRef.current?.renderExposure ?? null,
              intent: getColorIntent(),
              lut: getLutData(),
              rawRenderExposure: result.identity.rawRenderExposure,
            })
            if (!drawn) throw notReady()
          },
        }
        drawsResult.assertCurrent()
        const canvas = await pipeline.renderToHiddenCanvas({
          width: previewSize.width,
          height: previewSize.height,
        })
        await copyCanvasToClipboard(canvas, globalThis, drawsResult)
        const message = t('raw.export.toast.previewSizeCopied')
        scheduleToast(() => toast.success(message))
        return
      }

      throw new ExportActionUnavailableError(result.copyCapability)
    } catch (err) {
      const title = t('raw.export.toast.copyFailed')
      const description = describeFailure(err, 'raw.export.toast.copyFallback')
      scheduleToast(() =>
        toast.error(title, {
          description,
        }),
      )
    }
  }, [
    createMaterializationDiagnostics,
    decodedImageRef,
    describeFailure,
    getColorIntent,
    getLutData,
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
