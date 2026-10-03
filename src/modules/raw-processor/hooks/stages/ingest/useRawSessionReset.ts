import type { MutableRefObject } from 'react'
import { useCallback } from 'react'

import type { ExportResourceCleanupReason } from '~/lib/export/execution-profile'
import type { DecodedImage } from '~/lib/raw/decoder'
import type { PipelineStats } from '~/lib/webgpu/raw-processing-pipeline'

import type { ImageSession } from '../../../model/session'
import type { ProcessingStatus } from '../../../model/workflow'
import type { PendingRecoveryRetry } from '../export/useExportRecoveryAction'

type UseRawSessionResetInput = {
  runtimeWorkSessionIdRef: MutableRefObject<string | null>
  pendingLoadSessionIdRef: MutableRefObject<string | null>
  previewCopyCanvasRef: MutableRefObject<HTMLCanvasElement | null>
  sessionRef: MutableRefObject<ImageSession | null>
  setPendingRecoveryRetry: (retry: PendingRecoveryRetry | null) => void
  abortExportWork: () => void
  abortRuntimeWork: () => void
  queueExportResultResourceDisposal: (
    reason?: ExportResourceCleanupReason,
  ) => void
  revokeCurrentEmbeddedPreviewUrl: () => void
  setDecodedImageRef: (
    decoded: DecodedImage | null,
    options?: { preserveExportResult?: boolean },
  ) => void
  setStatus: (status: ProcessingStatus) => void
  setError: (error: string | null) => void
  setProgress: (progress: number) => void
  setStats: (stats: PipelineStats | null) => void
  resetSession: () => void
}

export function useRawSessionReset({
  runtimeWorkSessionIdRef,
  pendingLoadSessionIdRef,
  previewCopyCanvasRef,
  sessionRef,
  setPendingRecoveryRetry,
  abortExportWork,
  abortRuntimeWork,
  queueExportResultResourceDisposal,
  revokeCurrentEmbeddedPreviewUrl,
  setDecodedImageRef,
  setStatus,
  setError,
  setProgress,
  setStats,
  resetSession,
}: UseRawSessionResetInput) {
  const reset = useCallback(() => {
    runtimeWorkSessionIdRef.current = null
    pendingLoadSessionIdRef.current = null
    setPendingRecoveryRetry(null)
    abortExportWork()
    abortRuntimeWork()
    queueExportResultResourceDisposal('reset-session')
    revokeCurrentEmbeddedPreviewUrl()
    previewCopyCanvasRef.current = null
    setDecodedImageRef(null)
    setStatus('idle')
    setError(null)
    setProgress(0)
    setStats(null)
    resetSession()
    sessionRef.current = null
  }, [
    abortExportWork,
    abortRuntimeWork,
    pendingLoadSessionIdRef,
    previewCopyCanvasRef,
    queueExportResultResourceDisposal,
    resetSession,
    revokeCurrentEmbeddedPreviewUrl,
    runtimeWorkSessionIdRef,
    sessionRef,
    setDecodedImageRef,
    setError,
    setPendingRecoveryRetry,
    setProgress,
    setStats,
    setStatus,
  ])

  return { reset }
}
