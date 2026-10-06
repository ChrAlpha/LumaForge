import type { RawRenderExposure } from '@lumaforge/luma-color-runtime'
import type { MutableRefObject } from 'react'
import { useCallback } from 'react'

import type { DecodedImage } from '~/lib/raw/decoder'
import type { RawRuntimeSession } from '~/lib/raw/runtime-adapter'
import { rawRuntimeAdapter } from '~/lib/raw/runtime-adapter'

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
  loadedFile: File | null
  sessionRef: MutableRefObject<ImageSession | null>
  /** The source exposure pin the restored frame must render with. */
  rawRenderExposureRef: MutableRefObject<RawRenderExposure | null>
  isMountedRef: MutableRefObject<boolean>
  runtimeAbortControllerRef: MutableRefObject<AbortController | null>
  runtimeWorkSessionIdRef: MutableRefObject<string | null>
  runtimeSessionRef: MutableRefObject<RawRuntimeSession | null>
  setStatus: (status: ProcessingStatus) => void
  setProgress: (progress: number) => void
  setError: (error: string | null) => void
  setSession: SetImageSession
  setDecodedImageRef: (
    decoded: DecodedImage | null,
    options?: { preserveExportResult?: boolean },
  ) => void
  abortRuntimeWork: () => void
  disposeRuntimeSession: (runtimeSession?: RawRuntimeSession | null) => void
  openSession?: typeof rawRuntimeAdapter.openSession
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
  loadedFile,
  sessionRef,
  rawRenderExposureRef,
  isMountedRef,
  runtimeAbortControllerRef,
  runtimeWorkSessionIdRef,
  runtimeSessionRef,
  setStatus,
  setProgress,
  setError,
  setSession,
  setDecodedImageRef,
  abortRuntimeWork,
  disposeRuntimeSession,
  openSession = rawRuntimeAdapter.openSession,
  scheduleToast,
  toast,
}: UseRestorePreviewAfterExportInput) {
  const restorePreviewAfterExport = useCallback(async () => {
    const activeSession = sessionRef.current

    if (!activeSession || !loadedFile) {
      return
    }

    // The restored frame is the same source, so it reuses the pin instead of
    // re-estimating; without a pin it decodes as the source's first quick.
    const pinnedExposure = rawRenderExposureRef.current
    abortRuntimeWork()
    const restoreAbortController = new AbortController()
    runtimeAbortControllerRef.current = restoreAbortController
    runtimeWorkSessionIdRef.current = activeSession.id
    setStatus('decoding')
    setProgress(0)
    setError(null)

    let runtimeSession: RawRuntimeSession | null = null
    const matchesActiveSession = () =>
      isMountedRef.current &&
      !restoreAbortController.signal.aborted &&
      sessionRef.current?.id === activeSession.id &&
      runtimeWorkSessionIdRef.current === activeSession.id

    try {
      runtimeSession = await openSession(
        loadedFile,
        restoreAbortController.signal,
      )
      if (!matchesActiveSession()) {
        return
      }

      runtimeSessionRef.current = runtimeSession
      const decoded = await runtimeSession.decodeQuickRaw(
        ({ phase, progress }) => {
          if (!matchesActiveSession()) return
          setStatus(mapPhaseToStatus(phase))
          setProgress(progress)
        },
        restoreAbortController.signal,
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
      if (runtimeAbortControllerRef.current === restoreAbortController) {
        runtimeAbortControllerRef.current = null
      }
      if (runtimeWorkSessionIdRef.current === activeSession.id) {
        runtimeWorkSessionIdRef.current = null
      }
      if (runtimeSession) {
        disposeRuntimeSession(runtimeSession)
      }
    }
  }, [
    abortRuntimeWork,
    disposeRuntimeSession,
    isMountedRef,
    loadedFile,
    openSession,
    rawRenderExposureRef,
    runtimeAbortControllerRef,
    runtimeSessionRef,
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
