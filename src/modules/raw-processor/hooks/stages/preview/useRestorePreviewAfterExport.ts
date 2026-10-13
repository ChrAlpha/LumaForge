import type { RawRenderExposure } from '@lumaforge/luma-color-runtime'
import type { MutableRefObject } from 'react'
import { useCallback } from 'react'
import { toast } from 'sonner'

import type { DecodedImage } from '~/lib/raw/decoder'
import type { RawRuntimeHost } from '~/lib/raw/raw-runtime-host'

import type { ImageSession } from '../../../model/session'
import type { ProcessingStatus } from '../../../model/workflow'
import { mapRawDecodePhaseToProcessingStatus } from '../../../services/ingest/workflow-status'
import type { SetImageSession } from '../../../state/session.atoms'
import { useLatestTranslate } from '../../useLatestTranslate'

type UseRestorePreviewAfterExportInput = {
  /** Reads the current session from the store, not from the last render. */
  getSession: () => ImageSession | null
  /** The live decoded frame; a restore only runs once export released it. */
  decodedImageRef: MutableRefObject<DecodedImage | null>
  /** The source exposure pin the restored frame must render with. */
  rawRenderExposureRef: MutableRefObject<RawRenderExposure | null>
  isMountedRef: MutableRefObject<boolean>
  runtimeWorkSessionIdRef: MutableRefObject<string | null>
  /**
   * Takes the workflow host's one session slot. A load or reset that starts
   * while the restore runs cancels this lease, and its end disposes the
   * restored session exactly once.
   */
  beginRuntimeSession: RawRuntimeHost['beginSession']
  setStatus: (status: ProcessingStatus) => void
  setProgress: (progress: number) => void
  setError: (error: string | null) => void
  setSession: SetImageSession
  setDecodedImageRef: (
    decoded: DecodedImage | null,
    options?: { preserveExportResult?: boolean },
  ) => void
  scheduleToast: (notify: () => void) => void
}

/**
 * A restore brings back only a preview an export released: the export plan
 * that released it no longer runs, no decoded frame is live, and no load or
 * restore holds the runtime work fence. Anything else keeps the RAW lease it
 * holds, so a stale callback neither takes nor cancels one.
 */
function canAdmitRestore(
  session: ImageSession,
  hasLiveDecodedFrame: boolean,
  runtimeWorkSessionId: string | null,
): boolean {
  const { exportState } = session
  return (
    runtimeWorkSessionId === null &&
    !hasLiveDecodedFrame &&
    Boolean(exportState.activePlan) &&
    exportState.status !== 'preparing' &&
    exportState.status !== 'exporting'
  )
}

export function useRestorePreviewAfterExport({
  getSession,
  decodedImageRef,
  rawRenderExposureRef,
  isMountedRef,
  runtimeWorkSessionIdRef,
  beginRuntimeSession,
  setStatus,
  setProgress,
  setError,
  setSession,
  setDecodedImageRef,
  scheduleToast,
}: UseRestorePreviewAfterExportInput) {
  const t = useLatestTranslate()

  const restorePreviewAfterExport = useCallback(async () => {
    if (!isMountedRef.current) {
      return
    }
    const activeSession = getSession()
    // The file comes from the session the restore fences on, read from the
    // store when it runs, never from an older render, so a restore can only
    // decode the source it publishes to.
    const sourceFile = activeSession?.sourceFile.file

    if (
      !activeSession ||
      !sourceFile ||
      !canAdmitRestore(
        activeSession,
        decodedImageRef.current !== null,
        runtimeWorkSessionIdRef.current,
      )
    ) {
      return
    }

    // The restored frame is the same source, so it reuses the pin instead of
    // re-estimating; without a pin it decodes as the source's first quick.
    const pinnedExposure = rawRenderExposureRef.current
    const lease = beginRuntimeSession()
    runtimeWorkSessionIdRef.current = activeSession.id
    setStatus('decoding')
    setProgress(0)
    setError(null)

    const matchesActiveSession = () =>
      isMountedRef.current &&
      !lease.signal.aborted &&
      getSession()?.id === activeSession.id &&
      runtimeWorkSessionIdRef.current === activeSession.id

    try {
      const runtimeSession = await lease.open(sourceFile)
      if (!matchesActiveSession()) {
        return
      }

      const decoded = await runtimeSession.decodeQuickRaw(
        ({ phase, progress }) => {
          if (!matchesActiveSession()) return
          setStatus(mapRawDecodePhaseToProcessingStatus(phase))
          setProgress(progress)
        },
        lease.signal,
        pinnedExposure ? { pinnedExposure } : undefined,
      )

      if (!matchesActiveSession()) {
        return
      }

      setDecodedImageRef(decoded, { preserveExportResult: true })
      setSession((prev) =>
        prev && prev.id === activeSession.id
          ? {
              ...prev,
              previewBundle: {
                ...prev.previewBundle,
                quickDecodePreview: {
                  status: 'ready',
                  width: decoded.width,
                  height: decoded.height,
                },
                displaySource: 'quick',
              },
              sourceFile: {
                ...prev.sourceFile,
                metadata: decoded.metadata,
              },
            }
          : prev,
      )
      setStatus('ready')
      setProgress(100)
    } catch (err) {
      if (!matchesActiveSession()) {
        return
      }

      // A runtime's own message is shown as given.
      const title = t('raw.preview.restoreFailed')
      const description =
        err instanceof Error ? err.message : t('raw.preview.restoreFallback')
      setStatus('ready')
      setProgress(0)
      scheduleToast(() =>
        toast.error(title, {
          description,
        }),
      )
    } finally {
      if (runtimeWorkSessionIdRef.current === activeSession.id) {
        runtimeWorkSessionIdRef.current = null
      }
      // Ends only this restore's lease: a load that took the slot since then
      // keeps its own.
      lease.release()
    }
  }, [
    beginRuntimeSession,
    decodedImageRef,
    getSession,
    isMountedRef,
    rawRenderExposureRef,
    runtimeWorkSessionIdRef,
    scheduleToast,
    setDecodedImageRef,
    setError,
    setProgress,
    setSession,
    setStatus,
    t,
  ])

  return { restorePreviewAfterExport }
}
