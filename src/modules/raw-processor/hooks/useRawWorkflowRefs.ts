import type {
  ColorGraphIntent,
  RawRenderExposure,
} from '@lumaforge/luma-color-runtime'
import { useMemo, useRef, useState } from 'react'

import type { ResourceRegistry } from '~/lib/export/resource-registry'
import { createResourceRegistry } from '~/lib/export/resource-registry'
import type { PreviewView } from '~/lib/preview/preview-view'
import type { DecodedImage } from '~/lib/raw/decoder'
import { createRawRuntimeHost } from '~/lib/raw/raw-runtime-host'
import type { RawProcessingPipeline } from '~/lib/webgpu/raw-processing-pipeline'

import type { ImageSession } from '../model/session'

type UseRawWorkflowRefsInput = {
  session: ImageSession | null
  initialParams: ColorGraphIntent
  initialView: PreviewView
}

export function useRawWorkflowRefs({
  session,
  initialParams,
  initialView,
}: UseRawWorkflowRefsInput) {
  // The one RAW host of this workflow: readiness, load, restore, and the
  // bridge release before export all drive this instance. It owns every RAW
  // session and its cancellation; the workflow keeps only source epochs.
  const [rawRuntimeHost] = useState(() => createRawRuntimeHost())
  const pipelineRef = useRef<RawProcessingPipeline | null>(null)
  const resourceRegistryRef = useRef<ResourceRegistry | null>(null)
  const previewCopyCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const sessionRef = useRef<ImageSession | null>(session)
  const embeddedPreviewUrlRef = useRef<string | null>(null)
  const isMountedRef = useRef(false)
  const runtimeWorkSessionIdRef = useRef<string | null>(null)
  const pendingLoadSessionIdRef = useRef<string | null>(null)
  const exportAbortControllerRef = useRef<AbortController | null>(null)
  const exportGraphVersionRef = useRef(0)
  const decodedImageRef = useRef<DecodedImage | null>(null)
  // The color and the view as last rendered, each in its own ref.
  const paramsRef = useRef(initialParams)
  const viewRef = useRef(initialView)
  const rawRenderExposureRef = useRef<RawRenderExposure | null>(null)

  if (!resourceRegistryRef.current) {
    resourceRegistryRef.current = createResourceRegistry()
  }
  sessionRef.current = session

  return useMemo(
    () => ({
      rawRuntimeHost,
      pipelineRef,
      resourceRegistryRef,
      previewCopyCanvasRef,
      sessionRef,
      embeddedPreviewUrlRef,
      isMountedRef,
      runtimeWorkSessionIdRef,
      pendingLoadSessionIdRef,
      exportAbortControllerRef,
      exportGraphVersionRef,
      decodedImageRef,
      paramsRef,
      viewRef,
      rawRenderExposureRef,
    }),
    [
      decodedImageRef,
      embeddedPreviewUrlRef,
      exportAbortControllerRef,
      exportGraphVersionRef,
      isMountedRef,
      paramsRef,
      pendingLoadSessionIdRef,
      pipelineRef,
      previewCopyCanvasRef,
      rawRenderExposureRef,
      rawRuntimeHost,
      resourceRegistryRef,
      runtimeWorkSessionIdRef,
      sessionRef,
      viewRef,
    ],
  )
}
