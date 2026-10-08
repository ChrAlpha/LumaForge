import type {
  ColorGraphIntent,
  LUTData,
  RawRenderExposure,
} from '@lumaforge/luma-color-runtime'
import { useAtomValue } from 'jotai'
import type { Dispatch, MutableRefObject, SetStateAction } from 'react'

import type { ResourceRegistry } from '~/lib/export/resource-registry'
import type { DecodedImage } from '~/lib/raw/decoder'
import type { RawRuntimeHost } from '~/lib/raw/raw-runtime-host'
import type { RawProcessingPipeline } from '~/lib/webgpu/raw-processing-pipeline'

import type { DisplaySource, ImageSession } from '../../../model/session'
import type { ProcessingStatus } from '../../../model/workflow'
import { previewHistogramEnabledAtom } from '../../../state/histogram.atoms'
import { getCurrentSession } from '../../../state/session.atoms'
import { usePreviewHistogram } from '../../usePreviewHistogram'
import { useDecodedPreviewResource } from './useDecodedPreviewResource'
import { useEmbeddedPreviewUrlLifecycle } from './useEmbeddedPreviewUrlLifecycle'
import { usePreviewPipelineEvacuation } from './usePreviewPipelineEvacuation'
import { useRestorePreviewAfterExport } from './useRestorePreviewAfterExport'

type UseRawPreviewStageInput = {
  session: ImageSession | null
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
  /** The color intent the preview renders; the view never reaches here. */
  params: ColorGraphIntent
  lutDataRef: MutableRefObject<LUTData | null>
  lutDataVersion: number
  displaySource: DisplaySource
  isMountedRef: MutableRefObject<boolean>
  runtimeWorkSessionIdRef: MutableRefObject<string | null>
  /** Restore takes its RAW session from the workflow host's one slot. */
  beginRuntimeSession: RawRuntimeHost['beginSession']
  setStatus: (status: ProcessingStatus) => void
  setProgress: (progress: number) => void
  setError: (error: string | null) => void
  scheduleToast: (notify: () => void) => void
  toast: {
    error: (message: string, options?: { description?: string }) => void
  }
}

/** A frame belongs to the session the store holds when it is accepted. */
function getCurrentSessionId(): string | null {
  return getCurrentSession()?.id ?? null
}

export function useRawPreviewStage({
  session,
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
  runtimeWorkSessionIdRef,
  beginRuntimeSession,
  setStatus,
  setProgress,
  setError,
  scheduleToast,
  toast,
}: UseRawPreviewStageInput) {
  // Embedded URL cleanup and restore read the session in the store when they
  // run, so a load or reset landing before this stage rerenders is the source
  // they act on.
  const { clearSessionEmbeddedPreviewUrl, revokeCurrentEmbeddedPreviewUrl } =
    useEmbeddedPreviewUrlLifecycle({
      embeddedPreviewUrlRef,
      getSession: getCurrentSession,
      setSession,
    })
  const {
    registerCurrentPreviewPipelineForEvacuation,
    setOriginalPreviewPipeline,
  } = usePreviewPipelineEvacuation({
    resourceRegistryRef,
    pipelineRef,
  })
  const { setDecodedImageRef, decodedFrame } = useDecodedPreviewResource({
    decodedImageRef,
    rawRenderExposureRef,
    resourceRegistryRef,
    setDecodedImageVersion,
    invalidateExportGraph,
    getSessionId: getCurrentSessionId,
  })
  const histogramEnabled = useAtomValue(previewHistogramEnabledAtom)
  const histogram = usePreviewHistogram({
    enabled: histogramEnabled,
    imageRef: decodedImageRef,
    imageVersion: decodedImageVersion,
    imageIdentity: session?.id ?? pendingLoadSessionIdRef.current ?? undefined,
    frame: decodedFrame,
    params,
    lutDataRef,
    lutDataVersion,
    displaySource,
  })
  const { restorePreviewAfterExport } = useRestorePreviewAfterExport({
    getSession: getCurrentSession,
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
  })

  return {
    /**
     * The accepted descriptor of the live decoded frame, the object the
     * histogram receives; null while no decoded frame is live.
     */
    decodedFrame,
    histogram,
    clearSessionEmbeddedPreviewUrl,
    revokeCurrentEmbeddedPreviewUrl,
    registerCurrentPreviewPipelineForEvacuation,
    setOriginalPreviewPipeline,
    setDecodedImageRef,
    restorePreviewAfterExport,
  }
}
