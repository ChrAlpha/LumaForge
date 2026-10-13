import type { RawRenderExposure } from '@lumaforge/luma-color-runtime'
import type { MutableRefObject } from 'react'
import { useState } from 'react'

import type { ResourceRegistry } from '~/lib/export/resource-registry'
import { createResourceRegistry } from '~/lib/export/resource-registry'
import type { DecodedImage } from '~/lib/raw/decoder'
import { createRawRuntimeHost } from '~/lib/raw/raw-runtime-host'
import type { RawProcessingPipeline } from '~/lib/webgpu/raw-processing-pipeline'

function ref<T>(current: T): MutableRefObject<T> {
  return { current }
}

function createRawWorkflowRuntime() {
  return {
    // The one RAW host of this workflow: readiness, load, restore, and the
    // bridge release before export all drive this instance. It owns every RAW
    // session and its cancellation; the workflow keeps only source epochs.
    rawRuntimeHost: createRawRuntimeHost(),
    resourceRegistryRef: ref<ResourceRegistry | null>(createResourceRegistry()),
    pipelineRef: ref<RawProcessingPipeline | null>(null),
    previewCopyCanvasRef: ref<HTMLCanvasElement | null>(null),
    embeddedPreviewUrlRef: ref<string | null>(null),
    isMountedRef: ref(false),
    runtimeWorkSessionIdRef: ref<string | null>(null),
    pendingLoadSessionIdRef: ref<string | null>(null),
    exportAbortControllerRef: ref<AbortController | null>(null),
    exportGraphVersionRef: ref(0),
    decodedImageRef: ref<DecodedImage | null>(null),
    rawRenderExposureRef: ref<RawRenderExposure | null>(null),
  }
}

export type RawWorkflowRuntime = ReturnType<typeof createRawWorkflowRuntime>

/** The workflow's RAW host and the refs its stages share, made once per mount. */
export function useRawWorkflowRefs(): RawWorkflowRuntime {
  const [runtime] = useState(createRawWorkflowRuntime)
  return runtime
}
