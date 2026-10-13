import { NEUTRAL_USER_COLOR_INTENT } from '@lumaforge/luma-color-runtime'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { DecodedPreviewFrame } from '~/lib/preview/preview-frame'

import type { UseRawWorkflowReturn } from '../hooks/useRawWorkflow'
import { RawPreviewStageSurface } from './RawPreviewStageSurface'

const stageProps = vi.hoisted(() => ({
  cpu: [] as Array<Record<string, unknown>>,
  gpu: [] as Array<Record<string, unknown>>,
  splitHandle: [] as Array<Record<string, unknown>>,
}))

vi.mock('./RawCpuPreviewStage', () => ({
  RawCpuPreviewStage: (props: Record<string, unknown>) => {
    stageProps.cpu.push(props)
    return <div data-testid="cpu-stage" />
  },
}))
vi.mock('./PreviewCanvas', () => ({
  PreviewCanvas: (props: Record<string, unknown>) => {
    stageProps.gpu.push(props)
    return <div data-testid="gpu-preview-canvas" />
  },
}))
vi.mock('./CompareSplitHandle', () => ({
  CompareSplitHandle: (props: Record<string, unknown>) => {
    stageProps.splitHandle.push(props)
    return <div data-testid="split-handle" />
  },
}))

// Legacy params still carry view fields; the stages must not receive them.
const mixedParams = {
  styleKind: 'custom',
  builtinPreset: null,
  intensity: 0.37,
  ...NEUTRAL_USER_COLOR_INTENT,
  userExposureEv: 0.5,
  viewMode: 'compare',
  compareSplit: 0.8,
}
const {
  viewMode: _viewMode,
  compareSplit: _split,
  ...expectedColor
} = mixedParams

const acceptedFrame: DecodedPreviewFrame = {
  sessionId: 'session-1',
  frameId: 'decoded-frame-2',
  stage: 'bounded-hq',
  width: 400,
  height: 300,
  exposure: {
    kind: 'source-pin',
    value: { ev: 0, multiplier: 1, source: 'identity' },
  },
  quickPredecessorFrameId: 'decoded-frame-1',
}

function workflow(overrides: Partial<UseRawWorkflowReturn>) {
  return {
    hasImage: true,
    previewSuspended: false,
    status: 'ready',
    decodedImageRef: { current: null },
    decodedFrame: null,
    params: {},
    lutData: null,
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
    setPreviewViewport: vi.fn(),
    setOriginalPreviewPipeline: vi.fn(),
    requestOriginalReferenceFallback: vi.fn(),
    transform: { state: null, dispatch: vi.fn() },
    ...overrides,
  } as unknown as UseRawWorkflowReturn
}

function renderSurface(
  current: UseRawWorkflowReturn,
  {
    isCpuMode = true,
    isProcessing = false,
    cpuVariant,
    onCompareReset,
  }: {
    isCpuMode?: boolean
    isProcessing?: boolean
    cpuVariant?: 'processed' | 'neutral'
    onCompareReset?: () => void
  } = {},
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
      cpuVariant={cpuVariant}
      onCompareReset={onCompareReset}
    />,
  )
}

describe('rawPreviewStageSurface in CPU preview mode', () => {
  afterEach(() => {
    cleanup()
    stageProps.cpu.length = 0
    stageProps.gpu.length = 0
    stageProps.splitHandle.length = 0
  })

  it('hands the CPU stage the color intent and leaves its own toggle by default', () => {
    renderSurface(workflow({ params: mixedParams as never }))

    const props = stageProps.cpu.at(-1)!
    expect(props.color).toEqual(expectedColor)
    expect(props).not.toHaveProperty('params')
    expect(props.variant).toBeUndefined()
  })

  it('passes a controlled CPU variant through unchanged', () => {
    renderSurface(workflow({ params: mixedParams as never }), {
      cpuVariant: 'neutral',
    })
    expect(stageProps.cpu.at(-1)!.variant).toBe('neutral')
  })

  it('hands the CPU stage the accepted frame descriptor the workflow published', () => {
    renderSurface(workflow({ decodedFrame: acceptedFrame }))

    const props = stageProps.cpu.at(-1)!
    expect(props.decodedFrame).toBe(acceptedFrame)
  })

  it('hands the CPU stage no descriptor while no accepted frame is live', () => {
    renderSurface(workflow({ decodedFrame: null }))
    expect(stageProps.cpu.at(-1)!.decodedFrame).toBeNull()
  })

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

describe('rawPreviewStageSurface in GPU preview mode', () => {
  afterEach(() => {
    cleanup()
    stageProps.gpu.length = 0
    stageProps.splitHandle.length = 0
  })

  it('hands the GPU stage the color intent apart from the explicit view', () => {
    renderSurface(
      workflow({ params: mixedParams as never, viewMode: 'original' }),
      { isCpuMode: false },
    )

    const props = stageProps.gpu.at(-1)!
    expect(props.color).toEqual(expectedColor)
    expect(props.viewMode).toBe('original')
    expect(props).not.toHaveProperty('params')
    // Only compare shows the split handle.
    expect(screen.queryByTestId('split-handle')).toBeNull()
  })

  it('writes only committed split changes to the view owner, never through the color setter', () => {
    const current = workflow({ viewMode: 'compare', compareSplit: 0.4 })
    renderSurface(current, { isCpuMode: false })

    expect(stageProps.gpu.at(-1)!.viewMode).toBe('compare')
    const handle = stageProps.splitHandle.at(-1)!
    expect(handle.value).toBe(0.4)
    // Dragging only paints the split; nothing persists until the gesture
    // commits.
    expect(handle.onPreviewChange).toBeUndefined()
    ;(handle.onChange as (split: number) => void)(0.64)

    expect(current.setCompareSplit).toHaveBeenCalledOnce()
    expect(current.setCompareSplit).toHaveBeenLastCalledWith(0.64)
  })

  it('hands the split handle the compare reset as its one reset transaction', () => {
    const current = workflow({ viewMode: 'compare', compareSplit: 0.4 })
    const onCompareReset = vi.fn()
    renderSurface(current, { isCpuMode: false, onCompareReset })

    const handle = stageProps.splitHandle.at(-1)!
    ;(handle.onReset as () => void)()

    expect(onCompareReset).toHaveBeenCalledOnce()
    expect(current.setCompareSplit).not.toHaveBeenCalled()
  })

  it('hands the GPU canvas the accepted frame descriptor the workflow published', () => {
    renderSurface(workflow({ decodedFrame: acceptedFrame }), {
      isCpuMode: false,
    })

    expect(stageProps.gpu.at(-1)!.decodedFrame).toBe(acceptedFrame)
  })

  it('hands the GPU canvas no descriptor while only the embedded preview shows', () => {
    renderSurface(workflow({ displaySource: 'embedded', decodedFrame: null }), {
      isCpuMode: false,
    })

    const props = stageProps.gpu.at(-1)!
    expect(props.displaySource).toBe('embedded')
    expect(props.decodedFrame).toBeNull()
  })

  it('mounts no GPU canvas once export released the preview', () => {
    const { container } = renderSurface(
      workflow({ previewSuspended: true, decodedFrame: null }),
      { isCpuMode: false },
    )

    expect(stageProps.gpu).toHaveLength(0)
    expect(
      container.querySelector('[data-raw-export-ready-handoff]'),
    ).not.toBeNull()
  })
})
