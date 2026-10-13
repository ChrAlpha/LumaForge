import type { LUTData, ProcessingParams } from '@lumaforge/luma-color-runtime'
import {
  NEUTRAL_SELECTIVE_COLOR,
  parseCubeLUT,
  pickColorGraphIntent,
  toLUTData,
} from '@lumaforge/luma-color-runtime'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ComponentProps, RefObject } from 'react'
import { createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { DecodedPreviewFrame } from '~/lib/preview/preview-frame'
import type { DecodedImage } from '~/lib/raw/decoder'
import { RawProcessingPipeline } from '~/lib/webgpu/raw-processing-pipeline'

import type { OriginalReferenceSnapshot } from '../services/compare/original-reference-snapshot'
import {
  createRawUploadInput,
  syncRawUploadInput,
} from '../services/preview/preview-canvas-helpers'
import { DEFAULT_PREVIEW_VIEWPORT } from '../services/preview/preview-viewport'
import { createTestDecodedImage } from '../test-support/builders'
import { PreviewCanvas } from './PreviewCanvas'

const pipelineMock = vi.hoisted(() => ({
  instances: [] as Array<{
    canvas: HTMLCanvasElement
    initialize: ReturnType<typeof vi.fn>
    dispose: ReturnType<typeof vi.fn>
    facadeDispose: ReturnType<typeof vi.fn>
    disposeMock: ReturnType<typeof vi.fn>
    onDisposed: ReturnType<typeof vi.fn>
    unsubscribeDisposed: ReturnType<typeof vi.fn>
    resize: ReturnType<typeof vi.fn>
    render: ReturnType<typeof vi.fn>
    waitForGpu: ReturnType<typeof vi.fn>
    clearImage: ReturnType<typeof vi.fn>
    uploadImage: ReturnType<typeof vi.fn>
    clearLUT: ReturnType<typeof vi.fn>
    uploadLUT: ReturnType<typeof vi.fn>
    setParams: ReturnType<typeof vi.fn>
  }>,
  initialize: vi.fn(),
  waitForGpu: vi.fn(),
  renderEvents: [] as Array<{ kind: 'original' | 'processed' }>,
  pipelineEvents: [] as Array<{
    kind: 'original' | 'processed'
    op: 'upload' | 'render'
    width?: number
    height?: number
  }>,
}))

vi.mock('~/lib/webgpu/raw-processing-pipeline', () => ({
  RawProcessingPipeline: vi
    .fn()
    .mockImplementation((canvas: HTMLCanvasElement) => {
      // `disposeMock` counts renderer releases; `dispose` is the facade call,
      // which releases once and notifies disposal subscribers once.
      const disposeMock = vi.fn()
      const disposeListeners = new Set<() => void>()
      let disposed = false
      const dispose = vi.fn(() => {
        if (disposed) return
        disposed = true
        disposeMock()
        const listeners = [...disposeListeners]
        disposeListeners.clear()
        for (const listener of listeners) listener()
      })
      const unsubscribeDisposed = vi.fn()
      const onDisposed = vi.fn((listener: () => void) => {
        if (disposed) {
          listener()
          return unsubscribeDisposed
        }
        disposeListeners.add(listener)
        return () => {
          unsubscribeDisposed()
          disposeListeners.delete(listener)
        }
      })
      let lastUploadedSize: { width: number; height: number } | null = null
      const getKind = () =>
        canvas.className.includes('raw-preview-original-gpu-canvas')
          ? 'original'
          : 'processed'
      const instance = {
        canvas,
        initialize: vi.fn(() => pipelineMock.initialize(canvas)),
        dispose,
        facadeDispose: dispose,
        disposeMock,
        onDisposed,
        unsubscribeDisposed,
        resize: vi.fn(),
        render: vi.fn(() => {
          const kind = getKind()
          pipelineMock.renderEvents.push({ kind })
          pipelineMock.pipelineEvents.push({
            kind,
            op: 'render',
            width: lastUploadedSize?.width,
            height: lastUploadedSize?.height,
          })
          return { renderMs: 1 }
        }),
        waitForGpu: vi.fn(() => pipelineMock.waitForGpu(canvas)),
        clearImage: vi.fn(),
        uploadImage: vi.fn((input) => {
          const kind = getKind()
          lastUploadedSize = {
            width: input.width,
            height: input.height,
          }
          pipelineMock.pipelineEvents.push({
            kind,
            op: 'upload',
            width: input.width,
            height: input.height,
          })
        }),
        clearLUT: vi.fn(),
        uploadLUT: vi.fn(),
        setParams: vi.fn(),
      }

      pipelineMock.instances.push(instance)
      return instance
    }),
}))

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve
    reject = innerReject
  })

  return { promise, resolve, reject }
}

const defaultParams: ProcessingParams = {
  userExposureEv: 0,
  userContrast: 0,
  userHighlights: 0,
  userShadows: 0,
  userWhites: 0,
  userBlacks: 0,
  userTemperature: 0,
  userTint: 0,
  userSaturation: 0,
  userVibrance: 0,
  selectiveColor: NEUTRAL_SELECTIVE_COLOR,
  intensity: 0.7,
  styleKind: 'none',
  builtinPreset: null,
}

const defaultColor = pickColorGraphIntent(defaultParams)

const decodedImage = createTestDecodedImage({ source: undefined })

