import type { ColorGraphIntent, LUTData } from '@lumaforge/luma-color-runtime'
import {
  NEUTRAL_SELECTIVE_COLOR,
  NEUTRAL_USER_COLOR_INTENT,
  parseCubeLUT,
  toLUTData,
} from '@lumaforge/luma-color-runtime'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { DecodedPreviewFrame } from '~/lib/preview/preview-frame'
import { RawProcessingPipeline } from '~/lib/webgpu/raw-processing-pipeline'

import type { OriginalReferenceSnapshot } from '../services/compare/original-reference-snapshot'
import {
  createTestCube,
  createTestDecodedImage,
} from '../test-support/builders'
import { PreviewCanvas } from './PreviewCanvas'

const gpu = vi.hoisted(() => {
  const initialize = vi.fn()
  const waitForGpu = vi.fn()
  const createPipeline = (canvas: HTMLCanvasElement) => ({
    canvas,
    initialize: vi.fn(() => initialize(canvas)),
    waitForGpu: vi.fn(() => waitForGpu(canvas)),
    dispose: vi.fn(),
    resize: vi.fn(),
    render: vi.fn(() => ({ renderMs: 1 })),
    clearImage: vi.fn(),
    uploadImage: vi.fn(),
    clearLUT: vi.fn(),
    uploadLUT: vi.fn(),
    setParams: vi.fn(),
  })
  const instances: Array<ReturnType<typeof createPipeline>> = []
  // A function declaration, so the mocked class can be constructed with it.
  function create(canvas: HTMLCanvasElement) {
    const pipeline = createPipeline(canvas)
    instances.push(pipeline)
    return pipeline
  }
  return { instances, initialize, waitForGpu, create }
})

vi.mock('~/lib/webgpu/raw-processing-pipeline', () => ({
  RawProcessingPipeline: vi.fn(gpu.create),
}))

type CanvasProps = ComponentProps<typeof PreviewCanvas>

const defaultColor: ColorGraphIntent = {
  ...NEUTRAL_USER_COLOR_INTENT,
  intensity: 0.7,
  styleKind: 'none',
  builtinPreset: null,
}

const decodedImage = createTestDecodedImage()

const acceptedFrame: DecodedPreviewFrame = {
  sessionId: 'session-1',
  frameId: 'decoded-frame-1',
  stage: 'quick',
  width: decodedImage.width,
  height: decodedImage.height,
  exposure: { kind: 'unpinned', value: decodedImage.renderExposure },
  quickPredecessorFrameId: null,
}

const snapshot: OriginalReferenceSnapshot = {
  key: 'original-reference|session:test',
  objectUrl: 'blob:original-reference',
  width: 400,
  height: 300,
  source: 'quick',
  mimeType: 'image/jpeg',
  estimatedBytes: 1024,
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((onResolve) => {
    resolve = onResolve
  })
  return { promise, resolve }
}

function createTestLut(): LUTData {
  return {
    ...toLUTData(parseCubeLUT(createTestCube('test', 2))),
    profileResolution: { kind: 'unknown' },
  }
}

const isOriginalCanvas = (canvas: HTMLCanvasElement) =>
  canvas.className.includes('raw-preview-original-gpu-canvas')

function processedPipeline() {
  const pipeline = gpu.instances.find(({ canvas }) => !isOriginalCanvas(canvas))
  if (!pipeline) throw new Error('no processed pipeline')
  return pipeline
}

/** Renders the canvas; `update` rerenders with the props merged in. */
function renderCanvas(overrides: Partial<CanvasProps> = {}) {
  let props: CanvasProps = {
    imageRef: { current: decodedImage },
    decodedFrame: acceptedFrame,
    color: defaultColor,
    viewMode: 'processed',
    lutData: null,
    onStatsUpdate: vi.fn(),
    onPipelineChange: vi.fn(),
    ...overrides,
  }
  const view = render(createElement(PreviewCanvas, props))
  return {
    ...view,
    onStatsUpdate: vi.mocked(props.onStatsUpdate!),
    onPipelineChange: vi.mocked(props.onPipelineChange!),
    update: (next: Partial<CanvasProps>) => {
      props = { ...props, ...next }
      view.rerender(createElement(PreviewCanvas, props))
    },
    stage: () => view.container.querySelector('[data-compare-mode]'),
    track: () =>
      view.container.querySelector<HTMLElement>(
        '[data-raw-compare-track="image"]',
      )!,
  }
}

