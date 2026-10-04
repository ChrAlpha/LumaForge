import { renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { UseOnlineLutSourcesResult } from '../hooks/useOnlineLutSources'
import type { UseRawWorkflowReturn } from '../hooks/useRawWorkflow.types'
import { COLOR_NEUTRAL } from './color-fields'
import { useRawWorkflowContext } from './RawWorkflowContext'
import { RawWorkflowToolProvider } from './RawWorkflowToolProvider'
import { TONE_NEUTRAL } from './tone-fields'
import { transformFeatureFixture } from './tools/transform-feature.fixture'

function workflowFixture() {
  return {
    params: { ...TONE_NEUTRAL, ...COLOR_NEUTRAL },
    hasImage: true,
    sourceFileName: 'current.nef',
    status: 'ready',
    decodedImageRef: { current: null },
    loadedImage: { file: null, metadata: null },
    stats: null,
    viewMode: 'compare',
    compareSplit: 0.7,
    setViewMode: vi.fn(),
    setCompareSplit: vi.fn(),
    canExport: true,
    canPreviewExport: true,
    exportPreviewImage: vi.fn(),
    histogram: { state: 'unavailable', reason: 'no-image' },
  } as unknown as UseRawWorkflowReturn
}

describe('rawWorkflowToolProvider Transform guards', () => {
  it('keeps full-resolution export while blocking HQ preview, compare and the stale histogram under Transform', () => {
    const workflow = workflowFixture()
    const onExport = vi.fn()
    const onCompareReset = vi.fn()
    const frame = document.createElement('div')
    let transform = transformFeatureFixture({ active: true, hasImage: true })
    const { result, rerender } = renderHook(useRawWorkflowContext, {
      wrapper: ({ children }) => (
        <RawWorkflowToolProvider
          workflow={workflow}
          transform={transform}
          onlineLutSources={{} as UseOnlineLutSourcesResult}
          isCpuMode={false}
          isProcessing={false}
          runtimeReadinessState="ready"
          previewFrameEl={frame}
          onReplaceFile={vi.fn()}
          onResetSession={vi.fn()}
          onCompareReset={onCompareReset}
          onLutDrop={vi.fn()}
          onExport={onExport}
          onRecoverExportSource={vi.fn()}
          onPrepareRuntime={vi.fn()}
        >
          {children}
        </RawWorkflowToolProvider>
      ),
    })
    expect(result.current.transform).toBe(transform)
    // Full resolution reproduces the geometry, so the promise stays open.
    expect(result.current.canExport).toBe(true)
    expect(result.current.disabledReason).toBeUndefined()
    // The bounded HQ preview cannot, and names the alternative.
    expect(result.current.canPreviewExport).toBe(false)
    expect(result.current.previewExportDisabledReason).toBe(
      'Export at full resolution to keep Transform, or reset Transform for an HQ preview JPEG.',
    )
    expect(result.current.histogram).toEqual({
      state: 'unsupported',
      reason: 'Histogram is unavailable for the transformed preview.',
    })
    expect(result.current.previewFrameEl).toBeNull()
    expect(result.current.viewMode).toBe('processed')
    result.current.onExport({ quality: 'high', fidelity: 'safe' })
    void result.current.onPreviewExport?.()
    result.current.onCompareReset()
    result.current.onViewModeChange('original')
    result.current.onCompareSplitChange(0.2)
    expect(onExport).toHaveBeenCalledOnce()
    expect(workflow.exportPreviewImage).not.toHaveBeenCalled()
    expect(onCompareReset).not.toHaveBeenCalled()
    expect(workflow.setViewMode).not.toHaveBeenCalled()
    expect(workflow.setCompareSplit).not.toHaveBeenCalled()

    transform = { ...transform, active: false }
    rerender()
    expect(result.current.canExport).toBe(true)
    expect(result.current.canPreviewExport).toBe(true)
    expect(result.current.histogram).toBe(workflow.histogram)
    expect(result.current.previewFrameEl).toBe(frame)
    result.current.onExport({ quality: 'high', fidelity: 'safe' })
    void result.current.onPreviewExport?.()
    result.current.onCompareReset()
    result.current.onViewModeChange('original')
    result.current.onCompareSplitChange(0.2)
    expect(onExport).toHaveBeenCalledTimes(2)
    expect(workflow.exportPreviewImage).toHaveBeenCalledOnce()
    expect(onCompareReset).toHaveBeenCalledOnce()
    expect(workflow.setViewMode).toHaveBeenCalledWith('original')
    expect(workflow.setCompareSplit).toHaveBeenCalledWith(0.2)
  })
  it('reports compare support and export progress to the tool surfaces', () => {
    const workflow = {
      ...workflowFixture(),
      status: 'exporting',
      progress: 42,
    } as unknown as UseRawWorkflowReturn
    let isCpuMode = false
    const { result, rerender } = renderHook(useRawWorkflowContext, {
      wrapper: ({ children }) => (
        <RawWorkflowToolProvider
          workflow={workflow}
          onlineLutSources={{} as UseOnlineLutSourcesResult}
          isCpuMode={isCpuMode}
          isProcessing
          runtimeReadinessState="ready"
          previewFrameEl={null}
          onReplaceFile={vi.fn()}
          onResetSession={vi.fn()}
          onCompareReset={vi.fn()}
          onLutDrop={vi.fn()}
          onExport={vi.fn()}
          onRecoverExportSource={vi.fn()}
          onPrepareRuntime={vi.fn()}
        >
          {children}
        </RawWorkflowToolProvider>
      ),
    })
    expect(result.current.compareSupported).toBe(true)
    expect(result.current.isExporting).toBe(true)
    expect(result.current.progress).toBe(42)
    // The export recap's size is unknown until the workflow reports it.
    expect(result.current.deliveredExportSize).toBeNull()
    workflow.deliveredExportSize = { width: 9728, height: 6656 }
    rerender()
    expect(result.current.deliveredExportSize).toEqual({
      width: 9728,
      height: 6656,
    })

    // The CPU preview has no split surface to compare on.
    isCpuMode = true
    rerender()
    expect(result.current.compareSupported).toBe(false)
  })

  it('lets the CPU preview show the original but never the split', () => {
    const workflow = workflowFixture()
    const { result } = renderHook(useRawWorkflowContext, {
      wrapper: ({ children }) => (
        <RawWorkflowToolProvider
          workflow={workflow}
          transform={transformFeatureFixture({ hasImage: true })}
          onlineLutSources={{} as UseOnlineLutSourcesResult}
          isCpuMode
          isProcessing={false}
          runtimeReadinessState="ready"
          previewFrameEl={null}
          onReplaceFile={vi.fn()}
          onResetSession={vi.fn()}
          onCompareReset={vi.fn()}
          onLutDrop={vi.fn()}
          onExport={vi.fn()}
          onRecoverExportSource={vi.fn()}
          onPrepareRuntime={vi.fn()}
        >
          {children}
        </RawWorkflowToolProvider>
      ),
    })
    // A split left over from the GPU path reads as the processed photo.
    expect(result.current.viewMode).toBe('processed')
    result.current.onViewModeChange('original')
    expect(workflow.setViewMode).toHaveBeenLastCalledWith('original')
    result.current.onViewModeChange('compare')
    expect(workflow.setViewMode).toHaveBeenLastCalledWith('processed')
    result.current.onCompareSplitChange(0.2)
    expect(workflow.setCompareSplit).not.toHaveBeenCalled()
  })

  it('reports the aspect the stage is displaying', () => {
    const decoded = { width: 6000, height: 4000 }
    const workflow = {
      ...workflowFixture(),
      decodedImageRef: { current: decoded },
    } as unknown as UseRawWorkflowReturn
    let transform = transformFeatureFixture({ hasImage: true })
    const { result, rerender } = renderHook(useRawWorkflowContext, {
      wrapper: ({ children }) => (
        <RawWorkflowToolProvider
          workflow={workflow}
          transform={transform}
          onlineLutSources={{} as UseOnlineLutSourcesResult}
          isCpuMode={false}
          isProcessing={false}
          runtimeReadinessState="ready"
          previewFrameEl={null}
          onReplaceFile={vi.fn()}
          onResetSession={vi.fn()}
          onCompareReset={vi.fn()}
          onLutDrop={vi.fn()}
          onExport={vi.fn()}
          onRecoverExportSource={vi.fn()}
          onPrepareRuntime={vi.fn()}
        >
          {children}
        </RawWorkflowToolProvider>
      ),
    })
    // The decoded preview is what the canvas aspect-fits.
    expect(result.current.previewAspect).toBe(1.5)

    // The Transform overlay draws its own result frame over the stage.
    const base = transformFeatureFixture({ hasImage: true, showOverlay: true })
    transform = {
      ...base,
      demo: {
        ...base.demo,
        result: {
          frame: { width: 800, height: 1000 },
        } as NonNullable<typeof base.demo.result>,
      },
    }
    rerender()
    expect(result.current.previewAspect).toBe(0.8)

    // Export releases the decoded preview; the aspect is unknown until the
    // preview is restored.
    transform = transformFeatureFixture({ hasImage: true })
    workflow.decodedImageRef.current = null
    rerender()
    expect(result.current.previewAspect).toBeNull()
  })
})
