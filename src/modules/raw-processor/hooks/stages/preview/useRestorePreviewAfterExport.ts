import type { RawRenderExposure } from '@lumaforge/luma-color-runtime'
import type { MutableRefObject } from 'react'
import { useCallback } from 'react'

import type { DecodedImage } from '~/lib/raw/decoder'
import type { RawRuntimeHost } from '~/lib/raw/raw-runtime-host'

import type { ImageSession } from '../../../model/session'
import type { ProcessingStatus } from '../../../model/workflow'

type RestorePreviewPhase = 'loading' | 'decoding' | 'processing' | 'complete'

export type SetImageSession = (
  update:
    | ImageSession
    | null
    | ((prev: ImageSession | null) => ImageSession | null),
) => void

type UseRestorePreviewAfterExportInput = {
  sessionRef: MutableRefObject<ImageSession | null>
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
  toast: {
    error: (message: string, options?: { description?: string }) => void
  }
}

function mapPhaseToStatus(phase: RestorePreviewPhase): ProcessingStatus {
  if (phase === 'loading') return 'loading'
  if (phase === 'decoding') return 'decoding'
  if (phase === 'processing') return 'processing'
  return 'ready'
}

export function useRestorePreviewAfterExport({
  sessionRef,
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
  toast,
}: UseRestorePreviewAfterExportInput) {
  const restorePreviewAfterExport = useCallback(async () => {
    const activeSession = sessionRef.current
    // The file comes from the session the restore fences on, never from an
    // older render, so a restore can only decode the source it publishes to.
    const sourceFile = activeSession?.sourceFile.file

    if (!activeSession || !sourceFile) {
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
      sessionRef.current?.id === activeSession.id &&
      runtimeWorkSessionIdRef.current === activeSession.id

    try {
      const runtimeSession = await lease.open(sourceFile)
      if (!matchesActiveSession()) {
        return
      }

      const decoded = await runtimeSession.decodeQuickRaw(
        ({ phase, progress }) => {
          if (!matchesActiveSession()) return
          setStatus(mapPhaseToStatus(phase))
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
                  timings: decoded.timings,
                },
                displaySource: 'quick',
              },
              renderState: {
                ...prev.renderState,
                status: 'ready',
                lastRenderSource: 'quick',
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

      const description =
        err instanceof Error ? err.message : 'Preview restore failed.'
      setStatus('ready')
      setProgress(0)
      scheduleToast(() =>
        toast.error('Preview restore failed', {
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
    isMountedRef,
    rawRenderExposureRef,
    runtimeWorkSessionIdRef,
    scheduleToast,
    sessionRef,
    setDecodedImageRef,
    setError,
    setProgress,
    setSession,
    setStatus,
    toast,
  ])

  return { restorePreviewAfterExport }
}
