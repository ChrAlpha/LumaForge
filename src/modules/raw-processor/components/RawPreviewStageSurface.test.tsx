import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { UseRawWorkflowReturn } from '../hooks/useRawWorkflow'
import { RawPreviewStageSurface } from './RawPreviewStageSurface'

vi.mock('./RawCpuPreviewStage', () => ({
  RawCpuPreviewStage: () => <div data-testid="cpu-stage" />,
}))
vi.mock('./PreviewCanvas', () => ({
  PreviewCanvas: () => <div data-testid="gpu-preview-canvas" />,
}))

function workflow(overrides: Partial<UseRawWorkflowReturn>) {
  return {
    hasImage: true,
    previewSuspended: false,
    status: 'ready',
    decodedImageRef: { current: null },
    decodedImageVersion: 1,
    params: {},
    lutDataRef: { current: null },
    lutDataVersion: 0,
    embeddedPreviewUrl: null,
    displaySource: 'bounded-hq',
    originalReferenceSnapshot: null,
    originalReferenceFallbackReason: null,
    dualGpuAllowed: false,
    previewViewport: { zoom: 1, panX: 0, panY: 0 },
    compareSplit: 0.5,
    viewMode: 'processed',
    progress: 0,
    progressRecoveryHint: null,
    restorePreviewAfterExport: vi.fn(),
    setCompareSplit: vi.fn(),
    setParams: vi.fn(),
    setPreviewViewport: vi.fn(),
    setOriginalPreviewPipeline: vi.fn(),
    requestOriginalReferenceFallback: vi.fn(),
    ...overrides,
  } as unknown as UseRawWorkflowReturn
}

function renderSurface(
  current: UseRawWorkflowReturn,
  { isCpuMode = true, isProcessing = false } = {},
) {
  return render(
    <RawPreviewStageSurface
      workflow={current}
      isCpuMode={isCpuMode}
      isProcessing={isProcessing}
      runtimeReadinessState={{ status: 'ready' } as never}
      onPrepareRuntime={vi.fn()}
      onRawDrop={vi.fn()}
      onStatsUpdate={vi.fn()}
      onPipelineChange={vi.fn()}
      onPreviewFrameChange={vi.fn()}
    />,
  )
}

describe('rawPreviewStageSurface in CPU preview mode', () => {
  afterEach(cleanup)

  it('renders the CPU stage while the preview is live', () => {
    renderSurface(workflow({}))
    expect(screen.getByTestId('cpu-stage')).toBeInTheDocument()
  })

  it('offers the export-ready handoff with restore once export released the preview', () => {
    const current = workflow({ previewSuspended: true })
    const { container } = renderSurface(current)

    expect(screen.queryByTestId('cpu-stage')).toBeNull()
    expect(screen.queryByTestId('gpu-preview-canvas')).toBeNull()
    expect(
      container.querySelector('[data-raw-export-ready-handoff]'),
    ).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /restore preview/i }))
    expect(current.restorePreviewAfterExport).toHaveBeenCalledOnce()
  })

  it('keeps the released stage behind the processing handoff while export or restore runs', () => {
    const { container } = renderSurface(workflow({ previewSuspended: true }), {
      isProcessing: true,
    })

    expect(screen.queryByTestId('cpu-stage')).toBeNull()
    expect(
      container.querySelector('[data-raw-export-processing-handoff]'),
    ).not.toBeNull()
  })
})