/** An accepted frame descriptor as the workflow's producer would mint it. */
function frameDescriptor({
  sessionId = 'session-1',
  frameId,
  stage = 'unknown',
  width = 400,
  height = 300,
  quickPredecessorFrameId = null,
}: Pick<DecodedPreviewFrame, 'frameId'> &
  Partial<DecodedPreviewFrame>): DecodedPreviewFrame {
  return {
    sessionId,
    frameId,
    stage,
    width,
    height,
    exposure: {
      kind: 'unpinned',
      value: { ev: 0, multiplier: 1, source: 'identity' },
    },
    quickPredecessorFrameId,
  }
}

/** The descriptor tests pair with an image version; none before a decode. */
function testFrame(imageVersion: number): DecodedPreviewFrame | null {
  return imageVersion === 0
    ? null
    : frameDescriptor({ frameId: `decoded-frame-${imageVersion}` })
}

function getPipelineParamCalls() {
  return pipelineMock.instances.flatMap((instance) =>
    instance.setParams.mock.calls.map(([params]) => params),
  )
}

function processedPipelines() {
  return pipelineMock.instances.filter(
    (instance) =>
      !instance.canvas.className.includes('raw-preview-original-gpu-canvas'),
  )
}

const TEST_LUT_CUBE = `LUT_3D_SIZE 2\n${'0 0 0\n'.repeat(8)}`

function createTestLut(): LUTData {
  return {
    ...toLUTData(parseCubeLUT(TEST_LUT_CUBE)),
    profileResolution: { kind: 'unknown' },
  }
}

function captureResizeObservers() {
  const callbacks: ResizeObserverCallback[] = []
  vi.stubGlobal(
    'ResizeObserver',
    vi.fn().mockImplementation((callback: ResizeObserverCallback) => ({
      observe: vi.fn(() => {
        callbacks.push(callback)
      }),
      disconnect: vi.fn(),
    })),
  )
  return callbacks
}

function fireResize(
  callback: ResizeObserverCallback | undefined,
  width: number,
  height: number,
) {
  callback?.(
    [{ contentRect: elementRect({ width, height }) } as ResizeObserverEntry],
    {} as ResizeObserver,
  )
}

function elementRect({
  left = 0,
  top = 0,
  width,
  height,
}: {
  left?: number
  top?: number
  width: number
  height: number
}): DOMRect {
  return {
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    x: left,
    y: top,
    toJSON: () => ({}),
  } as DOMRect
}

function setElementRect(
  element: HTMLElement,
  rect: Parameters<typeof elementRect>[0],
) {
  vi.spyOn(element, 'getBoundingClientRect').mockReturnValue(elementRect(rect))
}

/** jsdom's MouseEvent stand-in for PointerEvent, carrying the pointer id. */
class TestPointerEvent extends MouseEvent {
  readonly pointerId: number

  constructor(type: string, init: PointerEventInit = {}) {
    super(type, init)
    this.pointerId = init.pointerId ?? 0
  }
}

function renderInteractivePreview({
  previewViewport = DEFAULT_PREVIEW_VIEWPORT,
  onPreviewViewportChange = vi.fn(),
}: {
  previewViewport?: typeof DEFAULT_PREVIEW_VIEWPORT
  onPreviewViewportChange?: ReturnType<typeof vi.fn>
} = {}) {
  const result = render(
    createElement(PreviewCanvas, {
      imageRef: { current: decodedImage },
      imageVersion: 1,
      decodedFrame: testFrame(1),
      color: defaultColor,
      viewMode: 'processed' as const,
      lutDataRef: { current: null },
      lutDataVersion: 0,
      previewViewport,
      onPreviewViewportChange,
    }),
  )
  const frame = result.container.querySelector<HTMLElement>(
    '[data-raw-preview-frame]',
  )
  const surface = result.container.querySelector<HTMLElement>(
    '[data-raw-preview-surface]',
  )
  const track = result.container.querySelector<HTMLElement>(
    '[data-raw-compare-track="image"]',
  )

  if (frame) setElementRect(frame, { width: 400, height: 300 })
  if (track) setElementRect(track, { width: 400, height: 300 })
  if (surface) setElementRect(surface, { width: 400, height: 300 })

  return {
    ...result,
    frame,
    track,
    surface,
    onPreviewViewportChange,
  }
}

