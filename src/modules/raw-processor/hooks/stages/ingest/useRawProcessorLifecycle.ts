import type { MutableRefObject } from 'react'
import { useEffect } from 'react'

import type { DecodedImage } from '~/lib/raw/decoder'
import type { PipelineStats } from '~/lib/webgpu/raw-processing-pipeline'

import type { ImageSession } from '../../../model/session'
import type { ProcessingStatus } from '../../../model/workflow'

export type SetImageSession = (
  update:
    | ImageSession
    | null
    | ((prev: ImageSession | null) => ImageSession | null),
) => void

type UseRawProcessorLifecycleInput = {
  isMountedRef: MutableRefObject<boolean>
  runtimeWorkSessionIdRef: MutableRefObject<string | null>
  pendingLoadSessionIdRef: MutableRefObject<string | null>
  decodedImageRef: MutableRefObject<DecodedImage | null>
  previewCopyCanvasRef: MutableRefObject<HTMLCanvasElement | null>
  sessionRef: MutableRefObject<ImageSession | null>
  abortExportWork: () => void
  abortRuntimeWork: () => void
  queueExportResultResourceDisposal: () => void
  revokeCurrentEmbeddedPreviewUrl: () => void
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
  decodedImageRef,
  previewCopyCanvasRef,
  sessionRef,
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

    return () => {
      const pendingLoadSessionId = pendingLoadSessionIdRef.current
      isMountedRef.current = false
      runtimeWorkSessionIdRef.current = null
      pendingLoadSessionIdRef.current = null
      abortExportWork()
      abortRuntimeWork()
      queueExportResultResourceDisposal()
      revokeCurrentEmbeddedPreviewUrl()
      previewCopyCanvasRef.current = null
      if (pendingLoadSessionId) {
        decodedImageRef.current = null
        setStatus('idle')
        setError(null)
        setProgress(0)
        setStats(null)
        setSession((prev) => (prev?.id === pendingLoadSessionId ? null : prev))
      }
      sessionRef.current = null
    }
  }, [
    abortExportWork,
    abortRuntimeWork,
    decodedImageRef,
    isMountedRef,
    pendingLoadSessionIdRef,
    previewCopyCanvasRef,
    queueExportResultResourceDisposal,
    revokeCurrentEmbeddedPreviewUrl,
    runtimeWorkSessionIdRef,
    sessionRef,
    setError,
    setProgress,
    setSession,
    setStats,
    setStatus,
  ])
}
