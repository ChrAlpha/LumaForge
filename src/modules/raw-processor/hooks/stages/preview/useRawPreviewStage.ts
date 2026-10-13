import type { RawRenderExposure } from '@lumaforge/luma-color-runtime'
import type { Dispatch, MutableRefObject, SetStateAction } from 'react'

import type { ResourceRegistry } from '~/lib/export/resource-registry'
import type { DecodedImage } from '~/lib/raw/decoder'
import type { RawRuntimeHost } from '~/lib/raw/raw-runtime-host'
import type { RawProcessingPipeline } from '~/lib/webgpu/raw-processing-pipeline'

import type { ImageSession } from '../../../model/session'
import type { ProcessingStatus } from '../../../model/workflow'
import { getCurrentSession } from '../../../state/session.atoms'
import { useDecodedPreviewResource } from './useDecodedPreviewResource'
import { useEmbeddedPreviewUrlLifecycle } from './useEmbeddedPreviewUrlLifecycle'
import { usePreviewPipelineEvacuation } from './usePreviewPipelineEvacuation'
import { useRestorePreviewAfterExport } from './useRestorePreviewAfterExport'

type UseRawPreviewStageInput = {
  decodedImageRef: MutableRefObject<DecodedImage | null>
  rawRenderExposureRef: MutableRefObject<RawRenderExposure | null>
  resourceRegistryRef: MutableRefObject<ResourceRegistry | null>
  setDecodedImageVersion: Dispatch<SetStateAction<number>>
  invalidateExportGraph: () => void
  embeddedPreviewUrlRef: MutableRefObject<string | null>
  setSession: Dispatch<SetStateAction<ImageSession | null>>
  pipelineRef: MutableRefObject<RawProcessingPipeline | null>
  isMountedRef: MutableRefObject<boolean>
  runtimeWorkSessionIdRef: MutableRefObject<string | null>
  /** Restore takes its RAW session from the workflow host's one slot. */
  beginRuntimeSession: RawRuntimeHost['beginSession']
  setStatus: (status: ProcessingStatus) => void
  setProgress: (progress: number) => void
  setError: (error: string | null) => void
  scheduleToast: (notify: () => void) => void
}

/** A frame belongs to the session the store holds when it is accepted. */
function getCurrentSessionId(): string | null {
  return getCurrentSession()?.id ?? null
}

export function useRawPreviewStage({
  decodedImageRef,
  rawRenderExposureRef,
  resourceRegistryRef,
  setDecodedImageVersion,
  invalidateExportGraph,
  embeddedPreviewUrlRef,
  setSession,
  pipelineRef,
  isMountedRef,
  runtimeWorkSessionIdRef,
  beginRuntimeSession,
  setStatus,
  setProgress,
  setError,
  scheduleToast,
}: UseRawPreviewStageInput) {
  // Embedded URL cleanup and restore read the session in the store when they
  // run, so a load or reset landing before this stage rerenders is the source
  // they act on.
  const { revokeCurrentEmbeddedPreviewUrl } = useEmbeddedPreviewUrlLifecycle({
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
  const { restorePreviewAfterExport } = useRestorePreviewAfterExport({
    getSession: getCurrentSession,
    decodedImageRef,
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
  })

  return {
    /**
     * The accepted descriptor of the live decoded frame, the object the
     * histogram receives; null while no decoded frame is live.
     */
    decodedFrame,
    revokeCurrentEmbeddedPreviewUrl,
    registerCurrentPreviewPipelineForEvacuation,
    setOriginalPreviewPipeline,
    setDecodedImageRef,
    restorePreviewAfterExport,
  }
}