describe('preview canvas upload descriptor', () => {
  beforeEach(() => {
    pipelineMock.instances.length = 0
    pipelineMock.renderEvents.length = 0
    pipelineMock.pipelineEvents.length = 0
    pipelineMock.initialize.mockReset()
    pipelineMock.initialize.mockResolvedValue(undefined)
    pipelineMock.waitForGpu.mockReset()
    pipelineMock.waitForGpu.mockResolvedValue(undefined)
    window.PointerEvent = TestPointerEvent as unknown as typeof PointerEvent
    HTMLElement.prototype.setPointerCapture = vi.fn()
    HTMLElement.prototype.releasePointerCapture = vi.fn()
    vi.stubGlobal(
      'ResizeObserver',
      vi.fn().mockImplementation(() => ({
        observe: vi.fn(),
        disconnect: vi.fn(),
      })),
    )
    vi.stubGlobal('CSS', {
      supports: vi.fn(() => true),
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('publishes processed frames only after the current generation finishes on the GPU', async () => {
    const firstFrame = deferred<void>()
    const nextFrame = deferred<void>()
    pipelineMock.waitForGpu.mockReturnValue(firstFrame.promise)
    const onStatsUpdate = vi.fn()
    const imageRef = { current: decodedImage }
    const props = {
      imageRef,
      imageVersion: 1,
      decodedFrame: testFrame(1),
      color: defaultColor,
      viewMode: 'processed' as const,
      lutDataRef: { current: null },
      lutDataVersion: 0,
      onStatsUpdate,
    }
    const { rerender } = render(createElement(PreviewCanvas, props))
    await waitFor(() => expect(pipelineMock.waitForGpu).toHaveBeenCalled())
    expect(onStatsUpdate).not.toHaveBeenCalled()

    pipelineMock.waitForGpu.mockClear().mockReturnValue(nextFrame.promise)
    imageRef.current = { ...decodedImage }
    rerender(
      createElement(PreviewCanvas, {
        ...props,
        imageVersion: 2,
        decodedFrame: testFrame(2),
      }),
    )
    await waitFor(() => expect(pipelineMock.waitForGpu).toHaveBeenCalled())
    await act(async () => firstFrame.reject(new Error('stale frame failed')))
    expect(onStatsUpdate).not.toHaveBeenCalled()
    expect(screen.queryByText('stale frame failed')).toBeNull()

    await act(async () => nextFrame.resolve())
    expect(onStatsUpdate).toHaveBeenCalledOnce()
    expect(pipelineMock.instances[0]?.render).toHaveBeenLastCalledWith()
  })

  it('keeps the processed surface still across view-only changes', async () => {
    const color = pickColorGraphIntent(defaultParams)
    const props = {
      imageRef: { current: decodedImage },
      imageVersion: 1,
      decodedFrame: testFrame(1),
      color,
      viewMode: 'compare' as const,
      lutDataRef: { current: null },
      lutDataVersion: 0,
    }
    const { rerender } = render(createElement(PreviewCanvas, props))
    await waitFor(() =>
      expect(pipelineMock.instances[0]?.render).toHaveBeenCalled(),
    )
    const pipeline = pipelineMock.instances[0]!
    pipeline.render.mockClear()
    pipeline.setParams.mockClear()

    // Compare and processed draw the same processed output.
    rerender(createElement(PreviewCanvas, { ...props, viewMode: 'processed' }))
    // An equal intent in a new record is the same color.
    rerender(
      createElement(PreviewCanvas, {
        ...props,
        viewMode: 'processed',
        color: { ...color },
      }),
    )
    expect(pipeline.render).not.toHaveBeenCalled()
    expect(pipeline.setParams).not.toHaveBeenCalled()

    rerender(
      createElement(PreviewCanvas, {
        ...props,
        viewMode: 'processed',
        color: { ...color, intensity: 0.37 },
      }),
    )
    expect(pipeline.setParams).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ intensity: 0.37, output: 'processed' }),
    )
    expect(pipeline.render).toHaveBeenCalledOnce()
  })

  it('redraws once after a LUT-only version change uploads the new LUT', async () => {
    const onStatsUpdate = vi.fn()
    const lutDataRef = { current: createTestLut() }
    const props = {
      imageRef: { current: decodedImage },
      imageVersion: 1,
      decodedFrame: testFrame(1),
      color: { ...defaultColor, styleKind: 'custom' as const },
      viewMode: 'processed' as const,
      lutDataRef,
      lutDataVersion: 1,
      onStatsUpdate,
    } satisfies ComponentProps<typeof PreviewCanvas>
    const { rerender } = render(createElement(PreviewCanvas, props))
    await waitFor(() => expect(onStatsUpdate).toHaveBeenCalled())
    const pipeline = pipelineMock.instances[0]!

    pipeline.uploadLUT.mockClear()
    pipeline.setParams.mockClear()
    pipeline.render.mockClear()
    onStatsUpdate.mockClear()
    const nextLut = createTestLut()
    lutDataRef.current = nextLut
    rerender(createElement(PreviewCanvas, { ...props, lutDataVersion: 2 }))

    expect(pipeline.uploadLUT).toHaveBeenCalledExactlyOnceWith(nextLut)
    expect(pipeline.render).toHaveBeenCalledOnce()
    expect(pipeline.uploadLUT.mock.invocationCallOrder[0]).toBeLessThan(
      pipeline.render.mock.invocationCallOrder[0]!,
    )
    expect(onStatsUpdate).toHaveBeenCalledOnce()
  })

  it('uploads a decoded frame with its RAW render exposure', () => {
    const data = new Uint16Array([1024, 1024, 1024])
    const image = createTestDecodedImage({
      width: 1,
      height: 1,
      data,
      renderExposure: { ev: 1.5, multiplier: 2 ** 1.5, source: 'identity' },
    })

    expect(createRawUploadInput(image)).toEqual({
      data,
      layout: 'rgb-u16',
      colorSpace: 'linear-prophoto-rgb',
      width: 1,
      height: 1,
      renderExposureEv: 1.5,
      renderExposureMultiplier: Math.pow(2, 1.5),
    })
  })

  it('uploads a frame, and clears the stale input without one', () => {
    const pipeline = {
      clearImage: vi.fn(),
      uploadImage: vi.fn(),
    }
    const image = createTestDecodedImage({ width: 1, height: 1 })

    expect(syncRawUploadInput(pipeline, image)).toBe(true)
    expect(pipeline.clearImage).not.toHaveBeenCalled()
    expect(pipeline.uploadImage).toHaveBeenCalledWith(
      createRawUploadInput(image),
    )

    expect(syncRawUploadInput(pipeline, null)).toBe(false)
    expect(pipeline.clearImage).toHaveBeenCalledTimes(1)
    expect(pipeline.uploadImage).toHaveBeenCalledTimes(1)
  })

  it('describes preview initialization failures without exposing a WebGL error panel', async () => {
    pipelineMock.initialize.mockRejectedValueOnce(
      new Error('Context restore failed'),
    )

    render(
      createElement(PreviewCanvas, {
        imageRef: { current: null },
        imageVersion: 0,
        decodedFrame: testFrame(0),
        color: defaultColor,
        viewMode: 'processed' as const,
        lutDataRef: { current: null },
        lutDataVersion: 0,
      }),
    )

    await waitFor(() => {
      expect(screen.getByText('Preview unavailable')).toBeTruthy()
    })
    expect(screen.queryByText('WebGL Error')).toBeNull()
    expect(screen.getByText('Context restore failed')).toBeTruthy()
  })

  it('withholds GPU frames after a LUT upload failure without tearing down the preview', async () => {
    const initialize = deferred<void>()
    pipelineMock.initialize.mockReturnValueOnce(initialize.promise)
    const onStatsUpdate = vi.fn()
    const onPipelineChange = vi.fn()
    const failedLut = createTestLut()
    const lutDataRef = { current: failedLut }
    const props = {
      imageRef: { current: decodedImage },
      imageVersion: 1,
      decodedFrame: testFrame(1),
      color: { ...defaultColor, styleKind: 'custom' as const },
      viewMode: 'processed' as const,
      lutDataRef,
      lutDataVersion: 1,
      onStatsUpdate,
      onPipelineChange,
    } satisfies ComponentProps<typeof PreviewCanvas>

    const { container, rerender } = render(createElement(PreviewCanvas, props))

    expect(pipelineMock.instances).toHaveLength(1)
    const [pipeline] = pipelineMock.instances
    pipeline!.uploadLUT.mockImplementationOnce(() => {
      throw new Error('Failed to create LUT texture')
    })

    await act(async () => {
      initialize.resolve()
    })

    // The failure stays inside the component: the surface and its pipeline
    // remain mounted, but no LUT-less frame or stats stand in for the look.
    expect(pipeline!.uploadLUT).toHaveBeenCalledExactlyOnceWith(failedLut)
    expect(onPipelineChange).toHaveBeenLastCalledWith(pipeline)
    expect(pipeline!.disposeMock).not.toHaveBeenCalled()
    expect(container.querySelector('canvas.raw-preview-canvas')).not.toBeNull()
    expect(screen.queryByText('Preview unavailable')).toBeNull()
    expect(pipeline!.render).not.toHaveBeenCalled()
    expect(onStatsUpdate).not.toHaveBeenCalled()

    const replacementLut = createTestLut()
    lutDataRef.current = replacementLut
    await act(async () => {
      rerender(createElement(PreviewCanvas, { ...props, lutDataVersion: 2 }))
    })

    expect(pipeline!.uploadLUT).toHaveBeenLastCalledWith(replacementLut)
    await waitFor(() => expect(onStatsUpdate).toHaveBeenCalled())
    expect(pipeline!.render).toHaveBeenCalled()
    expect(pipeline!.disposeMock).not.toHaveBeenCalled()
  })

  it('threads selectiveColor params through to the GPU pipeline (regression)', async () => {
    // Regression for a bug where processedCanvasParams omitted
    // params.selectiveColor — the GPU preview ignored every HSL slider
    // even though the bake, CPU preview, histogram, and export-state paths
    // all consumed it. The shader saw a permanently-undefined
    // selectiveColor and the u_selectiveColorActive gate stayed off.
    const neutralBand = { hue: 0, saturation: 0, lightness: 0 }
    const selectiveColor = {
      red: { hue: 50, saturation: 0, lightness: 0 },
      orange: neutralBand,
      yellow: neutralBand,
      green: neutralBand,
      aqua: neutralBand,
      blue: neutralBand,
      purple: neutralBand,
      magenta: neutralBand,
    }

    render(
      createElement(PreviewCanvas, {
        imageRef: { current: decodedImage },
        imageVersion: 1,
        decodedFrame: testFrame(1),
        color: { ...defaultColor, selectiveColor },
        viewMode: 'processed' as const,
        lutDataRef: { current: null },
        lutDataVersion: 0,
      }),
    )

    await waitFor(() => {
      expect(getPipelineParamCalls()).toContainEqual(
        expect.objectContaining({ selectiveColor }),
      )
    })
  })

  it('disposes the preview pipeline while suspended and recovers after resume', async () => {
    const onPipelineChange = vi.fn()

    const props = {
      imageRef: { current: null },
      imageVersion: 0,
      decodedFrame: testFrame(0),
      color: defaultColor,
      viewMode: 'processed' as const,
      lutDataRef: { current: null },
      lutDataVersion: 0,
      onPipelineChange,
    }
    const { rerender } = render(
      createElement(PreviewCanvas, {
        ...props,
      }),
    )

    await waitFor(() => {
      expect(onPipelineChange).toHaveBeenCalledWith(pipelineMock.instances[0])
    })

    const firstPipeline = pipelineMock.instances[0]!

    rerender(
      createElement(PreviewCanvas, {
        ...props,
        suspended: true,
      }),
    )

    expect(firstPipeline.disposeMock).toHaveBeenCalledOnce()
    expect(firstPipeline.dispose).toHaveBeenCalledOnce()
    expect(firstPipeline.unsubscribeDisposed).toHaveBeenCalledOnce()
    expect(onPipelineChange).toHaveBeenCalledWith(null)
    expect(pipelineMock.instances).toHaveLength(1)

    rerender(
      createElement(PreviewCanvas, {
        ...props,
        suspended: false,
      }),
    )

    await waitFor(() => {
      expect(onPipelineChange).toHaveBeenCalledWith(pipelineMock.instances[1])
    })

    // A stale handle to the suspended pipeline cannot clear its successor.
    const secondPipeline = pipelineMock.instances[1]!
    act(() => {
      firstPipeline.dispose()
    })
    expect(onPipelineChange).toHaveBeenLastCalledWith(secondPipeline)
    expect(firstPipeline.disposeMock).toHaveBeenCalledOnce()
    expect(secondPipeline.disposeMock).not.toHaveBeenCalled()
  })

  it('uses layered dual-gpu compare and keeps the processed canvas out of shader compare mode', async () => {
    const snapshot: OriginalReferenceSnapshot = {
      key: 'original-reference|session:test',
      objectUrl: 'blob:original-reference',
      width: 400,
      height: 300,
      source: 'quick',
      mimeType: 'image/jpeg',
      estimatedBytes: 1024,
    }

    const { container } = render(
      createElement(PreviewCanvas, {
        imageRef: { current: decodedImage },
        imageVersion: 1,
        decodedFrame: testFrame(1),
        color: defaultColor,
        viewMode: 'compare',
        lutDataRef: { current: null },
        lutDataVersion: 0,
        dualGpuAllowed: true,
        originalReferenceSnapshot: snapshot,
      }),
    )

    await waitFor(() => {
      expect(
        container.querySelector('[data-compare-mode="dual-gpu"]'),
      ).toBeTruthy()
    })

    expect(
      container.querySelector('.raw-preview-original-gpu-layer'),
    ).toBeTruthy()
    expect(container.querySelector('.raw-preview-original-layer')).toBeNull()
    expect(container.querySelector('.raw-preview-processed-layer')).toHaveClass(
      'raw-preview-layer-clipped',
    )
    await waitFor(() => {
      expect(getPipelineParamCalls()).toContainEqual(
        expect.objectContaining({ output: 'processed' }),
      )
    })
  })

  it('keeps the embedded preview clipped on the left while original GPU warms', async () => {
    const originalInitialize = deferred<void>()
    pipelineMock.initialize.mockImplementation((canvas: HTMLCanvasElement) => {
      if (canvas.className.includes('raw-preview-original-gpu-canvas')) {
        return originalInitialize.promise
      }

      return Promise.resolve()
    })

    const { container } = render(
      createElement(PreviewCanvas, {
        imageRef: { current: { ...decodedImage, source: 'quick' } },
        imageVersion: 1,
        decodedFrame: testFrame(1),
        color: defaultColor,
        viewMode: 'compare',
        lutDataRef: { current: null },
        lutDataVersion: 0,
        embeddedPreviewUrl: 'blob:embedded-preview',
        displaySource: 'quick',
        dualGpuAllowed: true,
      }),
    )

    await waitFor(() => {
      expect(
        container.querySelector('[data-compare-mode="embedded-fallback"]'),
      ).toBeTruthy()
    })

    expect(
      container.querySelector('.raw-preview-original-layer img'),
    ).toHaveAttribute('src', 'blob:embedded-preview')
    expect(container.querySelector('.raw-preview-processed-layer')).toHaveClass(
      'raw-preview-layer-clipped',
    )

    await act(async () => {
      originalInitialize.resolve()
      await originalInitialize.promise
      await Promise.resolve()
    })
  })

  it('uses jpeg fallback compare when a snapshot is ready and dual-gpu is unavailable', async () => {
    const snapshot: OriginalReferenceSnapshot = {
      key: 'original-reference|session:test',
      objectUrl: 'blob:original-reference',
      width: 400,
      height: 300,
      source: 'quick',
      mimeType: 'image/jpeg',
      estimatedBytes: 1024,
    }

    const { container } = render(
      createElement(PreviewCanvas, {
        imageRef: { current: decodedImage },
        imageVersion: 1,
        decodedFrame: testFrame(1),
        color: defaultColor,
        viewMode: 'compare',
        lutDataRef: { current: null },
        lutDataVersion: 0,
        dualGpuAllowed: false,
        originalReferenceSnapshot: snapshot,
      }),
    )

    await waitFor(() => {
      expect(
        container.querySelector('[data-compare-mode="jpeg-fallback"]'),
      ).toBeTruthy()
    })

    expect(
      container.querySelector('.raw-preview-original-layer img'),
    ).toHaveAttribute('src', 'blob:original-reference')
    expect(container.querySelector('.raw-preview-processed-layer')).toHaveClass(
      'raw-preview-layer-clipped',
    )
    await waitFor(() => {
      expect(getPipelineParamCalls()).toContainEqual(
        expect.objectContaining({ output: 'processed' }),
      )
    })
  })

  it('exposes structured processed-only compare fallback reasons', async () => {
    const { container, rerender } = render(
      createElement(PreviewCanvas, {
        imageRef: { current: decodedImage },
        imageVersion: 1,
        decodedFrame: testFrame(1),
        color: defaultColor,
        viewMode: 'compare',
        lutDataRef: { current: null },
        lutDataVersion: 0,
        dualGpuAllowed: false,
      }),
    )

    await waitFor(() => {
      expect(
        container.querySelector('[data-compare-mode="processed-only"]'),
      ).toHaveAttribute(
        'data-compare-fallback-reason',
        'jpeg-fallback-unavailable',
      )
    })

    vi.stubGlobal('CSS', {
      supports: vi.fn(() => false),
    })

    rerender(
      createElement(PreviewCanvas, {
        imageRef: { current: decodedImage },
        imageVersion: 2,
        decodedFrame: testFrame(2),
        color: defaultColor,
        viewMode: 'compare',
        lutDataRef: { current: null },
        lutDataVersion: 0,
        dualGpuAllowed: true,
      }),
    )

    await waitFor(() => {
      expect(
        container.querySelector('[data-compare-mode="processed-only"]'),
      ).toHaveAttribute('data-compare-fallback-reason', 'css-clip-unavailable')
    })
  })

  it('does not rerender the GPU preview during split or viewport changes when layered compare is active', async () => {
    const snapshot: OriginalReferenceSnapshot = {
      key: 'original-reference|session:test',
      objectUrl: 'blob:original-reference',
      width: 400,
      height: 300,
      source: 'quick',
      mimeType: 'image/jpeg',
      estimatedBytes: 1024,
    }
    const props = {
      imageRef: { current: decodedImage },
      imageVersion: 1,
      decodedFrame: testFrame(1),
      color: defaultColor,
      viewMode: 'compare' as const,
      lutDataRef: { current: null },
      lutDataVersion: 0,
      dualGpuAllowed: false,
      originalReferenceSnapshot: snapshot,
      previewViewport: DEFAULT_PREVIEW_VIEWPORT,
    }

    const { rerender } = render(createElement(PreviewCanvas, props))

    await waitFor(() => {
      expect(pipelineMock.instances[0]?.render).toHaveBeenCalled()
    })

    const processedPipeline = pipelineMock.instances[0]!
    processedPipeline.render.mockClear()

    rerender(
      createElement(PreviewCanvas, {
        ...props,
        // The same color in a new record, with only the split moved.
        color: { ...defaultColor },
      }),
    )
    rerender(
      createElement(PreviewCanvas, {
        ...props,
        // The same color in a new record, with only the split moved.
        color: { ...defaultColor },
        previewViewport: {
          zoom: 2,
          panX: 80,
          panY: 0,
          fitMode: 'custom',
        },
      }),
    )

    expect(processedPipeline.render).not.toHaveBeenCalled()
  })

  it('pans a zoomed preview with pointer drag', async () => {
    const { frame, onPreviewViewportChange } = renderInteractivePreview({
      previewViewport: { zoom: 2, panX: 0, panY: 0, fitMode: 'custom' },
    })

    await waitFor(() => {
      expect(pipelineMock.instances).toHaveLength(1)
    })

    const rafCallbacks: FrameRequestCallback[] = []
    const raf = vi
      .spyOn(window, 'requestAnimationFrame')
      .mockImplementation((cb) => {
        rafCallbacks.push(cb)
        return rafCallbacks.length
      })

    expect(frame).not.toBeNull()
    fireEvent.pointerDown(frame!, {
      pointerId: 1,
      button: 0,
      clientX: 200,
      clientY: 150,
    })
    fireEvent.pointerMove(frame!, {
      pointerId: 1,
      clientX: 240,
      clientY: 170,
    })

    expect(onPreviewViewportChange).not.toHaveBeenCalled()
    rafCallbacks[0]?.(performance.now())

    expect(onPreviewViewportChange).toHaveBeenCalled()
    const next = onPreviewViewportChange.mock.calls.at(-1)?.[0]
    expect(next).toEqual({
      zoom: 2,
      panX: 40,
      panY: 20,
      fitMode: 'custom',
    })

    raf.mockRestore()
  })

  it('isolates an original layer failure from the processed surface', async () => {
    vi.mocked(RawProcessingPipeline).mockClear()
    pipelineMock.initialize.mockImplementation((canvas: HTMLCanvasElement) =>
      canvas.className.includes('raw-preview-original-gpu-canvas')
        ? Promise.reject(new Error('Original layer failed'))
        : Promise.resolve(),
    )
    const onPipelineChange = vi.fn()
    const onStatsUpdate = vi.fn()
    const onRequestOriginalReferenceFallback = vi.fn()
    const { container } = render(
      createElement(PreviewCanvas, {
        imageRef: { current: decodedImage },
        imageVersion: 1,
        decodedFrame: testFrame(1),
        color: defaultColor,
        viewMode: 'compare',
        lutDataRef: { current: null },
        lutDataVersion: 0,
        dualGpuAllowed: true,
        onPipelineChange,
        onStatsUpdate,
        onRequestOriginalReferenceFallback,
      }),
    )

    await waitFor(() =>
      expect(onRequestOriginalReferenceFallback).toHaveBeenCalledOnce(),
    )
    await waitFor(() =>
      expect(
        container.querySelector('[data-compare-mode="processed-only"]'),
      ).toHaveAttribute(
        'data-compare-fallback-reason',
        'jpeg-fallback-unavailable',
      ),
    )
    // The original layer never reports to the primary preview's failure
    // channel, so its failure cannot move the preview to the CPU executor.
    const constructorCalls = vi.mocked(RawProcessingPipeline).mock.calls
    expect(constructorCalls).toContainEqual([
      expect.objectContaining({ className: 'raw-preview-original-gpu-canvas' }),
      { reportFailures: false },
    ])
    expect(constructorCalls).toContainEqual([
      expect.objectContaining({ className: 'raw-preview-canvas' }),
    ])
    expect(
      container.querySelector('.raw-preview-original-gpu-layer'),
    ).toBeNull()
    const [processed] = processedPipelines()
    expect(processed!.render).toHaveBeenCalledOnce()
    expect(processed!.disposeMock).not.toHaveBeenCalled()
    expect(onStatsUpdate).toHaveBeenCalledOnce()
    expect(onPipelineChange).not.toHaveBeenCalledWith(null)
    expect(screen.queryByText('Preview unavailable')).toBeNull()
  })

  describe('accepted frame identity', () => {
    const quickFrame = frameDescriptor({
      frameId: 'decoded-frame-1',
      stage: 'quick',
    })

    function trackOf(container: HTMLElement) {
      return container.querySelector('[data-raw-compare-track="image"]')
    }

    async function renderFittedQuickFrame(
      overrides: Partial<ComponentProps<typeof PreviewCanvas>> = {},
    ) {
      const resizeCallbacks = captureResizeObservers()
      const imageRef: RefObject<DecodedImage | null> = {
        current: { ...decodedImage, source: 'quick' as const },
      }
      const props: ComponentProps<typeof PreviewCanvas> = {
        imageRef,
        imageVersion: 1,
        decodedFrame: quickFrame,
        color: defaultColor,
        viewMode: 'processed' as const,
        lutDataRef: { current: null },
        lutDataVersion: 0,
        displaySource: 'quick',
        ...overrides,
      }
      const view = render(createElement(PreviewCanvas, props))
      await waitFor(() => {
        expect(processedPipelines()[0]?.render).toHaveBeenCalled()
        expect(resizeCallbacks.length).toBeGreaterThan(0)
      })
      act(() => {
        for (const callback of resizeCallbacks) fireResize(callback, 400, 300)
      })
      await waitFor(() => {
        expect(trackOf(view.container)).toHaveAttribute(
          'data-preview-track-ready',
          'true',
        )
      })
      return { ...view, imageRef, props }
    }

    /** Hands the canvas a bounded-HQ frame with the quick frame's size. */
    function showBoundedHq(
      view: Awaited<ReturnType<typeof renderFittedQuickFrame>>,
      decodedFrame: DecodedPreviewFrame,
    ) {
      view.imageRef.current = {
        ...decodedImage,
        source: 'bounded-hq',
        data: new Uint16Array(400 * 300 * 3),
      }
      view.rerender(
        createElement(PreviewCanvas, {
          ...view.props,
          imageVersion: 2,
          decodedFrame,
          displaySource: 'bounded-hq',
        }),
      )
    }

    it('keeps the quick frame on screen for the bounded-HQ frame that names it', async () => {
      const view = await renderFittedQuickFrame()

      showBoundedHq(
        view,
        frameDescriptor({
          frameId: 'decoded-frame-2',
          stage: 'bounded-hq',
          quickPredecessorFrameId: quickFrame.frameId,
        }),
      )

      expect(trackOf(view.container)).toHaveAttribute(
        'data-preview-track-ready',
        'true',
      )
      await act(async () => {
        await Promise.resolve()
      })
    })

    it('never publishes late work of a replaced frame, whatever the version counter says', async () => {
      const staleFrame = deferred<void>()
      const currentFrame = deferred<void>()
      pipelineMock.waitForGpu
        .mockReturnValueOnce(staleFrame.promise)
        .mockReturnValueOnce(currentFrame.promise)
      const onStatsUpdate = vi.fn()
      const imageRef: RefObject<DecodedImage | null> = {
        current: { ...decodedImage, source: 'quick' as const },
      }
      const props: ComponentProps<typeof PreviewCanvas> = {
        imageRef,
        imageVersion: 1,
        decodedFrame: quickFrame,
        color: defaultColor,
        viewMode: 'processed' as const,
        lutDataRef: { current: null },
        lutDataVersion: 0,
        displaySource: 'quick',
        onStatsUpdate,
      }
      const { rerender } = render(createElement(PreviewCanvas, props))
      await waitFor(() => expect(pipelineMock.waitForGpu).toHaveBeenCalled())

      // Another source's frame of the same size arrives under the same
      // counter value: the descriptor alone says the pixels changed.
      imageRef.current = { ...decodedImage, source: 'quick' as const }
      rerender(
        createElement(PreviewCanvas, {
          ...props,
          decodedFrame: frameDescriptor({
            sessionId: 'session-2',
            frameId: 'decoded-frame-1',
            stage: 'quick',
          }),
        }),
      )
      await waitFor(() =>
        expect(pipelineMock.waitForGpu).toHaveBeenCalledTimes(2),
      )
      expect(processedPipelines()[0]?.uploadImage.mock.calls.length).toBe(2)

      await act(async () => staleFrame.resolve())
      expect(onStatsUpdate).not.toHaveBeenCalled()

      await act(async () => currentFrame.resolve())
      expect(onStatsUpdate).toHaveBeenCalledOnce()
    })
  })

  describe('backing store resize', () => {
    async function renderSizedPreview(
      image: DecodedImage = decodedImage,
      onStatsUpdate = vi.fn(),
    ) {
      const resizeCallbacks = captureResizeObservers()
      const imageRef = { current: image }
      const props = {
        imageRef,
        imageVersion: 1,
        decodedFrame: testFrame(1),
        color: defaultColor,
        viewMode: 'processed' as const,
        lutDataRef: { current: null },
        lutDataVersion: 0,
        onStatsUpdate,
      } satisfies ComponentProps<typeof PreviewCanvas>
      const result = render(createElement(PreviewCanvas, props))
      await waitFor(() => expect(onStatsUpdate).toHaveBeenCalledOnce())
      const track = result.container.querySelector<HTMLElement>(
        '[data-raw-compare-track="image"]',
      )!
      const canvas = track.querySelector('canvas')!
      const pipeline = processedPipelines()[0]!
      return { ...result, props, resizeCallbacks, track, canvas, pipeline }
    }

    it('fits the first size at once, then settles rapid resizes into one resize and draw', async () => {
      const { resizeCallbacks, track, canvas, pipeline } =
        await renderSizedPreview()
      const callback = resizeCallbacks.at(-1)
      pipeline.resize.mockClear()
      pipeline.render.mockClear()

      vi.useFakeTimers()
      try {
        act(() => fireResize(callback, 400, 300))
        expect(pipeline.resize).toHaveBeenCalledExactlyOnceWith(400, 300)
        expect(pipeline.render).toHaveBeenCalledOnce()

        act(() => fireResize(callback, 800, 300))
        act(() => vi.advanceTimersByTime(50))
        act(() => fireResize(callback, 600, 600))
        act(() => vi.advanceTimersByTime(50))
        act(() => fireResize(callback, 1000, 450))

        expect(track.style.width).toBe('600px')
        expect(track.style.height).toBe('450px')
        expect([canvas.width, canvas.height]).toEqual([400, 300])
        expect(pipeline.resize).toHaveBeenCalledOnce()

        act(() => vi.advanceTimersByTime(89))
        expect(pipeline.resize).toHaveBeenCalledOnce()
        act(() => vi.advanceTimersByTime(1))

        expect([canvas.width, canvas.height]).toEqual([600, 450])
        expect(pipeline.resize).toHaveBeenCalledTimes(2)
        expect(pipeline.resize).toHaveBeenLastCalledWith(600, 450)
        expect(pipeline.render).toHaveBeenCalledTimes(2)
        expect(vi.getTimerCount()).toBe(0)
      } finally {
        vi.useRealTimers()
      }
    })
  })

  describe('stage frame markup', () => {
    interface MarkupNode {
      tag: string
      attrs: Record<string, string>
      children: MarkupNode[]
    }

    const OUTLINED_ATTRIBUTES = new Set([
      'class',
      'alt',
      'src',
      'width',
      'height',
      'draggable',
      'decoding',
      'aria-hidden',
    ])

    /** The stage DOM as tags, classes, data attributes and accessibility. */
    function outline(element: Element): MarkupNode {
      const attrs: Record<string, string> = {}
      for (const { name, value } of element.attributes) {
        if (OUTLINED_ATTRIBUTES.has(name) || name.startsWith('data-')) {
          attrs[name] = value
        }
      }
      return {
        tag: element.tagName.toLowerCase(),
        attrs,
        children: Array.from(element.children, outline),
      }
    }

    function frameOutline(container: HTMLElement) {
      const frame = container.querySelector('[data-raw-preview-frame]')
      expect(frame).not.toBeNull()
      expect(container.children).toHaveLength(1)
      expect(container.firstElementChild).toBe(frame)
      return outline(frame!)
    }

    it('covers the stage with the error overlay instead of the empty state', async () => {
      pipelineMock.initialize.mockRejectedValue(new Error('adapter lost'))
      const { container } = render(
        createElement(PreviewCanvas, {
          imageRef: { current: null },
          imageVersion: 0,
          decodedFrame: testFrame(0),
          color: defaultColor,
          viewMode: 'processed' as const,
          lutDataRef: { current: null },
          lutDataVersion: 0,
        }),
      )
      await waitFor(() => {
        expect(screen.getByText('Preview unavailable')).toBeTruthy()
      })

      const frame = frameOutline(container)
      expect(frame.children).toHaveLength(2)
      expect(frame.children[0]!.attrs.class).toBe('raw-preview-track')
      const overlay = frame.children[1]!
      expect(overlay.attrs.class).toBe(
        'absolute inset-0 z-[4] flex items-center justify-center bg-background/80',
      )
      expect(screen.queryByText('No image loaded')).toBeNull()
      expect(
        screen.getByRole('heading', { name: 'Preview unavailable' }),
      ).toBeTruthy()
    })
  })
})
