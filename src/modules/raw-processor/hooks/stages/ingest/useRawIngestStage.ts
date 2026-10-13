import { useCallback } from 'react'

import type { ExportResourceCleanupReason } from '~/lib/export/execution-profile'
import type { DecodedImage } from '~/lib/raw/decoder'

import type { ImageSession, StyleAsset } from '../../../model/session'
import { createImageSession } from '../../../model/session-factory'
import { releaseSourceForReset } from '../../../services/workflow/raw-workflow-resources'
import { rawWorkflowStore } from '../../../state/workflow.atoms'
import type { RawWorkflowRuntime } from '../../useRawWorkflowRefs'
import { useRawLoadAction } from './useRawLoadAction'
import { useRawProcessorLifecycle } from './useRawProcessorLifecycle'

type UseRawIngestStageInput = {
  runtime: RawWorkflowRuntime
  scheduleToast: (notify: () => void) => void
  abortRuntimeWork: () => void
  abortExportWork: () => void
  queueExportResultResourceDisposal: (
    reason?: ExportResourceCleanupReason,
  ) => void
  revokeCurrentEmbeddedPreviewUrl: (ownerSessionId?: string | null) => void
  setDecodedImageRef: (
    decoded: DecodedImage | null,
    options?: { preserveExportResult?: boolean },
  ) => void
}

export function useRawIngestStage({
  runtime,
  scheduleToast,
  abortRuntimeWork,
  abortExportWork,
  queueExportResultResourceDisposal,
  revokeCurrentEmbeddedPreviewUrl,
  setDecodedImageRef,
}: UseRawIngestStageInput) {
  const {
    rawRuntimeHost,
    isMountedRef,
    runtimeWorkSessionIdRef,
    pendingLoadSessionIdRef,
    ownedSessionIdRef,
    previewCopyCanvasRef,
    embeddedPreviewUrlRef,
  } = runtime
  // Publishes the new source's session to the store before it returns.
  const replaceFile = useCallback(
    (
      file: File,
      retained?: {
        activeStyle?: StyleAsset | null
        lutProfileSelection?: ImageSession['lutProfileSelection']
      },
    ) => {
      const next = createImageSession(file, retained)
      rawWorkflowStore.setSession(next)
      ownedSessionIdRef.current = next.id
      return next
    },
    [ownedSessionIdRef],
  )

  useRawProcessorLifecycle({
    ...runtime,
    abortExportWork,
    abortRuntimeWork,
    queueExportResultResourceDisposal,
    revokeCurrentEmbeddedPreviewUrl,
  })

  const { loadFile } = useRawLoadAction({
    scheduleToast,
    replaceFile,
    abortRuntimeWork,
    abortExportWork,
    queueExportResultResourceDisposal,
    revokeCurrentEmbeddedPreviewUrl,
    setDecodedImageRef,
    getPrewarmState: rawRuntimeHost.getPrewarmState,
    beginRuntimeSession: rawRuntimeHost.beginSession,
    embeddedPreviewUrlRef,
    isMountedRef,
    runtimeWorkSessionIdRef,
    pendingLoadSessionIdRef,
    previewCopyCanvasRef,
  })

  const reset = useCallback(() => {
    releaseSourceForReset({
      runtimeWorkSessionIdRef,
      pendingLoadSessionIdRef,
      previewCopyCanvasRef,
      abortExportWork,
      abortRuntimeWork,
      queueExportResultResourceDisposal,
      revokeCurrentEmbeddedPreviewUrl,
    })
    setDecodedImageRef(null)
    rawWorkflowStore.setStatus('idle')
    rawWorkflowStore.setError(null)
    rawWorkflowStore.setProgress(0)
    rawWorkflowStore.setStats(null)
    rawWorkflowStore.setSession(null)
  }, [
    abortExportWork,
    abortRuntimeWork,
    pendingLoadSessionIdRef,
    previewCopyCanvasRef,
    queueExportResultResourceDisposal,
    revokeCurrentEmbeddedPreviewUrl,
    runtimeWorkSessionIdRef,
    setDecodedImageRef,
  ])

  return { loadFile, reset }
}
