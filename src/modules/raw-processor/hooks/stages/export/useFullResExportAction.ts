import { useCallback, useLayoutEffect, useMemo, useRef } from 'react'
import { toast } from 'sonner'

import type { Translate } from '~/lib/i18n'
import { useI18n } from '~/lib/i18n'

import type {
  ExportContext,
  FullResExportNotification,
  FullResExportRequest,
} from '../../../services/export/orchestrate-full-res-export'
import { orchestrateFullResExport } from '../../../services/export/orchestrate-full-res-export'
import { fullResExportReasonText } from '../../../services/surface/raw-reason'

export type UseFullResExportActionInput = ExportContext['atoms'] &
  ExportContext['refs'] &
  Omit<ExportContext['services'], 'notify'> & {
    /** Runs a toast after the current commit, and only while mounted. */
    scheduleToast: (show: () => void) => void
    orchestrateExport?: typeof orchestrateFullResExport
  }

/**
 * A plan the policy refuses is told by its code; any other failure shows the
 * runtime's message as given, or a generic one when it gave none, with the
 * safer level to retry at.
 */
function fullResExportFailureText(
  notification: Extract<FullResExportNotification, { kind: 'failed' }>,
  t: Translate,
) {
  if (notification.code === 'EXPORT_POLICY_CANNOT_COMPLETE') {
    return t('raw.export.reason.cannotSafelyComplete')
  }
  const { retryLevel } = notification
  const message = notification.message ?? t('raw.export.toast.exportFallback')
  if (retryLevel === 'safe') {
    return t('raw.export.toast.retrySafe', { message })
  }
  if (retryLevel === 'balanced') {
    return t('raw.export.toast.retryBalanced', { message })
  }
  return message
}

function showFullResExportNotification(
  notification: FullResExportNotification,
  t: Translate,
  scheduleToast: (show: () => void) => void,
) {
  switch (notification.kind) {
    case 'started':
      // Earlier notices describe a state the new attempt replaces, so they
      // go at once rather than after the commit.
      toast.dismiss()
      break
    case 'refused': {
      // The copy is read in the locale current when the export refused.
      const title = t('raw.export.toast.fullResNotReady')
      const description = fullResExportReasonText(notification.refusal, t)
      scheduleToast(() =>
        toast.error(title, description ? { description } : undefined),
      )
      break
    }
    case 'failed': {
      const title = t('raw.export.toast.exportFailed')
      const description = fullResExportFailureText(notification, t)
      scheduleToast(() => toast.error(title, { description }))
      break
    }
  }
}

export function useFullResExportAction({
  loadedImage,
  session,
  getSession,
  getColorIntent,
  getLutData,
  previewFacts,
  decodedImageRef,
  exportAbortControllerRef,
  exportGraphVersionRef,
  isMountedRef,
  pipelineRef,
  resourceRegistryRef,
  previewCopyCanvasRef,
  setStatus,
  setError,
  setProgress,
  setSession,
  refreshExportInterruption,
  scheduleToast,
  abortExportWork,
  previewRuntime,
  registerCurrentPreviewPipelineForEvacuation,
  registerExportResultResource,
  revokeCurrentEmbeddedPreviewUrl,
  interruptionMarkers,
  orchestrateExport = orchestrateFullResExport,
}: UseFullResExportActionInput) {
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
  // The export decides what to report while its attempt is current; the
  // copy and the toast belong here.
  const notify = useCallback(
    (notification: FullResExportNotification) => {
      showFullResExportNotification(notification, t, scheduleToast)
    },
    [scheduleToast, t],
  )
  const exportCtx = useMemo<ExportContext>(
    () => ({
      atoms: {
        setStatus,
        setError,
        setProgress,
        setSession,
        loadedImage,
        session,
        getSession,
        getColorIntent,
        getLutData,
        decodedImageRef,
        previewFacts,
        refreshExportInterruption,
      },
      refs: {
        exportAbortControllerRef,
        exportGraphVersionRef,
        isMountedRef,
        pipelineRef,
        resourceRegistryRef,
        previewCopyCanvasRef,
      },
      services: {
        notify,
        abortExportWork,
        previewRuntime,
        registerCurrentPreviewPipelineForEvacuation,
        registerExportResultResource,
        revokeCurrentEmbeddedPreviewUrl,
        interruptionMarkers,
      },
    }),
    [
      abortExportWork,
      decodedImageRef,
      exportAbortControllerRef,
      exportGraphVersionRef,
      getColorIntent,
      getLutData,
      getSession,
      interruptionMarkers,
      isMountedRef,
      loadedImage,
      notify,
      pipelineRef,
      previewCopyCanvasRef,
      previewRuntime,
      refreshExportInterruption,
      registerCurrentPreviewPipelineForEvacuation,
      registerExportResultResource,
      resourceRegistryRef,
      revokeCurrentEmbeddedPreviewUrl,
      session,
      setError,
      setProgress,
      setSession,
      setStatus,
      previewFacts,
    ],
  )

  const exportImage = useCallback(
    async (request: FullResExportRequest = {}) => {
      await orchestrateExport(request, exportCtx)
    },
    [exportCtx, orchestrateExport],
  )

  return { exportImage }
}
