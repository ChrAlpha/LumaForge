import type { MutableRefObject } from 'react'
import { useEffect } from 'react'

import type { DecodedImage } from '~/lib/raw/decoder'
import type { PipelineStats } from '~/lib/webgpu/raw-processing-pipeline'

import type { ImageSession } from '../../../model/session'
import type { ProcessingStatus } from '../../../model/workflow'
import { releaseSourceForUnmount } from '../../../services/workflow/raw-workflow-resources'
import type { SetImageSession } from '../../../state/session.atoms'

type UseRawProcessorLifecycleInput = {
  isMountedRef: MutableRefObject<boolean>
  runtimeWorkSessionIdRef: MutableRefObject<string | null>
  pendingLoadSessionIdRef: MutableRefObject<string | null>
  /** The session this mount last published to the store. */
  ownedSessionIdRef: MutableRefObject<string | null>
  decodedImageRef: MutableRefObject<DecodedImage | null>
  previewCopyCanvasRef: MutableRefObject<HTMLCanvasElement | null>
  /** Reads the session store when called, not the last render. */
  getSession: () => ImageSession | null
  abortExportWork: () => void
  abortRuntimeWork: () => void
  queueExportResultResourceDisposal: () => void
  /**
   * Revokes the preview URL this mount holds and, while the store holds the
   * session it names, that session's URL; another session's is left alone.
   */
  revokeCurrentEmbeddedPreviewUrl: (ownerSessionId?: string | null) => void
  setStatus: (status: ProcessingStatus) => void
  setError: (error: string | null) => void
  setProgress: (progress: number) => void
  setStats: (stats: PipelineStats | null) => void
  setSession: SetImageSession
}

export function useRawProcessorLifecycle({
  isMountedRef,
  runtimeWorkSessionIdRef,
  pendingLoadSessionIdRef,
  ownedSessionIdRef,
  decodedImageRef,
  previewCopyCanvasRef,
  getSession,
  abortExportWork,
  abortRuntimeWork,
  queueExportResultResourceDisposal,
  revokeCurrentEmbeddedPreviewUrl,
  setStatus,
  setError,
  setProgress,
  setStats,
  setSession,
}: UseRawProcessorLifecycleInput) {
  useEffect(() => {
    isMountedRef.current = true

    // Drops this mount's decoded frame and ends the session it published,
    // with the processor state that describes it, while the store still holds
    // that session. A session a newer load or another mount has put there
    // since, and its status, are not this mount's to clear.
    const depart = (sessionId: string | null) => {
      decodedImageRef.current = null
      if (!sessionId || getSession()?.id !== sessionId) return
      setStatus('idle')
      setError(null)
      setProgress(0)
      setStats(null)
      setSession((prev) => (prev?.id === sessionId ? null : prev))
      if (ownedSessionIdRef.current === sessionId) {
        ownedSessionIdRef.current = null
      }
    }

    return () => {
      isMountedRef.current = false
      // The session this mount published, read before the release: the
      // preview URL it clears from the store must be that session's, never
      // one a new mount has published since.
      const ownedSessionId = ownedSessionIdRef.current
      const pendingLoadSessionId = releaseSourceForUnmount({
        runtimeWorkSessionIdRef,
        pendingLoadSessionIdRef,
        previewCopyCanvasRef,
        abortExportWork,
        abortRuntimeWork,
        queueExportResultResourceDisposal,
        revokeCurrentEmbeddedPreviewUrl: () =>
          revokeCurrentEmbeddedPreviewUrl(ownedSessionId),
      })
      // A load still pending was cancelled above and can never finish, so it
      // is dropped at once.
      if (pendingLoadSessionId) {
        depart(pendingLoadSessionId)
        return
      }
      // A loaded session described resources this mount has just released:
      // its decoded frame, RAW session, preview URL, and delivered output.
      // It ends with the mount, but only once the mount has really departed.
      // A StrictMode replay sets the effect up again in the same commit,
      // before this check runs, and keeps the session usable.
      queueMicrotask(() => {
        if (isMountedRef.current) return
        depart(ownedSessionIdRef.current)
      })
    }
  }, [
    abortExportWork,
    abortRuntimeWork,
    decodedImageRef,
    getSession,
    isMountedRef,
    ownedSessionIdRef,
    pendingLoadSessionIdRef,
    previewCopyCanvasRef,
    queueExportResultResourceDisposal,
    revokeCurrentEmbeddedPreviewUrl,
    runtimeWorkSessionIdRef,
    setError,
    setProgress,
    setSession,
    setStats,
    setStatus,
  ])
}
