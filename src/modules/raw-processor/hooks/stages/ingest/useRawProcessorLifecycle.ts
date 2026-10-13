import { useEffect } from 'react'

import { releaseSourceForUnmount } from '../../../services/workflow/raw-workflow-resources'
import { rawWorkflowStore } from '../../../state/workflow.atoms'
import type { RawWorkflowRuntime } from '../../useRawWorkflowRefs'

type UseRawProcessorLifecycleInput = Pick<
  RawWorkflowRuntime,
  | 'isMountedRef'
  | 'runtimeWorkSessionIdRef'
  | 'pendingLoadSessionIdRef'
  | 'ownedSessionIdRef'
  | 'decodedImageRef'
  | 'previewCopyCanvasRef'
> & {
  abortExportWork: () => void
  abortRuntimeWork: () => void
  queueExportResultResourceDisposal: () => void
  /**
   * Revokes the preview URL this mount holds and, while the store holds the
   * session it names, that session's URL; another session's is left alone.
   */
  revokeCurrentEmbeddedPreviewUrl: (ownerSessionId?: string | null) => void
}

export function useRawProcessorLifecycle({
  isMountedRef,
  runtimeWorkSessionIdRef,
  pendingLoadSessionIdRef,
  ownedSessionIdRef,
  decodedImageRef,
  previewCopyCanvasRef,
  abortExportWork,
  abortRuntimeWork,
  queueExportResultResourceDisposal,
  revokeCurrentEmbeddedPreviewUrl,
}: UseRawProcessorLifecycleInput) {
  useEffect(() => {
    isMountedRef.current = true

    // Drops this mount's decoded frame and ends the session it published,
    // with the processor state that describes it, while the store still holds
    // that session. A session a newer load or another mount has put there
    // since, and its status, are not this mount's to clear.
    const depart = (sessionId: string | null) => {
      decodedImageRef.current = null
      if (!sessionId || rawWorkflowStore.getSession()?.id !== sessionId) return
      rawWorkflowStore.setStatus('idle')
      rawWorkflowStore.setError(null)
      rawWorkflowStore.setProgress(0)
      rawWorkflowStore.setStats(null)
      rawWorkflowStore.setSession((prev) =>
        prev?.id === sessionId ? null : prev,
      )
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
    isMountedRef,
    ownedSessionIdRef,
    pendingLoadSessionIdRef,
    previewCopyCanvasRef,
    queueExportResultResourceDisposal,
    revokeCurrentEmbeddedPreviewUrl,
    runtimeWorkSessionIdRef,
  ])
}
