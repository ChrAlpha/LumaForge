import { useCallback, useLayoutEffect, useMemo, useRef } from 'react'
import { toast } from 'sonner'

import type { Translate } from '~/lib/i18n'
import { useI18n } from '~/lib/i18n'

import type {
  RawLoadContext,
  RawLoadNotification,
} from '../../../services/ingest/orchestrate-raw-load'
import { orchestrateRawLoad } from '../../../services/ingest/orchestrate-raw-load'

export type UseRawLoadActionInput = RawLoadContext['atoms'] &
  Omit<RawLoadContext['services'], 'notify'> &
  RawLoadContext['refs'] & {
    /** Runs a toast after the current commit, and only while mounted. */
    scheduleToast: (show: () => void) => void
  }

/**
 * Builds a load outcome's toast in the locale current when the load reports
 * it. A runtime's own message and the camera's make and model are shown as
 * given.
 */
function rawLoadToast(
  notification: RawLoadNotification,
  t: Translate,
): () => void {
  switch (notification.kind) {
    case 'preview-unavailable': {
      const title = t('raw.preview.unavailable')
      const description = t('raw.ingest.toast.previewUnavailableDescription')
      return () => toast.error(title, { description })
    }
    case 'loaded': {
      const title = t('raw.ingest.toast.loaded', {
        fileName: notification.fileName,
      })
      const description = t('raw.ingest.toast.loadedDescription', {
        width: notification.width,
        height: notification.height,
        make: notification.make || t('raw.ingest.toast.unknownMake'),
        model: notification.model || '',
      })
      return () => toast.success(title, { description })
    }
    case 'load-failed': {
      const title = t('raw.ingest.toast.loadFailed')
      const description =
        notification.message ?? t('raw.ingest.toast.loadFallback')
      return () => toast.error(title, { description })
    }
  }
}

export function useRawLoadAction({
  setStatus,
  setError,
  setProgress,
  getColorIntent,
  getView,
  getLut,
  setColorIntent,
  getSession,
  setSession,
  scheduleToast,
  replaceFile,
  abortRuntimeWork,
  abortExportWork,
  queueExportResultResourceDisposal,
  revokeCurrentEmbeddedPreviewUrl,
  setDecodedImageRef,
  yieldToPaint,
  getPrewarmState,
  beginRuntimeSession,
  embeddedPreviewUrlRef,
  isMountedRef,
  runtimeWorkSessionIdRef,
  pendingLoadSessionIdRef,
  previewCopyCanvasRef,
}: UseRawLoadActionInput) {
  const { t: renderedTranslate } = useI18n()
  // Copy is built when a notification is, usually after an await, so it is
  // read in the locale current then rather than the one this render saw.
  const translateRef = useRef(renderedTranslate)
  useLayoutEffect(() => {
    translateRef.current = renderedTranslate
  }, [renderedTranslate])
  // The load decides what to report while it owns the session; the toast
  // itself waits for the scheduled post-commit task.
  const notify = useCallback(
    (notification: RawLoadNotification) => {
      scheduleToast(rawLoadToast(notification, translateRef.current))
    },
    [scheduleToast],
  )

  const rawLoadCtx = useMemo<RawLoadContext>(
    () => ({
      atoms: {
        setStatus,
        setError,
        setProgress,
        getColorIntent,
        getView,
        getLut,
        setColorIntent,
        getSession,
        setSession,
      },
      services: {
        notify,
        replaceFile,
        abortRuntimeWork,
        abortExportWork,
        queueExportResultResourceDisposal,
        revokeCurrentEmbeddedPreviewUrl,
        setDecodedImageRef,
        yieldToPaint,
        getPrewarmState,
        beginRuntimeSession,
      },
      refs: {
        embeddedPreviewUrlRef,
        isMountedRef,
        runtimeWorkSessionIdRef,
        pendingLoadSessionIdRef,
        previewCopyCanvasRef,
      },
    }),
    [
      abortExportWork,
      abortRuntimeWork,
      beginRuntimeSession,
      embeddedPreviewUrlRef,
      getColorIntent,
      getLut,
      getPrewarmState,
      getSession,
      getView,
      isMountedRef,
      pendingLoadSessionIdRef,
      previewCopyCanvasRef,
      queueExportResultResourceDisposal,
      replaceFile,
      revokeCurrentEmbeddedPreviewUrl,
      notify,
      runtimeWorkSessionIdRef,
      setColorIntent,
      setDecodedImageRef,
      setError,
      setProgress,
      setSession,
      setStatus,
      yieldToPaint,
    ],
  )

  const loadFile = useCallback(
    (file: File) => orchestrateRawLoad(file, rawLoadCtx),
    [rawLoadCtx],
  )

  return { loadFile }
}
