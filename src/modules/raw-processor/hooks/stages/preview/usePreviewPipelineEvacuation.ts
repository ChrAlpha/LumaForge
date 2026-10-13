import type { MutableRefObject } from 'react'
import { useCallback, useRef } from 'react'

import type {
  ResourceRegistry,
  TrackedLargeResource,
} from '~/lib/export/resource-registry'
import type { RawProcessingPipeline } from '~/lib/webgpu/raw-processing-pipeline'

import type { PreviewPipelineHandle } from '../../preview/usePreviewPipelineLifecycle'

/**
 * The processed pipeline its owner published. Disposing it releases it once
 * and tells that owner, which forgets and unpublishes it.
 */
type PublishedProcessedPipeline = Pick<RawProcessingPipeline, 'dispose'> &
  Partial<Pick<RawProcessingPipeline, 'getResourceStats'>>

type UsePreviewPipelineEvacuationInput = {
  resourceRegistryRef: MutableRefObject<ResourceRegistry | null>
  pipelineRef: MutableRefObject<PublishedProcessedPipeline | null>
}

type PipelineLabel = 'processed' | 'original'

/**
 * Lets export evacuation release the preview GPU pipelines through their
 * owners. A registration only names what an owner published and calls that
 * owner's own idempotent release: it never clears a published reference
 * itself, so a registration outliving its pipeline cannot touch a successor.
 */
export function usePreviewPipelineEvacuation({
  resourceRegistryRef,
  pipelineRef,
}: UsePreviewPipelineEvacuationInput) {
  const previewPipelineResourceIdRef = useRef(0)
  const originalPreviewPipelineRef = useRef<PreviewPipelineHandle | null>(null)
  // Keyed weakly, so remembering a registration never keeps a pipeline alive.
  const registrationsRef = useRef(new WeakMap<object, TrackedLargeResource>())

  const setOriginalPreviewPipeline = useCallback(
    (handle: PreviewPipelineHandle | null) => {
      originalPreviewPipelineRef.current = handle
    },
    [],
  )

  const registerCurrentPreviewPipelineForEvacuation = useCallback(() => {
    const registry = resourceRegistryRef.current
    if (!registry) {
      return
    }

    const registerPipeline = (
      label: PipelineLabel,
      resource: object,
      estimatedBytes: number | undefined,
      dispose: () => void,
    ) => {
      // A published pipeline is registered once until its registration is
      // disposed, however often an export asks.
      const registered = registrationsRef.current.get(resource)
      if (registered && !registered.disposed) {
        return
      }

      registrationsRef.current.set(
        resource,
        registry.register({
          id: `gpu-pipeline-${++previewPipelineResourceIdRef.current}-${label}`,
          owner: 'gpu',
          kind: 'gpu-pipeline',
          estimatedBytes,
          dispose,
        }),
      )
    }

    const processed = pipelineRef.current
    if (processed && typeof processed.dispose === 'function') {
      registerPipeline(
        'processed',
        processed,
        processed.getResourceStats?.().estimatedBytes,
        () => processed.dispose(),
      )
    }

    const original = originalPreviewPipelineRef.current
    const originalSnapshot = original?.snapshot()
    if (original && originalSnapshot?.live) {
      registerPipeline(
        'original',
        original,
        originalSnapshot.estimatedBytes,
        original.dispose,
      )
    }
  }, [pipelineRef, resourceRegistryRef])

  return {
    registerCurrentPreviewPipelineForEvacuation,
    setOriginalPreviewPipeline,
  }
}