let resizeCallbacks: ResizeObserverCallback[] = []

function fireResize(width: number, height: number) {
  const contentRect = { width, height } as DOMRectReadOnly
  act(() =>
    resizeCallbacks.at(-1)?.(
      [{ contentRect } as ResizeObserverEntry],
      {} as ResizeObserver,
    ),
  )
}

/** jsdom's MouseEvent stand-in for PointerEvent, carrying the pointer id. */
class TestPointerEvent extends MouseEvent {
  readonly pointerId: number

  constructor(type: string, init: PointerEventInit = {}) {
    super(type, init)
    this.pointerId = init.pointerId ?? 0
  }
}

describe('previewCanvas', () => {
  beforeEach(() => {
    gpu.instances.length = 0
    vi.mocked(RawProcessingPipeline).mockClear()
    gpu.initialize.mockReset().mockResolvedValue(undefined)
    gpu.waitForGpu.mockReset().mockResolvedValue(undefined)
    resizeCallbacks = []
    vi.stubGlobal(
      'ResizeObserver',
      vi.fn().mockImplementation((callback: ResizeObserverCallback) => ({
        observe: () => resizeCallbacks.push(callback),
        disconnect: vi.fn(),
      })),
    )
    vi.stubGlobal('CSS', { supports: vi.fn(() => true) })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('draws the color it is given and never redraws for a zoom or pan', async () => {
    const color: ColorGraphIntent = {
      ...defaultColor,
      selectiveColor: {
        ...NEUTRAL_SELECTIVE_COLOR,
        red: { hue: 50, saturation: 0, lightness: 0 },
      },
    }
    const view = renderCanvas({ color })
    await waitFor(() => expect(view.onStatsUpdate).toHaveBeenCalledOnce())
    const pipeline = processedPipeline()
    expect(pipeline.setParams).toHaveBeenLastCalledWith({
      ...color,
      output: 'processed',
    })

    pipeline.render.mockClear()
    view.update({
      previewViewport: { zoom: 2, panX: 80, panY: 0, fitMode: 'custom' },
    })
    expect(pipeline.render).not.toHaveBeenCalled()
  })

  it('keeps a LUT upload failure inside the component until a replacement LUT uploads', async () => {
    const initialized = deferred()
    gpu.initialize.mockReturnValueOnce(initialized.promise)
    const failedLut = createTestLut()
    const view = renderCanvas({
      color: { ...defaultColor, styleKind: 'custom' },
      lutData: failedLut,
    })
    const pipeline = processedPipeline()
    pipeline.uploadLUT.mockImplementationOnce(() => {
      throw new Error('Failed to create LUT texture')
    })
    await act(async () => initialized.resolve())

    // The surface and its pipeline stay, but no LUT-less frame or stats
    // stand in for the look.
    expect(pipeline.uploadLUT).toHaveBeenCalledExactlyOnceWith(failedLut)
    expect(view.onPipelineChange).toHaveBeenLastCalledWith(pipeline)
    expect(view.container.querySelector('canvas.raw-preview-canvas')).not.toBe(
      null,
    )
    expect(screen.queryByText('Preview unavailable')).toBeNull()
    expect(pipeline.render).not.toHaveBeenCalled()
    expect(view.onStatsUpdate).not.toHaveBeenCalled()

    const replacementLut = createTestLut()
    await act(async () => view.update({ lutData: replacementLut }))
    await waitFor(() => expect(view.onStatsUpdate).toHaveBeenCalledOnce())
    // The new LUT is on the GPU before the frame drawn through it.
    expect(pipeline.uploadLUT).toHaveBeenLastCalledWith(replacementLut)
    expect(pipeline.uploadLUT.mock.invocationCallOrder.at(-1)).toBeLessThan(
      pipeline.render.mock.invocationCallOrder[0]!,
    )
    expect(pipeline.dispose).not.toHaveBeenCalled()
  })

  it('covers the stage with an initialization failure instead of the empty state', async () => {
    gpu.initialize.mockRejectedValue(new Error('Context restore failed'))
    renderCanvas({ imageRef: { current: null }, decodedFrame: null })

    expect(
      await screen.findByRole('heading', { name: 'Preview unavailable' }),
    ).toBeTruthy()
    expect(screen.getByText('Context restore failed')).toBeTruthy()
    expect(screen.queryByText('No image loaded')).toBeNull()
  })

  it('releases the processed pipeline while suspended and builds a new one on resume', async () => {
    const view = renderCanvas()
    await waitFor(() =>
      expect(view.onPipelineChange).toHaveBeenLastCalledWith(gpu.instances[0]),
    )

    view.update({ suspended: true })
    expect(gpu.instances[0]!.dispose).toHaveBeenCalledOnce()
    expect(view.onPipelineChange).toHaveBeenLastCalledWith(null)

    view.update({ suspended: false })
    await waitFor(() =>
      expect(view.onPipelineChange).toHaveBeenLastCalledWith(gpu.instances[1]),
    )
  })

  it.each<{
    name: string
    mode: string
    reason?: string
    props: Partial<CanvasProps>
    arrange?: () => void
    originalGpuLayer: boolean
    originalSrc: string | null
  }>([
    {
      name: 'layers the live original GPU layer under dual-gpu compare',
      mode: 'dual-gpu',
      props: { dualGpuAllowed: true, originalReferenceSnapshot: snapshot },
      originalGpuLayer: true,
      originalSrc: null,
    },
    {
      name: 'shows the embedded JPEG while the original GPU layer warms',
      mode: 'embedded-fallback',
      props: {
        dualGpuAllowed: true,
        embeddedPreviewUrl: 'blob:embedded-preview',
        displaySource: 'quick',
      },
      arrange: () =>
        gpu.initialize.mockImplementation((canvas: HTMLCanvasElement) =>
          isOriginalCanvas(canvas) ? new Promise(() => {}) : Promise.resolve(),
        ),
      originalGpuLayer: true,
      originalSrc: 'blob:embedded-preview',
    },
    {
      name: 'layers the JPEG snapshot when dual-gpu is not allowed',
      mode: 'jpeg-fallback',
      props: { dualGpuAllowed: false, originalReferenceSnapshot: snapshot },
      originalGpuLayer: false,
      originalSrc: 'blob:original-reference',
    },
    {
      name: 'shows the processed photo alone without a JPEG snapshot',
      mode: 'processed-only',
      reason: 'jpeg-fallback-unavailable',
      props: { dualGpuAllowed: false },
      originalGpuLayer: false,
      originalSrc: null,
    },
    {
      name: 'shows the processed photo alone without CSS clipping',
      mode: 'processed-only',
      reason: 'css-clip-unavailable',
      props: { dualGpuAllowed: true },
      arrange: () => vi.stubGlobal('CSS', { supports: vi.fn(() => false) }),
      originalGpuLayer: false,
      originalSrc: null,
    },
  ])('$name', async (row) => {
    row.arrange?.()
    const view = renderCanvas({ viewMode: 'compare', ...row.props })

    await waitFor(() =>
      expect(view.stage()).toHaveAttribute('data-compare-mode', row.mode),
    )
    if (row.reason) {
      expect(view.stage()).toHaveAttribute(
        'data-compare-fallback-reason',
        row.reason,
      )
    }
    expect(
      view.container.querySelector('.raw-preview-original-gpu-layer') !== null,
    ).toBe(row.originalGpuLayer)
    expect(
      view.container
        .querySelector('.raw-preview-original-layer img')
        ?.getAttribute('src') ?? null,
    ).toBe(row.originalSrc)
    // Only a layered compare clips the processed photo at the split.
    expect(view.stage()!.classList.contains('raw-preview-layer-clipped')).toBe(
      row.mode !== 'processed-only',
    )
  })

  it('isolates an original layer failure from the processed surface', async () => {
    gpu.initialize.mockImplementation((canvas: HTMLCanvasElement) =>
      isOriginalCanvas(canvas)
        ? Promise.reject(new Error('Original layer failed'))
        : Promise.resolve(),
    )
    const onRequestOriginalReferenceFallback = vi.fn()
    const view = renderCanvas({
      viewMode: 'compare',
      dualGpuAllowed: true,
      onRequestOriginalReferenceFallback,
    })

    await waitFor(() =>
      expect(onRequestOriginalReferenceFallback).toHaveBeenCalledOnce(),
    )
    await waitFor(() =>
      expect(view.stage()).toHaveAttribute(
        'data-compare-fallback-reason',
        'jpeg-fallback-unavailable',
      ),
    )
    // Only the primary pipeline reports to the preview's failure channel, so
    // an original layer failure cannot move the preview to the CPU executor.
    const constructed = vi.mocked(RawProcessingPipeline).mock.calls
    expect(constructed).toContainEqual([
      expect.objectContaining({ className: 'raw-preview-original-gpu-canvas' }),
      { reportFailures: false },
    ])
    expect(constructed).toContainEqual([
      expect.objectContaining({ className: 'raw-preview-canvas' }),
    ])
    expect(
      view.container.querySelector('.raw-preview-original-gpu-layer'),
    ).toBeNull()
    const processed = processedPipeline()
    expect(processed.render).toHaveBeenCalledOnce()
    expect(processed.dispose).not.toHaveBeenCalled()
    expect(view.onStatsUpdate).toHaveBeenCalledOnce()
    expect(view.onPipelineChange).not.toHaveBeenCalledWith(null)
    expect(screen.queryByText('Preview unavailable')).toBeNull()
  })

  it('pans a zoomed preview with a pointer drag on the frame', async () => {
    window.PointerEvent = TestPointerEvent as unknown as typeof PointerEvent
    const onPreviewViewportChange = vi.fn()
    const view = renderCanvas({
      previewViewport: { zoom: 2, panX: 0, panY: 0, fitMode: 'custom' },
      onPreviewViewportChange,
    })
    const frame = view.container.querySelector<HTMLElement>(
      '[data-raw-preview-frame]',
    )!
    for (const element of [frame, view.track()]) {
      vi.spyOn(element, 'getBoundingClientRect').mockReturnValue(
        new DOMRect(0, 0, 400, 300),
      )
    }
    await waitFor(() => expect(view.onStatsUpdate).toHaveBeenCalledOnce())
    const frames: FrameRequestCallback[] = []
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) =>
      frames.push(callback),
    )

    fireEvent.pointerDown(frame, {
      pointerId: 1,
      button: 0,
      clientX: 200,
      clientY: 150,
    })
    fireEvent.pointerMove(frame, { pointerId: 1, clientX: 240, clientY: 170 })
    frames[0]?.(performance.now())

    expect(onPreviewViewportChange).toHaveBeenLastCalledWith({
      zoom: 2,
      panX: 40,
      panY: 20,
      fitMode: 'custom',
    })
  })

  it('fits the track at once and settles rapid resizes into one resize and draw', async () => {
    const view = renderCanvas()
    await waitFor(() => expect(view.onStatsUpdate).toHaveBeenCalledOnce())
    const track = view.track()
    const canvas = track.querySelector('canvas')!
    const pipeline = processedPipeline()
    pipeline.render.mockClear()

    vi.useFakeTimers()
    try {
      fireResize(400, 300)
      expect(track).toHaveAttribute('data-preview-track-ready', 'true')
      expect(pipeline.resize).toHaveBeenCalledExactlyOnceWith(400, 300)
      expect(pipeline.render).toHaveBeenCalledOnce()

      fireResize(800, 300)
      act(() => vi.advanceTimersByTime(50))
      fireResize(600, 600)
      act(() => vi.advanceTimersByTime(50))
      fireResize(1000, 450)
      // CSS follows every size at once; the backing store waits for the last.
      expect([track.style.width, track.style.height]).toEqual([
        '600px',
        '450px',
      ])
      expect([canvas.width, canvas.height]).toEqual([400, 300])

      act(() => vi.runAllTimers())
      expect([canvas.width, canvas.height]).toEqual([600, 450])
      expect(pipeline.resize).toHaveBeenCalledTimes(2)
      expect(pipeline.resize).toHaveBeenLastCalledWith(600, 450)
      expect(pipeline.render).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })
})
