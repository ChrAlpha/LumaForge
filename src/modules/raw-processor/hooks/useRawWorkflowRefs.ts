import type {
  ProcessingParams,
  RawRenderExposure,
} from '@lumaforge/luma-color-runtime'
import { useMemo, useRef } from 'react'

import type { ResourceRegistry } from '~/lib/export/resource-registry'
import { createResourceRegistry } from '~/lib/export/resource-registry'
import type { DecodedImage } from '~/lib/raw/decoder'
import type { RawRuntimeSession } from '~/lib/raw/runtime-adapter'
import type { RawProcessingPipeline } from '~/lib/webgpu/raw-processing-pipeline'

import type { ImageSession } from '../model/session'

type UseRawWorkflowRefsInput = {
  session: ImageSession | null
  initialParams: ProcessingParams
}

export function useRawWorkflowRefs({
  session,
  initialParams,
}: UseRawWorkflowRefsInput) {
  const pipelineRef = useRef<RawProcessingPipeline | null>(null)
  const resourceRegistryRef = useRef<ResourceRegistry | null>(null)
  const previewCopyCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const sessionRef = useRef<ImageSession | null>(session)
  const embeddedPreviewUrlRef = useRef<string | null>(null)
  const isMountedRef = useRef(false)
  const runtimeWorkSessionIdRef = useRef<string | null>(null)
  const pendingLoadSessionIdRef = useRef<string | null>(null)
  const runtimeSessionRef = useRef<RawRuntimeSession | null>(null)
  const runtimeAbortControllerRef = useRef<AbortController | null>(null)
  const exportAbortControllerRef = useRef<AbortController | null>(null)
  const exportGraphVersionRef = useRef(0)
  const disposedRuntimeSessionsRef = useRef<WeakSet<RawRuntimeSession>>(
    new WeakSet(),
  )
  const decodedImageRef = useRef<DecodedImage | null>(null)
  const paramsRef = useRef(initialParams)
  const rawRenderExposureRef = useRef<RawRenderExposure | null>(null)

  if (!resourceRegistryRef.current) {
    resourceRegistryRef.current = createResourceRegistry()
  }
  sessionRef.current = session

  return useMemo(
    () => ({
      pipelineRef,
      resourceRegistryRef,
      previewCopyCanvasRef,
      sessionRef,
      embeddedPreviewUrlRef,
      isMountedRef,
      runtimeWorkSessionIdRef,
      pendingLoadSessionIdRef,
      runtimeSessionRef,
      runtimeAbortControllerRef,
      exportAbortControllerRef,
      exportGraphVersionRef,
      disposedRuntimeSessionsRef,
      decodedImageRef,
      paramsRef,
      rawRenderExposureRef,
    }),
    [
      decodedImageRef,
      disposedRuntimeSessionsRef,
      embeddedPreviewUrlRef,
      exportAbortControllerRef,
      exportGraphVersionRef,
      isMountedRef,
      paramsRef,
      pendingLoadSessionIdRef,
      pipelineRef,
      previewCopyCanvasRef,
      rawRenderExposureRef,
      resourceRegistryRef,
      runtimeAbortControllerRef,
      runtimeSessionRef,
      runtimeWorkSessionIdRef,
      sessionRef,
    ],
  )
}
