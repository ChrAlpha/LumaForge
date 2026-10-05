import type {
  LUTData,
  ProcessingParams,
  RawRenderExposure,
} from '@lumaforge/luma-color-runtime'
import { useAtomValue } from 'jotai'
import type { Dispatch, MutableRefObject, SetStateAction } from 'react'

import type { ResourceRegistry } from '~/lib/export/resource-registry'
import type { DecodedImage } from '~/lib/raw/decoder'
import type { RawRuntimeSession } from '~/lib/raw/runtime-adapter'
import type { RawProcessingPipeline } from '~/lib/webgpu/raw-processing-pipeline'

import type { DisplaySource, ImageSession } from '../../../model/session'
import type { ProcessingStatus } from '../../../model/workflow'
import { previewHistogramEnabledAtom } from '../../../state/histogram.atoms'
import { usePreviewHistogram } from '../../usePreviewHistogram'
import { useDecodedPreviewResource } from './useDecodedPreviewResource'
import { useEmbeddedPreviewUrlLifecycle } from './useEmbeddedPreviewUrlLifecycle'
import type { PreviewPipelineEvacuationHandle } from './usePreviewPipelineEvacuation'
import { usePreviewPipelineEvacuation } from './usePreviewPipelineEvacuation'
import { useRestorePreviewAfterExport } from './useRestorePreviewAfterExport'

type UseRawPreviewStageInput = {
  loadedFile: File | null
  session: ImageSession | null
  sessionRef: MutableRefObject<ImageSession | null>
  pendingLoadSessionIdRef: MutableRefObject<string | null>
  decodedImageRef: MutableRefObject<DecodedImage | null>
  decodedImageVersion: number
  rawRenderExposureRef: MutableRefObject<RawRenderExposure | null>
  resourceRegistryRef: MutableRefObject<ResourceRegistry | null>
  setDecodedImageVersion: Dispatch<SetStateAction<number>>
  invalidateExportGraph: () => void
  embeddedPreviewUrlRef: MutableRefObject<string | null>
  setSession: Dispatch<SetStateAction<ImageSession | null>>
  pipelineRef: MutableRefObject<RawProcessingPipeline | null>
  params: ProcessingParams
  lutDataRef: MutableRefObject<LUTData | null>
  lutDataVersion: number
  displaySource: DisplaySource
  isMountedRef: MutableRefObject<boolean>
  runtimeAbortControllerRef: MutableRefObject<AbortController | null>
  runtimeWorkSessionIdRef: MutableRefObject<string | null>
  runtimeSessionRef: MutableRefObject<RawRuntimeSession | null>
  setStatus: (status: ProcessingStatus) => void
  setProgress: (progress: number) => void
  setError: (error: string | null) => void
  abortRuntimeWork: () => void
  disposeRuntimeSession: (runtimeSession?: RawRuntimeSession | null) => void
  openSession: typeof import('~/lib/raw/runtime-adapter').rawRuntimeAdapter.openSession
  scheduleToast: (notify: () => void) => void
  toast: {
    error: (message: string, options?: { description?: string }) => void
  }
}

export function useRawPreviewStage({
  loadedFile,
  session,
  sessionRef,
  pendingLoadSessionIdRef,
  decodedImageRef,
  decodedImageVersion,
  rawRenderExposureRef,
  resourceRegistryRef,
  setDecodedImageVersion,
  invalidateExportGraph,
  embeddedPreviewUrlRef,
  setSession,
  pipelineRef,
  params,
  lutDataRef,
  lutDataVersion,
  displaySource,
  isMountedRef,
  runtimeAbortControllerRef,
  runtimeWorkSessionIdRef,
  runtimeSessionRef,
  setStatus,
  setProgress,
  setError,
  abortRuntimeWork,
  disposeRuntimeSession,
  openSession,
  scheduleToast,
  toast,
}: UseRawPreviewStageInput) {
  const { clearSessionEmbeddedPreviewUrl, revokeCurrentEmbeddedPreviewUrl } =
    useEmbeddedPreviewUrlLifecycle({
      embeddedPreviewUrlRef,
      sessionRef,
      setSession,
    })
  const {
    registerCurrentPreviewPipelineForEvacuation,
    setOriginalPreviewPipeline,
  } = usePreviewPipelineEvacuation({
    resourceRegistryRef,
    pipelineRef,
  })
  const histogramEnabled = useAtomValue(previewHistogramEnabledAtom)
  const histogram = usePreviewHistogram({
    enabled: histogramEnabled,
    imageRef: decodedImageRef,
    imageVersion: decodedImageVersion,
    imageIdentity: session?.id ?? pendingLoadSessionIdRef.current ?? undefined,
    params,
    lutDataRef,
    lutDataVersion,
    displaySource,
  })
  const { setDecodedImageRef } = useDecodedPreviewResource({
    decodedImageRef,
    rawRenderExposureRef,
    resourceRegistryRef,
    setDecodedImageVersion,
    invalidateExportGraph,
  })
  const { restorePreviewAfterExport } = useRestorePreviewAfterExport({
    loadedFile,
    sessionRef,
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
    openSession,
    scheduleToast,
    toast,
  })

  return {
    histogram,
    clearSessionEmbeddedPreviewUrl,
    revokeCurrentEmbeddedPreviewUrl,
    registerCurrentPreviewPipelineForEvacuation,
    setOriginalPreviewPipeline: setOriginalPreviewPipeline as (
      pipeline: PreviewPipelineEvacuationHandle | null,
    ) => void,
    setDecodedImageRef,
    restorePreviewAfterExport,
  }
}
