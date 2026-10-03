import type { MutableRefObject } from 'react'
import { useCallback, useRef } from 'react'

import type { ResourceRegistry } from '~/lib/export/resource-registry'
import type { RawProcessingPipeline } from '~/lib/webgpu/raw-processing-pipeline'

export type PreviewPipelineEvacuationHandle = Pick<
  RawProcessingPipeline,
  'dispose'
> &
  Partial<Pick<RawProcessingPipeline, 'getResourceStats'>>

type UsePreviewPipelineEvacuationInput = {
  resourceRegistryRef: MutableRefObject<ResourceRegistry | null>
  pipelineRef: MutableRefObject<PreviewPipelineEvacuationHandle | null>
}

export function usePreviewPipelineEvacuation({
  resourceRegistryRef,
  pipelineRef,
}: UsePreviewPipelineEvacuationInput) {
  const previewPipelineResourceIdRef = useRef(0)
  const originalPreviewPipelineRef =
    useRef<PreviewPipelineEvacuationHandle | null>(null)

  const setOriginalPreviewPipeline = useCallback(
    (pipeline: PreviewPipelineEvacuationHandle | null) => {
      originalPreviewPipelineRef.current = pipeline
    },
    [],
  )

  const registerCurrentPreviewPipelineForEvacuation = useCallback(() => {
    const registry = resourceRegistryRef.current
    if (!registry) {
      return
    }

    const registerPipeline = (
      label: 'processed' | 'original',
      pipeline: PreviewPipelineEvacuationHandle | null,
      clearCurrent: () => void,
    ) => {
      if (!pipeline || typeof pipeline.dispose !== 'function') {
        return
      }

      const id = `gpu-pipeline-${++previewPipelineResourceIdRef.current}-${label}`
      registry.register({
        id,
        // Stable registry owner includes both GPU APIs during compatibility
        // rollout; disposal and byte estimates come from the actual backend.
        owner: 'gpu',
        kind: 'gpu-pipeline',
        estimatedBytes: pipeline.getResourceStats?.().estimatedBytes,
        dispose: () => {
          clearCurrent()
          return pipeline.dispose({ releaseContext: true })
        },
      })
    }

    const processedPipeline = pipelineRef.current
    registerPipeline('processed', processedPipeline, () => {
      if (pipelineRef.current === processedPipeline) {
        pipelineRef.current = null
      }
    })

    const originalPipeline = originalPreviewPipelineRef.current
    registerPipeline('original', originalPipeline, () => {
      if (originalPreviewPipelineRef.current === originalPipeline) {
        originalPreviewPipelineRef.current = null
      }
    })
  }, [originalPreviewPipelineRef, pipelineRef, resourceRegistryRef])

  return {
    registerCurrentPreviewPipelineForEvacuation,
    setOriginalPreviewPipeline,
  }
}
