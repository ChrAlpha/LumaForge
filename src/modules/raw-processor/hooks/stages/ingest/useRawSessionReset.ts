import type { MutableRefObject } from 'react'
import { useCallback } from 'react'

import type { ExportResourceCleanupReason } from '~/lib/export/execution-profile'
import type { DecodedImage } from '~/lib/raw/decoder'
import type { PipelineStats } from '~/lib/webgpu/raw-processing-pipeline'

import type { ProcessingStatus } from '../../../model/workflow'
import { releaseSourceForReset } from '../../../services/workflow/raw-workflow-resources'

type UseRawSessionResetInput = {
  runtimeWorkSessionIdRef: MutableRefObject<string | null>
  pendingLoadSessionIdRef: MutableRefObject<string | null>
  previewCopyCanvasRef: MutableRefObject<HTMLCanvasElement | null>
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
    setStatus('idle')
    setError(null)
    setProgress(0)
    setStats(null)
    resetSession()
  }, [
    abortExportWork,
    abortRuntimeWork,
    pendingLoadSessionIdRef,
    previewCopyCanvasRef,
    queueExportResultResourceDisposal,
    resetSession,
    revokeCurrentEmbeddedPreviewUrl,
    runtimeWorkSessionIdRef,
    setDecodedImageRef,
    setError,
    setProgress,
    setStats,
    setStatus,
  ])

  return { reset }
}
