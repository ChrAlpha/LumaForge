import type { ColorGraphIntent } from '@lumaforge/luma-color-runtime'
import type { Dispatch, MutableRefObject, SetStateAction } from 'react'

import type { ExportResourceCleanupReason } from '~/lib/export/execution-profile'
import type { ParsedLUT } from '~/lib/lut/cube-parser'
import type { PreviewView } from '~/lib/preview/preview-view'
import type { DecodedImage } from '~/lib/raw/decoder'
import type { RawRuntimeHost } from '~/lib/raw/raw-runtime-host'
import type { PrewarmOutcome, PrewarmState } from '~/lib/raw/runtime-adapter'
import type { PipelineStats } from '~/lib/webgpu/raw-processing-pipeline'

import type { ImageSession, StyleAsset } from '../../../model/session'
import type { ProcessingStatus } from '../../../model/workflow'
import { useRawLoadAction } from './useRawLoadAction'
import { useRawProcessorLifecycle } from './useRawProcessorLifecycle'
import { useRawSessionReset } from './useRawSessionReset'

type SetColorIntent = (
  value: ColorGraphIntent | ((prev: ColorGraphIntent) => ColorGraphIntent),
) => void

type UseRawIngestStageInput = {
  setStatus: (status: ProcessingStatus) => void
  setError: (error: string | null) => void
  setProgress: (progress: number) => void
  getColorIntent: () => ColorGraphIntent
  getView: () => PreviewView
  getLut: () => ParsedLUT | null
  setColorIntent: SetColorIntent
  setSession: Dispatch<SetStateAction<ImageSession | null>>
  setDecodedImageVersion: Dispatch<SetStateAction<number>>
  setStats: (stats: PipelineStats | null) => void
  scheduleToast: (notify: () => void) => void
  replaceFile: (
    file: File,
    retained?: {
      activeStyle?: StyleAsset | null
      lutProfileSelection?: ImageSession['lutProfileSelection']
    },
  ) => ImageSession
  abortRuntimeWork: () => void
  abortExportWork: () => void
  queueExportResultResourceDisposal: (
    reason?: ExportResourceCleanupReason,
  ) => void
  revokeCurrentEmbeddedPreviewUrl: () => void
  clearSessionEmbeddedPreviewUrl: (sessionId?: string) => void
  setDecodedImageRef: (
    decoded: DecodedImage | null,
    options?: { preserveExportResult?: boolean },
  ) => void
  invalidateExportGraph: () => void
  registerCurrentPreviewPipelineForEvacuation: () => void
  yieldToPaint: () => Promise<void>
  getPrewarmState: () => PrewarmState
  prewarm: () => Promise<PrewarmOutcome>
  /** The workflow host owns each load's native session and cancellation. */
  beginRuntimeSession: RawRuntimeHost['beginSession']
  decodedImageRef: MutableRefObject<DecodedImage | null>
  sessionRef: MutableRefObject<ImageSession | null>
  embeddedPreviewUrlRef: MutableRefObject<string | null>
  isMountedRef: MutableRefObject<boolean>
  runtimeWorkSessionIdRef: MutableRefObject<string | null>
  pendingLoadSessionIdRef: MutableRefObject<string | null>
  previewCopyCanvasRef: MutableRefObject<HTMLCanvasElement | null>
  resetSession: () => void
}

export function useRawIngestStage(input: UseRawIngestStageInput) {
  useRawProcessorLifecycle({
    isMountedRef: input.isMountedRef,
    runtimeWorkSessionIdRef: input.runtimeWorkSessionIdRef,
    pendingLoadSessionIdRef: input.pendingLoadSessionIdRef,
    decodedImageRef: input.decodedImageRef,
    previewCopyCanvasRef: input.previewCopyCanvasRef,
    sessionRef: input.sessionRef,
    abortExportWork: input.abortExportWork,
    abortRuntimeWork: input.abortRuntimeWork,
    queueExportResultResourceDisposal: input.queueExportResultResourceDisposal,
    revokeCurrentEmbeddedPreviewUrl: input.revokeCurrentEmbeddedPreviewUrl,
    setStatus: input.setStatus,
    setError: input.setError,
    setProgress: input.setProgress,
    setStats: input.setStats,
    setSession: input.setSession,
  })

  const { loadFile } = useRawLoadAction(input)
  const { reset } = useRawSessionReset(input)

  return { loadFile, reset }
}
