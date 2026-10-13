import type { RawRenderExposure } from '@lumaforge/luma-color-runtime'
import { useMemo, useRef, useState } from 'react'

import type { ResourceRegistry } from '~/lib/export/resource-registry'
import { createResourceRegistry } from '~/lib/export/resource-registry'
import type { DecodedImage } from '~/lib/raw/decoder'
import { createRawRuntimeHost } from '~/lib/raw/raw-runtime-host'
import type { RawProcessingPipeline } from '~/lib/webgpu/raw-processing-pipeline'

export function useRawWorkflowRefs() {
  // The one RAW host of this workflow: readiness, load, restore, and the
  // bridge release before export all drive this instance. It owns every RAW
  // session and its cancellation; the workflow keeps only source epochs.
  const [rawRuntimeHost] = useState(() => createRawRuntimeHost())
  const pipelineRef = useRef<RawProcessingPipeline | null>(null)
  const resourceRegistryRef = useRef<ResourceRegistry | null>(null)
  const previewCopyCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const embeddedPreviewUrlRef = useRef<string | null>(null)
  const isMountedRef = useRef(false)
  const runtimeWorkSessionIdRef = useRef<string | null>(null)
  const pendingLoadSessionIdRef = useRef<string | null>(null)
  const exportAbortControllerRef = useRef<AbortController | null>(null)
  const exportGraphVersionRef = useRef(0)
  const decodedImageRef = useRef<DecodedImage | null>(null)
  const rawRenderExposureRef = useRef<RawRenderExposure | null>(null)

  if (!resourceRegistryRef.current) {
    resourceRegistryRef.current = createResourceRegistry()
  }

  return useMemo(
    () => ({
      rawRuntimeHost,
      pipelineRef,
      resourceRegistryRef,
      previewCopyCanvasRef,
      embeddedPreviewUrlRef,
      isMountedRef,
      runtimeWorkSessionIdRef,
      pendingLoadSessionIdRef,
      exportAbortControllerRef,
      exportGraphVersionRef,
      decodedImageRef,
      rawRenderExposureRef,
    }),
    [
      decodedImageRef,
      embeddedPreviewUrlRef,
      exportAbortControllerRef,
      exportGraphVersionRef,
      isMountedRef,
      pendingLoadSessionIdRef,
      pipelineRef,
      previewCopyCanvasRef,
      rawRenderExposureRef,
      rawRuntimeHost,
      resourceRegistryRef,
      runtimeWorkSessionIdRef,
    ],
  )
}
