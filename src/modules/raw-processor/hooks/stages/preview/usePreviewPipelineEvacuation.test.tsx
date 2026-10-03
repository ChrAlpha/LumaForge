import { renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { createResourceRegistry } from '~/lib/export/resource-registry'

import type { PreviewPipelineEvacuationHandle } from './usePreviewPipelineEvacuation'
import { usePreviewPipelineEvacuation } from './usePreviewPipelineEvacuation'

function createPipeline(): PreviewPipelineEvacuationHandle {
  return {
    dispose: vi.fn(),
  }
}

describe('usePreviewPipelineEvacuation', () => {
  it('accounts for both GPU backends and clears their bytes on evacuation', async () => {
    const registry = createResourceRegistry()
    const processed = {
      dispose: vi.fn(),
      getResourceStats: () => ({ estimatedBytes: 4096 }),
    }
    const original = {
      dispose: vi.fn(),
      getResourceStats: () => ({ estimatedBytes: 8192 }),
    }
    const { result } = renderHook(() =>
      usePreviewPipelineEvacuation({
        resourceRegistryRef: { current: registry },
        pipelineRef: { current: processed },
      }),
    )
    result.current.setOriginalPreviewPipeline(original)
    result.current.registerCurrentPreviewPipelineForEvacuation()
    expect(registry.snapshot().totalEstimatedBytes).toBe(12288)
    await registry.disposeOwners(['gpu'])
    expect(registry.snapshot().totalEstimatedBytes).toBe(0)
    expect(processed.dispose).toHaveBeenCalledOnce()
    expect(original.dispose).toHaveBeenCalledOnce()
  })
  it('registers active processed and original preview pipelines for GPU evacuation', async () => {
    const registry = createResourceRegistry()
    const processed = createPipeline()
    const original = createPipeline()
    const pipelineRef = { current: processed }

    const { result } = renderHook(() =>
      usePreviewPipelineEvacuation({
        resourceRegistryRef: { current: registry },
        pipelineRef,
      }),
    )

    result.current.setOriginalPreviewPipeline(original)
    result.current.registerCurrentPreviewPipelineForEvacuation()

    expect(registry.snapshot().live).toEqual([
      {
        id: 'gpu-pipeline-1-processed',
        owner: 'gpu',
        kind: 'gpu-pipeline',
      },
      {
        id: 'gpu-pipeline-2-original',
        owner: 'gpu',
        kind: 'gpu-pipeline',
      },
    ])

    await registry.disposeOwners(['gpu'])

    expect(processed.dispose).toHaveBeenCalledWith({ releaseContext: true })
    expect(original.dispose).toHaveBeenCalledWith({ releaseContext: true })
    expect(pipelineRef.current).toBeNull()

    result.current.registerCurrentPreviewPipelineForEvacuation()
    expect(registry.snapshot().live).toEqual([])
  })

  it('does not clear refs that have moved to newer pipelines before disposal', async () => {
    const registry = createResourceRegistry()
    const processed = createPipeline()
    const nextProcessed = createPipeline()
    const pipelineRef = { current: processed }

    const { result } = renderHook(() =>
      usePreviewPipelineEvacuation({
        resourceRegistryRef: { current: registry },
        pipelineRef,
      }),
    )

    result.current.registerCurrentPreviewPipelineForEvacuation()
    pipelineRef.current = nextProcessed

    await registry.disposeOwners(['gpu'])

    expect(processed.dispose).toHaveBeenCalledWith({ releaseContext: true })
    expect(pipelineRef.current).toBe(nextProcessed)
  })
})
