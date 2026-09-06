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
  it('blocks full and HQ export, normal compare and stale histogram while Transform is active', () => {
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
    expect(result.current.canExport).toBe(false)
    expect(result.current.canPreviewExport).toBe(false)
    expect(result.current.disabledReason).toBe(
      'Transform changes support preview JPEG only. Reset Transform before exporting a standard JPEG.',
    )
    expect(result.current.previewExportDisabledReason).toBe(
      result.current.disabledReason,
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
    expect(onExport).not.toHaveBeenCalled()
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
    expect(onExport).toHaveBeenCalledOnce()
    expect(workflow.exportPreviewImage).toHaveBeenCalledOnce()
    expect(onCompareReset).toHaveBeenCalledOnce()
    expect(workflow.setViewMode).toHaveBeenCalledWith('original')
    expect(workflow.setCompareSplit).toHaveBeenCalledWith(0.2)
  })
})
