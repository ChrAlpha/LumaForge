import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

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

import { BACKING_STORE_SETTLE_MS } from '../hooks/preview/backing-store-resize'
import type { OriginalReferenceSnapshot } from '../services/compare/original-reference-snapshot'
import {
  createRawUploadInput,
  syncRawUploadInput,
} from '../services/preview/preview-canvas-helpers'
import { DEFAULT_PREVIEW_VIEWPORT } from '../services/preview/preview-viewport'
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
      const dispose = vi.fn((options?: { releaseContext?: boolean }) => {
        if (disposed) return
        disposed = true
        if (options) disposeMock(options)
        else disposeMock()
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

const previewCanvasCss = readFileSync(
  resolve(
    process.cwd(),
    'src/modules/raw-processor/components/preview-canvas.css',
  ),
  'utf8',
)

const decodedImage: DecodedImage = {
  width: 400,
  height: 300,
  channels: 3,
  bitsPerChannel: 16,
  data: new Uint16Array(400 * 300 * 3),
  layout: 'rgb-u16',
  colorSpace: 'linear-prophoto-rgb',
  metadata: {
    width: 400,
    height: 300,
  },
  renderExposure: { ev: 0, multiplier: 1, source: 'identity' },
}

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

/** A quick frame and the bounded-HQ frame that names it. */
const quickTestFrame = frameDescriptor({
  frameId: 'decoded-frame-1',
  stage: 'quick',
})
const boundedHqTestFrame = frameDescriptor({
  frameId: 'decoded-frame-2',
  stage: 'bounded-hq',
  quickPredecessorFrameId: 'decoded-frame-1',
})

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

function originalPipelines() {
  return pipelineMock.instances.filter((instance) =>
    instance.canvas.className.includes('raw-preview-original-gpu-canvas'),
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

/**
 * Holds every observer notification until the test delivers it, as the
 * browser does: an observe() notification arrives on a later rendering step,
 * not inside observe() itself.
 */
function queueFrameResizeObservers() {
  const frameCallbacks: ResizeObserverCallback[] = []
  vi.stubGlobal(
    'ResizeObserver',
    vi.fn().mockImplementation((callback: ResizeObserverCallback) => ({
      observe: vi.fn((target: Element) => {
        if (target.hasAttribute('data-raw-preview-frame')) {
          frameCallbacks.push(callback)
        }
      }),
      disconnect: vi.fn(),
    })),
  )
  let delivered = 0
  return {
    /** Delivers the observe() notification of every frame observer not yet heard. */
    deliverPending: (width: number, height: number) => {
      const pending = frameCallbacks.slice(delivered)
      delivered = frameCallbacks.length
      for (const callback of pending) fireResize(callback, width, height)
      return pending.length
    },
  }
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

/** Holds animation frames until the test runs them. */
function captureAnimationFrames() {
  const callbacks = new Map<number, FrameRequestCallback>()
  let nextId = 0
  const request = vi
    .spyOn(window, 'requestAnimationFrame')
    .mockImplementation((callback) => {
      nextId += 1
      callbacks.set(nextId, callback)
      return nextId
    })
  const cancel = vi
    .spyOn(window, 'cancelAnimationFrame')
    .mockImplementation((id) => {
      callbacks.delete(id)
    })

  return {
    request,
    cancel,
    lastId: () => nextId,
    run: () => {
      const pending = [...callbacks.values()]
      callbacks.clear()
      for (const callback of pending) callback(performance.now())
    },
    restore: () => {
      request.mockRestore()
      cancel.mockRestore()
    },
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

/** Sets the device pixel ratio the backing store reads until restored. */
function stubDevicePixelRatio(value: number) {
  const original = Object.getOwnPropertyDescriptor(window, 'devicePixelRatio')
  Object.defineProperty(window, 'devicePixelRatio', {
    configurable: true,
    value,
  })
  return () => {
    if (original) {
      Object.defineProperty(window, 'devicePixelRatio', original)
    } else {
      Reflect.deleteProperty(window, 'devicePixelRatio')
    }
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

  it('reuses the first-ready fence while sliders change and stops fencing after ready', async () => {
    const completed = deferred<void>()
    pipelineMock.waitForGpu.mockReturnValue(completed.promise)
    const onStatsUpdate = vi.fn()
    const props = {
      imageRef: { current: decodedImage },
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
    for (const userExposureEv of [0.1, 0.2, 0.3]) {
      rerender(
        createElement(PreviewCanvas, {
          ...props,
          color: { ...defaultColor, userExposureEv },
          viewMode: 'processed' as const,
        }),
      )
    }
    expect(pipelineMock.waitForGpu).toHaveBeenCalledOnce()
    expect(onStatsUpdate).not.toHaveBeenCalled()

    await act(async () => completed.resolve())
    expect(onStatsUpdate).toHaveBeenCalledOnce()
    onStatsUpdate.mockClear()
    pipelineMock.waitForGpu.mockClear()
    pipelineMock.instances[0]!.render.mockClear()
    rerender(
      createElement(PreviewCanvas, {
        ...props,
        color: { ...defaultColor, userExposureEv: 0.4 },
        viewMode: 'processed' as const,
      }),
    )

    expect(pipelineMock.instances[0]!.render).toHaveBeenCalledWith()
    expect(onStatsUpdate).toHaveBeenCalled()
    expect(pipelineMock.waitForGpu).not.toHaveBeenCalled()
  })

  it('draws one processed frame per processed input change', async () => {
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
    await waitFor(() => expect(onStatsUpdate).toHaveBeenCalled())
    const pipeline = pipelineMock.instances[0]!
    expect(pipeline.render).toHaveBeenCalledOnce()
    expect(onStatsUpdate).toHaveBeenCalledOnce()

    pipeline.render.mockClear()
    pipeline.setParams.mockClear()
    onStatsUpdate.mockClear()
    rerender(
      createElement(PreviewCanvas, {
        ...props,
        color: { ...defaultColor, userExposureEv: 0.5 },
        viewMode: 'processed' as const,
      }),
    )

    expect(pipeline.setParams).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ userExposureEv: 0.5 }),
    )
    expect(pipeline.render).toHaveBeenCalledOnce()
    expect(onStatsUpdate).toHaveBeenCalledOnce()

    pipeline.render.mockClear()
    onStatsUpdate.mockClear()
    imageRef.current = { ...decodedImage }
    await act(async () => {
      rerender(
        createElement(PreviewCanvas, {
          ...props,
          imageVersion: 2,
          decodedFrame: testFrame(2),
          color: { ...defaultColor, userExposureEv: 0.5 },
          viewMode: 'processed' as const,
        }),
      )
    })

    expect(pipeline.render).toHaveBeenCalledOnce()
    expect(onStatsUpdate).toHaveBeenCalledOnce()
  })

  it('draws the processed surface from the color intent and the explicit view alone', async () => {
    const color = pickColorGraphIntent({
      ...defaultParams,
      userExposureEv: 0.5,
    })
    const props = {
      imageRef: { current: decodedImage },
      imageVersion: 1,
      decodedFrame: testFrame(1),
      color,
      viewMode: 'original' as const,
      lutDataRef: { current: null },
      lutDataVersion: 0,
    }
    const { rerender } = render(createElement(PreviewCanvas, props))
    await waitFor(() =>
      expect(pipelineMock.instances[0]?.render).toHaveBeenCalled(),
    )
    const pipeline = pipelineMock.instances[0]!
    expect(pipeline.setParams).toHaveBeenLastCalledWith({
      ...color,
      viewMode: 'original',
    })

    rerender(createElement(PreviewCanvas, { ...props, viewMode: 'compare' }))
    // Compare draws the processed photo; the stage layers the original over it.
    expect(pipeline.setParams).toHaveBeenLastCalledWith({
      ...color,
      viewMode: 'processed',
    })
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
      expect.objectContaining({ intensity: 0.37, viewMode: 'processed' }),
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

  it.each(['unmount', 'suspend'] as const)(
    'ignores processed GPU completion after %s',
    async (stop) => {
      const completed = deferred<void>()
      pipelineMock.waitForGpu.mockReturnValue(completed.promise)
      const onStatsUpdate = vi.fn()
      const props = {
        imageRef: { current: decodedImage },
        imageVersion: 1,
        decodedFrame: testFrame(1),
        color: defaultColor,
        viewMode: 'processed' as const,
        lutDataRef: { current: null },
        lutDataVersion: 0,
        onStatsUpdate,
      }
      const { unmount, rerender } = render(createElement(PreviewCanvas, props))
      await waitFor(() => expect(pipelineMock.waitForGpu).toHaveBeenCalled())
      if (stop === 'unmount') unmount()
      else rerender(createElement(PreviewCanvas, { ...props, suspended: true }))
      await act(async () => completed.resolve())
      expect(onStatsUpdate).not.toHaveBeenCalled()
    },
  )

  it('refuses legacy Float32 RGBA display-sRGB input for the GPU upload', () => {
    expect(
      createRawUploadInput({
        data: new Float32Array(4),
        layout: 'rgba-float32',
        colorSpace: 'display-srgb-preview',
        width: 1,
        height: 1,
      }),
    ).toBeNull()
  })

  it('accepts RGB16 Linear ProPhoto input', () => {
    const data = new Uint16Array(3)

    expect(
      createRawUploadInput({
        data,
        layout: 'rgb-u16',
        colorSpace: 'linear-prophoto-rgb',
        width: 1,
        height: 1,
        renderExposureEv: 0,
      }),
    ).toEqual({
      data,
      layout: 'rgb-u16',
      colorSpace: 'linear-prophoto-rgb',
      width: 1,
      height: 1,
      renderExposureEv: 0,
      renderExposureMultiplier: 1,
    })
  })

  it('passes decoded raw render exposure into GPU upload input', () => {
    const data = new Uint16Array([1024, 1024, 1024])
    expect(
      createRawUploadInput({
        data,
        layout: 'rgb-u16',
        colorSpace: 'linear-prophoto-rgb',
        width: 1,
        height: 1,
        renderExposureEv: 1.5,
      }),
    ).toMatchObject({
      renderExposureEv: 1.5,
      renderExposureMultiplier: Math.pow(2, 1.5),
    })
  })

  it('rejects mismatched data, layout, and color space combinations', () => {
    expect(
      createRawUploadInput({
        data: new Uint16Array(3),
        layout: 'rgba-float32',
        colorSpace: 'display-srgb-preview',
        width: 1,
        height: 1,
      }),
    ).toBeNull()
    expect(
      createRawUploadInput({
        data: new Float32Array(4),
        layout: 'rgb-u16',
        colorSpace: 'linear-prophoto-rgb',
        width: 1,
        height: 1,
        renderExposureEv: 0,
      }),
    ).toBeNull()
    expect(
      createRawUploadInput({
        data: new Uint16Array(3),
        layout: 'rgb-u16',
        colorSpace: 'display-srgb-preview',
        width: 1,
        height: 1,
      }),
    ).toBeNull()
  })

  it('clears stale pipeline input when data is missing', () => {
    const pipeline = {
      clearImage: vi.fn(),
      uploadImage: vi.fn(),
    }
    const setError = vi.fn()

    expect(
      syncRawUploadInput({
        pipeline,
        imageData: null,
        uploadInput: null,
        setError,
      }),
    ).toBe(false)
    expect(pipeline.clearImage).toHaveBeenCalledTimes(1)
    expect(pipeline.uploadImage).not.toHaveBeenCalled()
    expect(setError).toHaveBeenCalledWith(null)
  })

  it('clears stale pipeline input when descriptor validation fails', () => {
    const pipeline = {
      clearImage: vi.fn(),
      uploadImage: vi.fn(),
    }
    const setError = vi.fn()

    expect(
      syncRawUploadInput({
        pipeline,
        imageData: new Uint16Array(3),
        uploadInput: null,
        setError,
      }),
    ).toBe(false)
    expect(pipeline.clearImage).toHaveBeenCalledTimes(1)
    expect(pipeline.uploadImage).not.toHaveBeenCalled()
    expect(setError).toHaveBeenCalledWith(
      'Decoded image data does not match the GPU upload layout',
    )
  })

  it('uploads valid descriptors without clearing the pipeline', () => {
    const pipeline = {
      clearImage: vi.fn(),
      uploadImage: vi.fn(),
    }
    const setError = vi.fn()
    const uploadInput = {
      data: new Uint16Array(3),
      layout: 'rgb-u16',
      colorSpace: 'linear-prophoto-rgb',
      width: 1,
      height: 1,
      renderExposureEv: 0,
      renderExposureMultiplier: 1,
    } as const

    expect(
      syncRawUploadInput({
        pipeline,
        imageData: uploadInput.data,
        uploadInput,
        setError,
      }),
    ).toBe(true)
    expect(pipeline.clearImage).not.toHaveBeenCalled()
    expect(pipeline.uploadImage).toHaveBeenCalledWith(uploadInput)
    expect(setError).toHaveBeenCalledWith(null)
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

  it('uploads decoded image render exposure through the component path', async () => {
    const data = new Uint16Array([1024, 1024, 1024])
    const image: DecodedImage = {
      data,
      width: 1,
      height: 1,
      channels: 3,
      bitsPerChannel: 16,
      layout: 'rgb-u16',
      colorSpace: 'linear-prophoto-rgb',
      metadata: {
        width: 1,
        height: 1,
      },
      renderExposure: {
        ev: 1.25,
        multiplier: Math.pow(2, 1.25),
        source: 'image-statistics',
      },
    }

    render(
      createElement(PreviewCanvas, {
        imageRef: { current: image },
        imageVersion: 1,
        decodedFrame: testFrame(1),
        color: defaultColor,
        viewMode: 'processed' as const,
        lutDataRef: { current: null },
        lutDataVersion: 0,
      }),
    )

    await waitFor(() => {
      expect(pipelineMock.instances).toHaveLength(1)
      expect(pipelineMock.instances[0]?.uploadImage).toHaveBeenCalledWith(
        expect.objectContaining({
          renderExposureEv: 1.25,
          renderExposureMultiplier: Math.pow(2, 1.25),
        }),
      )
    })
  })

  it('does not publish a pipeline after unmount during async initialization', async () => {
    const initialize = deferred<void>()
    const onPipelineChange = vi.fn()
    pipelineMock.initialize.mockReturnValueOnce(initialize.promise)

    const { unmount } = render(
      createElement(PreviewCanvas, {
        imageRef: { current: null },
        imageVersion: 0,
        decodedFrame: testFrame(0),
        color: defaultColor,
        viewMode: 'processed' as const,
        lutDataRef: { current: null },
        lutDataVersion: 0,
        onPipelineChange,
      }),
    )

    expect(pipelineMock.instances).toHaveLength(1)
    const [pipeline] = pipelineMock.instances

    act(() => {
      unmount()
    })

    await act(async () => {
      initialize.resolve()
      await initialize.promise
      await Promise.resolve()
    })

    expect(pipeline.disposeMock).toHaveBeenCalledTimes(1)
    expect(pipeline.dispose).toHaveBeenCalledOnce()
    expect(pipeline.onDisposed).toHaveBeenCalledOnce()
    expect(pipeline.unsubscribeDisposed).toHaveBeenCalledOnce()
    expect(onPipelineChange).toHaveBeenCalledWith(null)
    expect(onPipelineChange).not.toHaveBeenCalledWith(pipeline)
  })

  it.each([
    ['resolves', (): Error | undefined => undefined],
    [
      'rejects',
      (): Error | undefined => new Error('PREVIEW_PIPELINE_DISPOSED'),
    ],
  ] as const)(
    'never revives a pipeline disposed while its initialization is pending (initialization %s late)',
    async (_outcome, lateOutcome) => {
      const initialize = deferred<void>()
      const onPipelineChange = vi.fn()
      const onStatsUpdate = vi.fn()
      pipelineMock.initialize.mockReturnValueOnce(initialize.promise)

      const { unmount } = render(
        createElement(PreviewCanvas, {
          imageRef: { current: decodedImage },
          imageVersion: 1,
          decodedFrame: testFrame(1),
          color: defaultColor,
          viewMode: 'processed' as const,
          lutDataRef: { current: null },
          lutDataVersion: 0,
          onPipelineChange,
          onStatsUpdate,
        }),
      )

      expect(pipelineMock.instances).toHaveLength(1)
      const [pipeline] = pipelineMock.instances
      act(() => {
        pipeline.dispose({ releaseContext: true })
      })

      await act(async () => {
        const failure = lateOutcome()
        if (failure) initialize.reject(failure)
        else initialize.resolve()
        await initialize.promise.catch(() => {})
        await Promise.resolve()
      })

      expect(onPipelineChange).not.toHaveBeenCalled()
      expect(pipeline.uploadImage).not.toHaveBeenCalled()
      expect(pipeline.render).not.toHaveBeenCalled()
      expect(onStatsUpdate).not.toHaveBeenCalled()
      expect(screen.queryByText('Preview unavailable')).toBeNull()

      unmount()
      expect(pipeline.dispose).toHaveBeenCalledOnce()
      expect(pipeline.disposeMock).toHaveBeenCalledExactlyOnceWith({
        releaseContext: true,
      })
      expect(pipelineMock.instances).toHaveLength(1)
    },
  )

  it('never publishes or draws a pipeline suspended while it initializes, and builds anew on resume', async () => {
    const initialize = deferred<void>()
    pipelineMock.initialize.mockReturnValueOnce(initialize.promise)
    const onPipelineChange = vi.fn()
    const onStatsUpdate = vi.fn()
    const props = {
      imageRef: { current: decodedImage },
      imageVersion: 1,
      decodedFrame: testFrame(1),
      color: defaultColor,
      viewMode: 'processed' as const,
      lutDataRef: { current: null },
      lutDataVersion: 0,
      onPipelineChange,
      onStatsUpdate,
    } satisfies ComponentProps<typeof PreviewCanvas>
    const { rerender } = render(createElement(PreviewCanvas, props))
    const [pending] = pipelineMock.instances

    rerender(createElement(PreviewCanvas, { ...props, suspended: true }))
    expect(pending!.disposeMock).toHaveBeenCalledExactlyOnceWith({
      releaseContext: true,
    })
    expect(pending!.unsubscribeDisposed).toHaveBeenCalledOnce()
    expect(onPipelineChange).toHaveBeenLastCalledWith(null)

    await act(async () => {
      initialize.resolve()
      await initialize.promise
    })
    expect(onPipelineChange).not.toHaveBeenCalledWith(pending)
    expect(pending!.uploadImage).not.toHaveBeenCalled()
    expect(pending!.render).not.toHaveBeenCalled()
    expect(pipelineMock.instances).toHaveLength(1)

    await act(async () => {
      rerender(createElement(PreviewCanvas, { ...props, suspended: false }))
    })
    await waitFor(() => expect(onStatsUpdate).toHaveBeenCalledOnce())
    const resumed = pipelineMock.instances[1]!
    expect(onPipelineChange).toHaveBeenLastCalledWith(resumed)
    expect(resumed.render).toHaveBeenCalledOnce()
    expect(pending!.dispose).toHaveBeenCalledOnce()
  })

  it('forgets an externally disposed pipeline once without replacing its dispose', async () => {
    const resizeCallbacks: ResizeObserverCallback[] = []
    vi.stubGlobal(
      'ResizeObserver',
      vi.fn().mockImplementation((callback: ResizeObserverCallback) => ({
        observe: vi.fn(() => {
          resizeCallbacks.push(callback)
        }),
        disconnect: vi.fn(),
      })),
    )
    const onPipelineChange = vi.fn()
    const props = {
      imageRef: { current: { ...decodedImage, source: 'quick' as const } },
      imageVersion: 1,
      decodedFrame: testFrame(1),
      color: defaultColor,
      viewMode: 'processed' as const,
      lutDataRef: { current: null },
      lutDataVersion: 0,
      embeddedPreviewUrl: 'blob:embedded-preview',
      displaySource: 'quick' as const,
      onPipelineChange,
    } satisfies ComponentProps<typeof PreviewCanvas>
    const { container, rerender, unmount } = render(
      createElement(PreviewCanvas, props),
    )
    const handoffPreview = () =>
      container.querySelector('[data-raw-preview-handoff-preview]')

    const [pipeline] = pipelineMock.instances
    await waitFor(() => {
      expect(onPipelineChange).toHaveBeenLastCalledWith(pipeline)
      expect(pipeline!.render).toHaveBeenCalled()
      expect(resizeCallbacks).toHaveLength(1)
    })
    act(() => {
      resizeCallbacks[0]?.(
        [
          {
            contentRect: elementRect({ width: 400, height: 300 }),
          } as ResizeObserverEntry,
        ],
        {} as ResizeObserver,
      )
    })
    await waitFor(() => expect(handoffPreview()).toBeNull())
    expect(pipeline!.dispose).toBe(pipeline!.facadeDispose)
    expect(pipeline!.onDisposed).toHaveBeenCalledOnce()

    // Export memory evacuation disposes the published pipeline directly.
    act(() => {
      pipeline!.dispose({ releaseContext: true })
    })

    const nullPublications = () =>
      onPipelineChange.mock.calls.filter(([value]) => value === null).length
    expect(onPipelineChange).toHaveBeenLastCalledWith(null)
    expect(nullPublications()).toBe(1)
    expect(handoffPreview()).toHaveAttribute('src', 'blob:embedded-preview')
    expect(pipeline!.disposeMock).toHaveBeenCalledExactlyOnceWith({
      releaseContext: true,
    })

    act(() => {
      pipeline!.dispose({ releaseContext: true })
    })
    const renders = pipeline!.render.mock.calls.length
    await act(async () => {
      rerender(
        createElement(PreviewCanvas, {
          ...props,
          color: { ...defaultColor, userExposureEv: 0.5 },
          viewMode: 'processed' as const,
        }),
      )
    })

    expect(nullPublications()).toBe(1)
    expect(pipeline!.render).toHaveBeenCalledTimes(renders)
    expect(pipeline!.disposeMock).toHaveBeenCalledOnce()
    expect(pipelineMock.instances).toHaveLength(1)

    unmount()
    expect(pipeline!.dispose).toHaveBeenCalledTimes(2)
    expect(pipeline!.disposeMock).toHaveBeenCalledOnce()
    expect(pipeline!.unsubscribeDisposed).toHaveBeenCalledOnce()
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

    expect(firstPipeline.disposeMock).toHaveBeenCalledExactlyOnceWith({
      releaseContext: true,
    })
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
      firstPipeline.dispose({ releaseContext: true })
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
        expect.objectContaining({
          viewMode: 'processed',
        }),
      )
    })
    expect(getPipelineParamCalls()).not.toContainEqual(
      expect.objectContaining({ viewMode: 'compare' }),
    )
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

  it('keeps the embedded preview visible while the quick decoded frame catches up', async () => {
    const resizeCallbacks: ResizeObserverCallback[] = []
    vi.stubGlobal(
      'ResizeObserver',
      vi.fn().mockImplementation((callback: ResizeObserverCallback) => ({
        observe: vi.fn(() => {
          resizeCallbacks.push(callback)
        }),
        disconnect: vi.fn(),
      })),
    )

    const { container } = render(
      createElement(PreviewCanvas, {
        imageRef: { current: { ...decodedImage, source: 'quick' } },
        imageVersion: 1,
        decodedFrame: testFrame(1),
        color: defaultColor,
        viewMode: 'processed' as const,
        lutDataRef: { current: null },
        lutDataVersion: 0,
        embeddedPreviewUrl: 'blob:embedded-preview',
        displaySource: 'quick',
      }),
    )

    expect(
      container.querySelector('[data-raw-preview-handoff-preview]'),
    ).toHaveAttribute('src', 'blob:embedded-preview')

    await waitFor(() => {
      expect(pipelineMock.instances[0]?.render).toHaveBeenCalled()
      expect(resizeCallbacks).toHaveLength(1)
    })

    act(() => {
      resizeCallbacks[0]?.(
        [
          {
            contentRect: elementRect({ width: 400, height: 300 }),
          } as ResizeObserverEntry,
        ],
        {} as ResizeObserver,
      )
    })

    await waitFor(() => {
      expect(
        container.querySelector('[data-raw-preview-handoff-preview]'),
      ).toBeNull()
    })
  })

  it('keeps the preview track visible during embedded-to-quick handoff', async () => {
    const resizeCallbacks: ResizeObserverCallback[] = []
    vi.stubGlobal(
      'ResizeObserver',
      vi.fn().mockImplementation((callback: ResizeObserverCallback) => ({
        observe: vi.fn(() => {
          resizeCallbacks.push(callback)
        }),
        disconnect: vi.fn(),
      })),
    )

    const imageRef: RefObject<DecodedImage | null> = {
      current: null,
    }
    const props: ComponentProps<typeof PreviewCanvas> = {
      imageRef,
      imageVersion: 0,
      decodedFrame: testFrame(0),
      color: defaultColor,
      viewMode: 'processed' as const,
      lutDataRef: { current: null },
      lutDataVersion: 0,
      embeddedPreviewUrl: 'blob:embedded-preview',
      displaySource: 'embedded',
    }
    const { container, rerender } = render(createElement(PreviewCanvas, props))

    await waitFor(() => {
      expect(resizeCallbacks).toHaveLength(1)
    })

    act(() => {
      resizeCallbacks[0]?.(
        [
          {
            contentRect: elementRect({ width: 400, height: 300 }),
          } as ResizeObserverEntry,
        ],
        {} as ResizeObserver,
      )
    })

    await waitFor(() => {
      expect(
        container.querySelector('[data-raw-compare-track="image"]'),
      ).toHaveAttribute('data-preview-track-ready', 'true')
    })

    imageRef.current = { ...decodedImage, source: 'quick' as const }
    rerender(
      createElement(PreviewCanvas, {
        ...props,
        imageVersion: 1,
        decodedFrame: testFrame(1),
        displaySource: 'quick',
      }),
    )

    expect(
      container.querySelector('[data-raw-compare-track="image"]'),
    ).toHaveAttribute('data-preview-track-ready', 'true')
    await act(async () => {
      await Promise.resolve()
    })
  })

  it('keeps the quick preview canvas visible while bounded-HQ catches up', async () => {
    const resizeCallbacks: ResizeObserverCallback[] = []
    vi.stubGlobal(
      'ResizeObserver',
      vi.fn().mockImplementation((callback: ResizeObserverCallback) => ({
        observe: vi.fn(() => {
          resizeCallbacks.push(callback)
        }),
        disconnect: vi.fn(),
      })),
    )

    const imageRef: RefObject<DecodedImage | null> = {
      current: { ...decodedImage, source: 'quick' as const },
    }
    const props: ComponentProps<typeof PreviewCanvas> = {
      imageRef,
      imageVersion: 1,
      decodedFrame: quickTestFrame,
      color: defaultColor,
      viewMode: 'processed' as const,
      lutDataRef: { current: null },
      lutDataVersion: 0,
      displaySource: 'quick',
    }
    const { container, rerender } = render(createElement(PreviewCanvas, props))

    await waitFor(() => {
      expect(pipelineMock.instances[0]?.render).toHaveBeenCalled()
      expect(resizeCallbacks).toHaveLength(1)
    })

    act(() => {
      resizeCallbacks[0]?.(
        [
          {
            contentRect: elementRect({ width: 400, height: 300 }),
          } as ResizeObserverEntry,
        ],
        {} as ResizeObserver,
      )
    })

    await waitFor(() => {
      expect(
        container.querySelector('[data-raw-compare-track="image"]'),
      ).toHaveAttribute('data-preview-track-ready', 'true')
    })

    imageRef.current = {
      ...decodedImage,
      source: 'bounded-hq',
      width: 1600,
      height: 1200,
      data: new Uint16Array(1600 * 1200 * 3),
    }
    rerender(
      createElement(PreviewCanvas, {
        ...props,
        imageVersion: 2,
        decodedFrame: boundedHqTestFrame,
        displaySource: 'bounded-hq',
      }),
    )

    expect(
      container.querySelector('[data-raw-compare-track="image"]'),
    ).toHaveAttribute('data-preview-track-ready', 'true')
    await act(async () => {
      await Promise.resolve()
    })
  })

  it('promotes bounded-HQ dual-gpu compare after the processed layer uploads the same generation', async () => {
    const imageRef: RefObject<DecodedImage | null> = {
      current: { ...decodedImage, source: 'quick' as const },
    }
    const props: ComponentProps<typeof PreviewCanvas> = {
      imageRef,
      imageVersion: 1,
      decodedFrame: quickTestFrame,
      color: defaultColor,
      viewMode: 'compare',
      lutDataRef: { current: null },
      lutDataVersion: 0,
      displaySource: 'quick',
      dualGpuAllowed: true,
    }
    const { container, rerender } = render(createElement(PreviewCanvas, props))

    await waitFor(() => {
      expect(
        container.querySelector('[data-compare-mode="dual-gpu"]'),
      ).toBeTruthy()
    })
    pipelineMock.renderEvents.length = 0
    pipelineMock.pipelineEvents.length = 0

    imageRef.current = {
      ...decodedImage,
      source: 'bounded-hq',
      width: 420,
      height: 320,
      data: new Uint16Array(420 * 320 * 3),
    }
    rerender(
      createElement(PreviewCanvas, {
        ...props,
        imageVersion: 2,
        decodedFrame: boundedHqTestFrame,
        displaySource: 'bounded-hq',
      }),
    )

    await waitFor(() => {
      expect(pipelineMock.renderEvents.length).toBeGreaterThanOrEqual(2)
    })

    expect(
      pipelineMock.renderEvents.slice(0, 2).map((event) => event.kind),
    ).toEqual(['original', 'processed'])
    const processedUploadIndex = pipelineMock.pipelineEvents.findIndex(
      (event) =>
        event.kind === 'processed' &&
        event.op === 'upload' &&
        event.width === 420 &&
        event.height === 320,
    )
    const processedRenderIndex = pipelineMock.pipelineEvents.findIndex(
      (event) =>
        event.kind === 'processed' &&
        event.op === 'render' &&
        event.width === 420 &&
        event.height === 320,
    )
    expect(processedUploadIndex).toBeGreaterThanOrEqual(0)
    expect(processedRenderIndex).toBeGreaterThan(processedUploadIndex)
    expect(
      container.querySelector('[data-compare-mode="dual-gpu"]'),
    ).toBeTruthy()
    await act(async () => {
      await Promise.resolve()
    })
    // Each layer uploads and draws the new generation once: the processed
    // draw waits for the retained-compare delay to lift.
    const counts = (kind: 'original' | 'processed', op: 'upload' | 'render') =>
      pipelineMock.pipelineEvents.filter(
        (event) => event.kind === kind && event.op === op,
      ).length
    expect(counts('original', 'upload')).toBe(1)
    expect(counts('original', 'render')).toBe(1)
    expect(counts('processed', 'upload')).toBe(1)
    expect(counts('processed', 'render')).toBe(1)
  })

  it('draws the promoted bounded-HQ frame once when the observer reports the unchanged box on rebuild', async () => {
    // Browsers deliver an initial notification whenever observe() starts on a
    // non-zero box, so this stub reports the same frame box on every observe.
    const frameObservers: ResizeObserverCallback[] = []
    vi.stubGlobal(
      'ResizeObserver',
      vi.fn().mockImplementation((callback: ResizeObserverCallback) => ({
        observe: vi.fn((target: Element) => {
          if (target.hasAttribute('data-raw-preview-frame')) {
            frameObservers.push(callback)
          }
          fireResize(callback, 800, 600)
        }),
        disconnect: vi.fn(),
      })),
    )
    const imageRef: RefObject<DecodedImage | null> = {
      current: { ...decodedImage, source: 'quick' as const },
    }
    const props: ComponentProps<typeof PreviewCanvas> = {
      imageRef,
      imageVersion: 1,
      decodedFrame: quickTestFrame,
      color: defaultColor,
      viewMode: 'compare',
      lutDataRef: { current: null },
      lutDataVersion: 0,
      displaySource: 'quick',
      dualGpuAllowed: true,
    }
    const { container, rerender } = render(createElement(PreviewCanvas, props))

    await waitFor(() => {
      expect(
        container.querySelector('[data-compare-mode="dual-gpu"]'),
      ).toBeTruthy()
    })
    await act(async () => {
      await Promise.resolve()
    })
    pipelineMock.renderEvents.length = 0
    pipelineMock.pipelineEvents.length = 0

    // The bounded-HQ frame keeps the photo aspect ratio and the frame box, so
    // nothing about the backing store changes across the promotion.
    imageRef.current = {
      ...decodedImage,
      source: 'bounded-hq',
      width: 800,
      height: 600,
      data: new Uint16Array(800 * 600 * 3),
    }
    rerender(
      createElement(PreviewCanvas, {
        ...props,
        imageVersion: 2,
        decodedFrame: frameDescriptor({
          frameId: 'decoded-frame-2',
          stage: 'bounded-hq',
          width: 800,
          height: 600,
          quickPredecessorFrameId: 'decoded-frame-1',
        }),
        displaySource: 'bounded-hq',
      }),
    )

    await waitFor(() => {
      expect(
        pipelineMock.pipelineEvents.some(
          (event) => event.kind === 'processed' && event.op === 'render',
        ),
      ).toBe(true)
    })
    await act(async () => {
      await Promise.resolve()
    })

    const processedRenders = pipelineMock.pipelineEvents.filter(
      (event) => event.kind === 'processed' && event.op === 'render',
    )
    expect(processedRenders).toEqual([
      { kind: 'processed', op: 'render', width: 800, height: 600 },
    ])
    expect(
      container.querySelector('[data-compare-mode="dual-gpu"]'),
    ).toBeTruthy()

    // A real frame resize still resizes the backing store and redraws once,
    // after it settles.
    const processedCanvas = container.querySelector<HTMLCanvasElement>(
      'canvas.raw-preview-canvas',
    )
    const processedPipeline = processedPipelines().at(-1)
    processedPipeline?.resize.mockClear()
    pipelineMock.pipelineEvents.length = 0
    await act(async () => {
      fireResize(frameObservers.at(-1), 600, 450)
      await new Promise((resolve) =>
        window.setTimeout(resolve, BACKING_STORE_SETTLE_MS + 10),
      )
    })
    expect(processedPipeline?.resize).toHaveBeenCalledTimes(1)
    expect(processedPipeline?.resize).toHaveBeenCalledWith(
      processedCanvas?.width,
      processedCanvas?.height,
    )
    expect(
      pipelineMock.pipelineEvents.filter(
        (event) => event.kind === 'processed' && event.op === 'render',
      ),
    ).toHaveLength(1)
  })

  it('draws the promoted bounded-HQ frame once when the box was fitted before the pipeline initialized', async () => {
    const observers = queueFrameResizeObservers()
    const processedInitialize = deferred<void>()
    pipelineMock.initialize.mockImplementation((canvas: HTMLCanvasElement) =>
      canvas.className.includes('raw-preview-original-gpu-canvas')
        ? Promise.resolve()
        : processedInitialize.promise,
    )
    const imageRef: RefObject<DecodedImage | null> = {
      current: { ...decodedImage, source: 'quick' as const },
    }
    const props: ComponentProps<typeof PreviewCanvas> = {
      imageRef,
      imageVersion: 1,
      decodedFrame: quickTestFrame,
      color: defaultColor,
      viewMode: 'compare',
      lutDataRef: { current: null },
      lutDataVersion: 0,
      displaySource: 'quick',
      dualGpuAllowed: true,
    }
    const { container, rerender } = render(createElement(PreviewCanvas, props))
    const processedCanvas = container.querySelector<HTMLCanvasElement>(
      'canvas.raw-preview-canvas',
    )

    // The frame box is measured and applied before the processed pipeline
    // exists; the pipeline then draws the quick frame on that backing store.
    expect(processedPipelines()).toHaveLength(1)
    act(() => {
      expect(observers.deliverPending(800, 600)).toBe(1)
    })
    expect(processedCanvas?.width).toBe(800)
    expect(processedCanvas?.height).toBe(600)
    await act(async () => {
      processedInitialize.resolve()
      await processedInitialize.promise
    })
    await waitFor(() => {
      expect(
        container.querySelector('[data-compare-mode="dual-gpu"]'),
      ).toBeTruthy()
    })
    await act(async () => {
      await Promise.resolve()
    })
    const processedPipeline = processedPipelines()[0]!
    processedPipeline.resize.mockClear()
    pipelineMock.pipelineEvents.length = 0

    // The promotion keeps the aspect ratio and the frame box. The original
    // layer's ready report lifts the delay and the processed surface draws
    // before the rebuilt observer's notification arrives.
    imageRef.current = {
      ...decodedImage,
      source: 'bounded-hq',
      width: 800,
      height: 600,
      data: new Uint16Array(800 * 600 * 3),
    }
    rerender(
      createElement(PreviewCanvas, {
        ...props,
        imageVersion: 2,
        decodedFrame: frameDescriptor({
          frameId: 'decoded-frame-2',
          stage: 'bounded-hq',
          width: 800,
          height: 600,
          quickPredecessorFrameId: 'decoded-frame-1',
        }),
        displaySource: 'bounded-hq',
      }),
    )
    await waitFor(() => {
      expect(
        pipelineMock.pipelineEvents.filter(
          (event) => event.kind === 'processed' && event.op === 'render',
        ),
      ).toHaveLength(1)
    })

    act(() => {
      expect(observers.deliverPending(800, 600)).toBeGreaterThan(0)
    })
    await act(async () => {
      await Promise.resolve()
    })

    expect(
      pipelineMock.pipelineEvents.filter(
        (event) => event.kind === 'processed' && event.op === 'render',
      ),
    ).toEqual([{ kind: 'processed', op: 'render', width: 800, height: 600 }])
    expect(processedPipeline.resize).not.toHaveBeenCalled()
    expect(
      container.querySelector('[data-compare-mode="dual-gpu"]'),
    ).toBeTruthy()
  })

  it('keeps retained dual-gpu compare visible while bounded-HQ layers catch up', async () => {
    const imageRef: RefObject<DecodedImage | null> = {
      current: { ...decodedImage, source: 'quick' as const },
    }
    const onCompareRenderModeChange = vi.fn()
    const props: ComponentProps<typeof PreviewCanvas> = {
      imageRef,
      imageVersion: 1,
      decodedFrame: quickTestFrame,
      color: defaultColor,
      viewMode: 'compare',
      lutDataRef: { current: null },
      lutDataVersion: 0,
      displaySource: 'quick',
      dualGpuAllowed: true,
      onCompareRenderModeChange,
    }
    const { container, rerender } = render(createElement(PreviewCanvas, props))

    await waitFor(() => {
      expect(
        container.querySelector('[data-compare-mode="dual-gpu"]'),
      ).toBeTruthy()
    })
    onCompareRenderModeChange.mockClear()

    imageRef.current = {
      ...decodedImage,
      source: 'bounded-hq',
      width: 420,
      height: 320,
      data: new Uint16Array(420 * 320 * 3),
    }
    rerender(
      createElement(PreviewCanvas, {
        ...props,
        imageVersion: 2,
        decodedFrame: boundedHqTestFrame,
        displaySource: 'bounded-hq',
      }),
    )

    expect(
      container.querySelector('[data-compare-mode="dual-gpu"]'),
    ).toBeTruthy()
    expect(onCompareRenderModeChange).not.toHaveBeenCalledWith('processed-only')
    await act(async () => {
      await Promise.resolve()
    })
  })

  it('keeps dual-gpu compare ready after the preview image version changes', async () => {
    const imageRef = { current: decodedImage }
    const props: ComponentProps<typeof PreviewCanvas> = {
      imageRef,
      imageVersion: 1,
      decodedFrame: testFrame(1),
      color: defaultColor,
      viewMode: 'compare',
      lutDataRef: { current: null },
      lutDataVersion: 0,
      dualGpuAllowed: true,
    }
    const { container, rerender } = render(createElement(PreviewCanvas, props))

    await waitFor(() => {
      expect(
        container.querySelector('[data-compare-mode="dual-gpu"]'),
      ).toBeTruthy()
    })

    imageRef.current = {
      ...decodedImage,
      width: 420,
      height: 320,
      data: new Uint16Array(420 * 320 * 3),
    }
    rerender(
      createElement(PreviewCanvas, {
        ...props,
        imageVersion: 2,
        decodedFrame: testFrame(2),
      }),
    )

    await waitFor(() => {
      const originalPipeline = pipelineMock.instances.find((instance) => {
        return instance.uploadImage.mock.calls.some(([input]) => {
          return input?.width === 420 && input?.height === 320
        })
      })

      expect(originalPipeline?.render).toHaveBeenCalled()
    })
    await act(async () => {
      await Promise.resolve()
    })

    expect(
      container.querySelector('[data-compare-mode="dual-gpu"]'),
    ).toBeTruthy()
    expect(
      container.querySelector('.raw-preview-original-gpu-shell'),
    ).toHaveClass('raw-preview-layer-clipped')
  })

  it('requests jpeg fallback when the original GPU layer fails', async () => {
    const requestOriginalReferenceFallback = vi.fn()
    pipelineMock.initialize.mockImplementation((canvas: HTMLCanvasElement) => {
      if (canvas.className.includes('raw-preview-original-gpu-canvas')) {
        return Promise.reject(new Error('Original layer failed'))
      }

      return Promise.resolve()
    })

    render(
      createElement(PreviewCanvas, {
        imageRef: { current: decodedImage },
        imageVersion: 1,
        decodedFrame: testFrame(1),
        color: defaultColor,
        viewMode: 'compare',
        lutDataRef: { current: null },
        lutDataVersion: 0,
        dualGpuAllowed: true,
        onRequestOriginalReferenceFallback: requestOriginalReferenceFallback,
      }),
    )

    await waitFor(() => {
      expect(requestOriginalReferenceFallback).toHaveBeenCalledTimes(1)
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
        expect.objectContaining({
          viewMode: 'processed',
        }),
      )
    })
    expect(getPipelineParamCalls()).not.toContainEqual(
      expect.objectContaining({ viewMode: 'compare' }),
    )
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

  it('declares prefixed clip-path rules for prefixed WebKit layered compare', () => {
    expect(previewCanvasCss).toContain(
      '-webkit-clip-path: inset(0 calc(100% - var(--raw-compare-split, 50%)) 0 0);',
    )
    expect(previewCanvasCss).toContain(
      '-webkit-clip-path: inset(0 0 0 var(--raw-compare-split, 50%));',
    )
  })

  it('zooms the preview around the wheel pointer without mutating processing params', async () => {
    const paramsBefore = { ...defaultParams }
    const { frame, onPreviewViewportChange } = renderInteractivePreview()

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
    fireEvent.wheel(frame!, {
      clientX: 300,
      clientY: 150,
      deltaY: -150,
      deltaMode: 0,
      ctrlKey: false,
    })

    expect(onPreviewViewportChange).not.toHaveBeenCalled()
    rafCallbacks[0]?.(performance.now())

    expect(onPreviewViewportChange).toHaveBeenCalledTimes(1)
    const next = onPreviewViewportChange.mock.calls[0]?.[0]
    expect(next?.zoom).toBeCloseTo(1.5)
    expect(next?.panX).toBeCloseTo(-50)
    expect(next?.panY).toBeCloseTo(0)
    expect(next?.fitMode).toBe('custom')
    expect(defaultParams).toEqual(paramsBefore)

    raf.mockRestore()
  })

  it('keeps preview track as the split anchor while the surface fills surrounding frame space', async () => {
    const { frame, surface, track } = renderInteractivePreview({
      previewViewport: {
        zoom: 2,
        panX: 80,
        panY: -40,
        fitMode: 'custom',
      },
    })

    await waitFor(() => {
      expect(pipelineMock.instances).toHaveLength(1)
    })

    expect(track).not.toBeNull()
    expect(surface).not.toBeNull()
    expect(track).not.toBe(surface)
    expect(track?.style.getPropertyValue('--raw-preview-zoom')).toBe('2')
    expect(track?.style.getPropertyValue('--raw-preview-pan-x')).toBe('80px')
    expect(track?.style.getPropertyValue('--raw-preview-pan-y')).toBe('-40px')
    expect(surface?.style.getPropertyValue('--raw-preview-zoom')).toBe('')
    expect(getComputedStyle(track!).transform).toBe('')
    expect(getComputedStyle(surface!).transform).toContain('translate3d')
    expect(getComputedStyle(frame!).overflow).toBe('hidden')
  })

  it('keeps layered compare clipping in layer space while zoom transforms the surface', async () => {
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
        previewViewport: {
          zoom: 2,
          panX: 80,
          panY: -40,
          fitMode: 'custom',
        },
      }),
    )

    await waitFor(() => {
      expect(
        container.querySelector('[data-compare-mode="jpeg-fallback"]'),
      ).toBeTruthy()
    })

    const surface = container.querySelector<HTMLElement>(
      '[data-raw-preview-surface]',
    )
    const processedLayer = container.querySelector<HTMLElement>(
      '.raw-preview-processed-layer',
    )
    const processedCanvas = container.querySelector<HTMLElement>(
      '.raw-preview-canvas',
    )
    const originalImage = container.querySelector<HTMLElement>(
      '.raw-preview-original-image',
    )
    const track = container.querySelector<HTMLElement>('.raw-preview-track')

    expect(track).not.toBeNull()
    expect(surface).not.toBeNull()
    expect(processedLayer).not.toBeNull()
    expect(processedCanvas).not.toBeNull()
    expect(originalImage).not.toBeNull()
    expect(getComputedStyle(track!).transform).toBe('')
    expect(getComputedStyle(surface!).transform).toContain('translate3d')
    expect(getComputedStyle(processedLayer!).clipPath).toContain(
      'var(--raw-compare-split',
    )
    expect(getComputedStyle(processedCanvas!).transform).toBe('')
    expect(getComputedStyle(originalImage!).transform).toBe('')
  })

  it('keeps the preview track hidden until aspect-fit sizing is ready', async () => {
    const { container } = render(
      createElement(PreviewCanvas, {
        imageRef: { current: decodedImage },
        imageVersion: 1,
        decodedFrame: testFrame(1),
        color: defaultColor,
        viewMode: 'processed' as const,
        lutDataRef: { current: null },
        lutDataVersion: 0,
      }),
    )

    const track = container.querySelector<HTMLElement>(
      '[data-raw-compare-track="image"]',
    )

    expect(track).toHaveAttribute('data-preview-track-ready', 'false')
    expect(previewCanvasCss).toContain(
      "[data-raw-compare-track='image'][data-preview-track-ready='false']",
    )
    await act(async () => {
      await Promise.resolve()
    })
  })

  it('scopes transform will-change to active preview panning', async () => {
    const { container, frame } = renderInteractivePreview({
      previewViewport: {
        zoom: 2,
        panX: 0,
        panY: 0,
        fitMode: 'custom',
      },
    })

    await waitFor(() => {
      expect(pipelineMock.instances).toHaveLength(1)
    })

    const surface = container.querySelector<HTMLElement>(
      '[data-raw-preview-surface]',
    )
    expect(surface).not.toBeNull()
    expect(getComputedStyle(surface!).willChange).not.toContain('transform')

    fireEvent.pointerDown(frame!, {
      pointerId: 1,
      button: 0,
      clientX: 200,
      clientY: 150,
    })

    expect(getComputedStyle(surface!).willChange).toContain('transform')
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

  it('resets preview zoom and pan on double click', async () => {
    const { frame, onPreviewViewportChange } = renderInteractivePreview({
      previewViewport: {
        zoom: 3,
        panX: 120,
        panY: -80,
        fitMode: 'custom',
      },
    })

    await waitFor(() => {
      expect(pipelineMock.instances).toHaveLength(1)
    })

    expect(frame).not.toBeNull()
    fireEvent.doubleClick(frame!)

    expect(onPreviewViewportChange).toHaveBeenCalledWith(
      DEFAULT_PREVIEW_VIEWPORT,
    )
  })

  it('pinches around the first midpoint, then pans with the pointer left behind', async () => {
    const { frame, onPreviewViewportChange } = renderInteractivePreview()
    await waitFor(() => {
      expect(pipelineMock.instances).toHaveLength(1)
    })
    const frames = captureAnimationFrames()

    try {
      fireEvent.pointerDown(frame!, {
        pointerId: 1,
        button: 0,
        clientX: 200,
        clientY: 150,
      })
      fireEvent.pointerDown(frame!, {
        pointerId: 2,
        button: 0,
        clientX: 300,
        clientY: 150,
      })
      expect(frame).toHaveClass('raw-preview-frame-panning')
      expect(frame).toHaveClass('raw-preview-frame-transforming')
      expect(HTMLElement.prototype.setPointerCapture).toHaveBeenCalledWith(1)
      expect(HTMLElement.prototype.setPointerCapture).toHaveBeenCalledWith(2)

      // Distance 100 -> 150 around the frame-relative midpoint (+50, 0).
      fireEvent.pointerMove(frame!, {
        pointerId: 2,
        clientX: 350,
        clientY: 150,
      })
      // A later move keeps the first midpoint as the zoom origin.
      fireEvent.pointerMove(frame!, {
        pointerId: 1,
        clientX: 150,
        clientY: 150,
      })
      expect(frames.request).toHaveBeenCalledTimes(1)
      expect(onPreviewViewportChange).not.toHaveBeenCalled()
      frames.run()
      expect(onPreviewViewportChange).toHaveBeenCalledTimes(1)
      const pinched = onPreviewViewportChange.mock.calls[0]?.[0]
      expect(pinched?.zoom).toBeCloseTo(2)
      expect(pinched?.panX).toBeCloseTo(-50)
      expect(pinched?.panY).toBeCloseTo(0)

      // Lifting one finger ends the pinch without committing.
      fireEvent.pointerUp(frame!, { pointerId: 2 })
      expect(HTMLElement.prototype.releasePointerCapture).toHaveBeenCalledWith(
        2,
      )
      expect(onPreviewViewportChange).toHaveBeenCalledTimes(1)
      expect(frame).toHaveClass('raw-preview-frame-panning')

      fireEvent.pointerMove(frame!, {
        pointerId: 1,
        clientX: 170,
        clientY: 160,
      })
      // Lifting the last finger flushes the pending frame synchronously.
      fireEvent.pointerUp(frame!, { pointerId: 1 })
      expect(frames.cancel).toHaveBeenCalledWith(frames.lastId())
      expect(onPreviewViewportChange).toHaveBeenCalledTimes(2)
      const panned = onPreviewViewportChange.mock.calls[1]?.[0]
      expect(panned?.zoom).toBeCloseTo(2)
      expect(panned?.panX).toBeCloseTo(-30)
      expect(panned?.panY).toBeCloseTo(10)
      expect(frame).not.toHaveClass('raw-preview-frame-panning')
      expect(frame).not.toHaveClass('raw-preview-frame-transforming')
    } finally {
      frames.restore()
    }
  })

  it('ends a cancelled pointer like a release and ignores its later moves', async () => {
    const { frame, onPreviewViewportChange } = renderInteractivePreview({
      previewViewport: { zoom: 2, panX: 0, panY: 0, fitMode: 'custom' },
    })
    await waitFor(() => {
      expect(pipelineMock.instances).toHaveLength(1)
    })
    const frames = captureAnimationFrames()

    try {
      // Only the primary button starts a gesture.
      fireEvent.pointerDown(frame!, {
        pointerId: 4,
        button: 2,
        clientX: 200,
        clientY: 150,
      })
      expect(frame).not.toHaveClass('raw-preview-frame-panning')

      fireEvent.pointerDown(frame!, {
        pointerId: 1,
        button: 0,
        clientX: 200,
        clientY: 150,
      })
      fireEvent.pointerMove(frame!, {
        pointerId: 1,
        clientX: 230,
        clientY: 140,
      })
      fireEvent.pointerCancel(frame!, { pointerId: 1 })

      expect(frames.cancel).toHaveBeenCalledWith(frames.lastId())
      expect(onPreviewViewportChange).toHaveBeenCalledTimes(1)
      expect(onPreviewViewportChange).toHaveBeenLastCalledWith({
        zoom: 2,
        panX: 30,
        panY: -10,
        fitMode: 'custom',
      })
      expect(HTMLElement.prototype.releasePointerCapture).toHaveBeenCalledWith(
        1,
      )
      expect(frame).toHaveClass('raw-preview-frame-interactive')

      fireEvent.pointerMove(frame!, {
        pointerId: 1,
        clientX: 260,
        clientY: 140,
      })
      expect(frames.request).toHaveBeenCalledTimes(1)
      expect(onPreviewViewportChange).toHaveBeenCalledTimes(1)
    } finally {
      frames.restore()
    }
  })

  it('keeps a zoomed wheel burst across a render that normalizes the same viewport', async () => {
    const onPreviewViewportChange = vi.fn()
    const props = {
      imageRef: { current: decodedImage },
      imageVersion: 1,
      decodedFrame: testFrame(1),
      color: defaultColor,
      viewMode: 'processed' as const,
      lutDataRef: { current: null },
      lutDataVersion: 0,
      previewViewport: {
        zoom: 2,
        panX: 0,
        panY: 0,
        fitMode: 'custom' as const,
      },
      onPreviewViewportChange,
    }
    const { container, rerender } = render(createElement(PreviewCanvas, props))
    await waitFor(() => {
      expect(pipelineMock.instances).toHaveLength(1)
    })
    const frame = container.querySelector<HTMLElement>(
      '[data-raw-preview-frame]',
    )!
    setElementRect(frame, { width: 400, height: 300 })
    setElementRect(
      container.querySelector<HTMLElement>('[data-raw-compare-track="image"]')!,
      { width: 400, height: 300 },
    )
    const frames = captureAnimationFrames()

    try {
      fireEvent.wheel(frame, { clientX: 200, clientY: 150, deltaY: -30 })
      rerender(createElement(PreviewCanvas, { ...props }))
      fireEvent.wheel(frame, { clientX: 200, clientY: 150, deltaY: -30 })
      frames.run()

      expect(frames.request).toHaveBeenCalledTimes(1)
      expect(onPreviewViewportChange).toHaveBeenCalledTimes(1)
      expect(onPreviewViewportChange.mock.calls[0]?.[0].zoom).toBeCloseTo(
        2 * 1.1 ** 2,
      )
    } finally {
      frames.restore()
    }
  })

  it('ends a pointer whose capture is lost without a cancel', async () => {
    const { frame, onPreviewViewportChange } = renderInteractivePreview({
      previewViewport: { zoom: 2, panX: 0, panY: 0, fitMode: 'custom' },
    })
    await waitFor(() => {
      expect(pipelineMock.instances).toHaveLength(1)
    })
    const frames = captureAnimationFrames()

    try {
      fireEvent.pointerDown(frame!, {
        pointerId: 1,
        button: 0,
        clientX: 200,
        clientY: 150,
      })
      fireEvent.pointerMove(frame!, {
        pointerId: 1,
        clientX: 230,
        clientY: 140,
      })
      fireEvent.lostPointerCapture(frame!, { pointerId: 1 })

      expect(frames.cancel).toHaveBeenCalledWith(frames.lastId())
      expect(onPreviewViewportChange).toHaveBeenCalledTimes(1)
      expect(onPreviewViewportChange).toHaveBeenLastCalledWith({
        zoom: 2,
        panX: 30,
        panY: -10,
        fitMode: 'custom',
      })
      expect(frame).not.toHaveClass('raw-preview-frame-panning')
    } finally {
      frames.restore()
    }
  })

  it('batches wheel zoom into one frame and ends the wheel transform after it idles', async () => {
    const addEventListener = vi.spyOn(HTMLElement.prototype, 'addEventListener')
    const { frame, onPreviewViewportChange } = renderInteractivePreview()
    await waitFor(() => {
      expect(pipelineMock.instances).toHaveLength(1)
    })
    expect(
      addEventListener.mock.calls.filter(
        ([type, , options]) =>
          type === 'wheel' &&
          (options as AddEventListenerOptions | undefined)?.passive === false,
      ),
    ).toHaveLength(1)
    addEventListener.mockRestore()
    const frames = captureAnimationFrames()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })

    try {
      const first = fireEvent.wheel(frame!, {
        clientX: 300,
        clientY: 150,
        deltaY: -150,
        deltaMode: 0,
        ctrlKey: false,
      })
      fireEvent.wheel(frame!, {
        clientX: 300,
        clientY: 150,
        deltaY: -150,
        deltaMode: 0,
        ctrlKey: false,
      })

      expect(first).toBe(false)
      expect(frames.request).toHaveBeenCalledTimes(1)
      expect(frame).toHaveClass('raw-preview-frame-transforming')
      frames.run()
      expect(onPreviewViewportChange).toHaveBeenCalledTimes(1)
      const next = onPreviewViewportChange.mock.calls[0]?.[0]
      expect(next?.zoom).toBeCloseTo(2.25)
      expect(next?.panX).toBeCloseTo(-125)
      expect(next?.panY).toBeCloseTo(0)

      act(() => vi.advanceTimersByTime(179))
      expect(frame).toHaveClass('raw-preview-frame-transforming')
      act(() => vi.advanceTimersByTime(1))
      expect(frame).not.toHaveClass('raw-preview-frame-transforming')
    } finally {
      vi.useRealTimers()
      frames.restore()
    }
  })

  it('leaves no gesture frame, timer, listener, or capture behind on unmount', async () => {
    const { frame, unmount, onPreviewViewportChange } =
      renderInteractivePreview({
        previewViewport: { zoom: 2, panX: 0, panY: 0, fitMode: 'custom' },
      })
    await waitFor(() => {
      expect(pipelineMock.instances).toHaveLength(1)
    })
    const frames = captureAnimationFrames()
    const removeEventListener = vi.spyOn(frame!, 'removeEventListener')
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })

    try {
      fireEvent.pointerDown(frame!, {
        pointerId: 7,
        button: 0,
        clientX: 200,
        clientY: 150,
      })
      fireEvent.pointerMove(frame!, {
        pointerId: 7,
        clientX: 210,
        clientY: 150,
      })
      fireEvent.wheel(frame!, {
        clientX: 200,
        clientY: 150,
        deltaY: -30,
        deltaMode: 0,
        ctrlKey: false,
      })
      expect(frames.request).toHaveBeenCalledTimes(1)
      expect(vi.getTimerCount()).toBe(1)

      unmount()

      expect(frames.cancel).toHaveBeenCalledWith(frames.lastId())
      expect(vi.getTimerCount()).toBe(0)
      expect(removeEventListener).toHaveBeenCalledWith(
        'wheel',
        expect.any(Function),
      )
      expect(HTMLElement.prototype.releasePointerCapture).toHaveBeenCalledWith(
        7,
      )
      expect(onPreviewViewportChange).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
      frames.restore()
    }
  })

  it('ignores gestures while preview interaction is disabled', async () => {
    const onPreviewViewportChange = vi.fn()
    const { container } = render(
      createElement(PreviewCanvas, {
        imageRef: { current: decodedImage },
        imageVersion: 1,
        decodedFrame: testFrame(1),
        color: defaultColor,
        viewMode: 'processed' as const,
        lutDataRef: { current: null },
        lutDataVersion: 0,
        interactionDisabled: true,
        previewViewport: { zoom: 2, panX: 0, panY: 0, fitMode: 'custom' },
        onPreviewViewportChange,
      }),
    )
    await waitFor(() => {
      expect(pipelineMock.instances).toHaveLength(1)
    })
    const frame = container.querySelector<HTMLElement>(
      '[data-raw-preview-frame]',
    )!
    setElementRect(frame, { width: 400, height: 300 })
    setElementRect(
      container.querySelector<HTMLElement>('[data-raw-compare-track="image"]')!,
      { width: 400, height: 300 },
    )

    const wheel = fireEvent.wheel(frame, {
      clientX: 200,
      clientY: 150,
      deltaY: -150,
    })
    fireEvent.pointerDown(frame, {
      pointerId: 1,
      button: 0,
      clientX: 200,
      clientY: 150,
    })
    fireEvent.pointerMove(frame, { pointerId: 1, clientX: 240, clientY: 150 })
    fireEvent.pointerUp(frame, { pointerId: 1 })
    fireEvent.doubleClick(frame)

    expect(wheel).toBe(true)
    expect(HTMLElement.prototype.setPointerCapture).not.toHaveBeenCalled()
    expect(frame).not.toHaveClass('raw-preview-frame-interactive')
    expect(frame).not.toHaveClass('raw-preview-frame-panning')
    expect(onPreviewViewportChange).not.toHaveBeenCalled()
  })

  it('redraws the processed surface only when the view changes its output selection', async () => {
    const onStatsUpdate = vi.fn()
    const props = {
      imageRef: { current: decodedImage },
      imageVersion: 1,
      decodedFrame: testFrame(1),
      color: defaultColor,
      viewMode: 'processed' as const,
      lutDataRef: { current: null },
      lutDataVersion: 0,
      previewViewport: DEFAULT_PREVIEW_VIEWPORT,
      onPreviewViewportChange: vi.fn(),
      onStatsUpdate,
    } satisfies ComponentProps<typeof PreviewCanvas>
    const { rerender } = render(createElement(PreviewCanvas, props))
    await waitFor(() => expect(onStatsUpdate).toHaveBeenCalledOnce())
    const pipeline = pipelineMock.instances[0]!
    pipeline.setParams.mockClear()
    pipeline.render.mockClear()
    pipeline.uploadImage.mockClear()
    pipeline.waitForGpu.mockClear()

    // Compare draws the same processed output; zoom and pan are CSS only.
    rerender(createElement(PreviewCanvas, { ...props, viewMode: 'compare' }))
    rerender(
      createElement(PreviewCanvas, {
        ...props,
        viewMode: 'compare',
        previewViewport: { zoom: 2, panX: 40, panY: 0, fitMode: 'custom' },
      }),
    )
    expect(pipeline.setParams).not.toHaveBeenCalled()
    expect(pipeline.render).not.toHaveBeenCalled()

    // The original view selects a different executor output: one redraw of
    // the technical original, reusing the image already on the GPU.
    await act(async () => {
      rerender(createElement(PreviewCanvas, { ...props, viewMode: 'original' }))
    })
    expect(pipeline.setParams).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ viewMode: 'original' }),
    )
    expect(pipeline.render).toHaveBeenCalledOnce()

    await act(async () => {
      rerender(createElement(PreviewCanvas, { ...props, viewMode: 'compare' }))
    })
    expect(pipeline.setParams).toHaveBeenCalledTimes(2)
    expect(pipeline.setParams).toHaveBeenLastCalledWith(
      expect.objectContaining({ viewMode: 'processed' }),
    )
    expect(pipeline.render).toHaveBeenCalledTimes(2)
    expect(pipeline.uploadImage).not.toHaveBeenCalled()
    expect(pipeline.waitForGpu).not.toHaveBeenCalled()
    expect(onStatsUpdate).toHaveBeenCalledTimes(3)
  })

  it('keeps both dual-gpu layers still across viewport changes and drops only the original layer outside compare', async () => {
    const props = {
      imageRef: { current: decodedImage },
      imageVersion: 1,
      decodedFrame: testFrame(1),
      color: defaultColor,
      viewMode: 'compare' as const,
      lutDataRef: { current: null },
      lutDataVersion: 0,
      dualGpuAllowed: true,
      previewViewport: DEFAULT_PREVIEW_VIEWPORT,
      onPreviewViewportChange: vi.fn(),
    } satisfies ComponentProps<typeof PreviewCanvas>
    const { container, rerender } = render(createElement(PreviewCanvas, props))
    await waitFor(() =>
      expect(
        container.querySelector('[data-compare-mode="dual-gpu"]'),
      ).toBeTruthy(),
    )
    const [processed] = processedPipelines()
    const [original] = originalPipelines()
    expect(processed!.render).toHaveBeenCalledOnce()
    expect(original!.render).toHaveBeenCalledOnce()
    processed!.render.mockClear()
    processed!.setParams.mockClear()
    original!.render.mockClear()

    rerender(
      createElement(PreviewCanvas, {
        ...props,
        previewViewport: { zoom: 2, panX: 80, panY: 0, fitMode: 'custom' },
      }),
    )
    expect(processed!.render).not.toHaveBeenCalled()
    expect(original!.render).not.toHaveBeenCalled()

    await act(async () => {
      rerender(
        createElement(PreviewCanvas, { ...props, viewMode: 'processed' }),
      )
    })
    expect(
      container.querySelector('.raw-preview-original-gpu-layer'),
    ).toBeNull()
    expect(original!.disposeMock).toHaveBeenCalledOnce()
    expect(processed!.setParams).not.toHaveBeenCalled()
    expect(processed!.render).not.toHaveBeenCalled()

    // Returning to compare builds and draws a new original layer; the
    // processed surface already shows the processed output.
    await act(async () => {
      rerender(createElement(PreviewCanvas, { ...props, viewMode: 'compare' }))
    })
    await waitFor(() =>
      expect(
        container.querySelector('[data-compare-mode="dual-gpu"]'),
      ).toBeTruthy(),
    )
    expect(originalPipelines()).toHaveLength(2)
    expect(originalPipelines()[1]!.render).toHaveBeenCalledOnce()
    expect(processed!.render).not.toHaveBeenCalled()
    expect(processed!.disposeMock).not.toHaveBeenCalled()
  })

  it('waits for a remounted original layer on the same frame to draw before claiming dual-gpu compare', async () => {
    const onOriginalPreviewPipelineChange = vi.fn()
    const props = {
      imageRef: { current: decodedImage },
      imageVersion: 1,
      decodedFrame: testFrame(1),
      color: defaultColor,
      viewMode: 'compare' as const,
      lutDataRef: { current: null },
      lutDataVersion: 0,
      dualGpuAllowed: true,
      onOriginalPreviewPipelineChange,
    } satisfies ComponentProps<typeof PreviewCanvas>
    const { container, rerender } = render(createElement(PreviewCanvas, props))
    await waitFor(() =>
      expect(
        container.querySelector('[data-compare-mode="dual-gpu"]'),
      ).toBeTruthy(),
    )
    const [processed] = processedPipelines()
    processed!.render.mockClear()

    await act(async () => {
      rerender(
        createElement(PreviewCanvas, { ...props, viewMode: 'processed' }),
      )
    })
    expect(originalPipelines()[0]!.disposeMock).toHaveBeenCalledOnce()
    expect(onOriginalPreviewPipelineChange).toHaveBeenLastCalledWith(null)

    const secondInitialize = deferred<void>()
    pipelineMock.initialize.mockImplementation((canvas: HTMLCanvasElement) =>
      canvas.className.includes('raw-preview-original-gpu-canvas')
        ? secondInitialize.promise
        : Promise.resolve(),
    )
    await act(async () => {
      rerender(createElement(PreviewCanvas, { ...props, viewMode: 'compare' }))
    })
    expect(originalPipelines()).toHaveLength(2)
    // The released layer's frame does not stand in for the new pipeline.
    expect(
      container.querySelector('[data-compare-mode="processed-only"]'),
    ).toBeTruthy()
    expect(originalPipelines()[1]!.render).not.toHaveBeenCalled()

    await act(async () => {
      secondInitialize.resolve()
      await secondInitialize.promise
    })
    await waitFor(() =>
      expect(
        container.querySelector('[data-compare-mode="dual-gpu"]'),
      ).toBeTruthy(),
    )
    expect(originalPipelines()[1]!.render).toHaveBeenCalledOnce()
    expect(onOriginalPreviewPipelineChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ dispose: expect.any(Function) }),
    )
    expect(processed!.render).not.toHaveBeenCalled()
  })

  it('uploads, draws, and fences a bounded-HQ frame once outside compare', async () => {
    const onStatsUpdate = vi.fn()
    const imageRef: RefObject<DecodedImage | null> = {
      current: { ...decodedImage, source: 'quick' as const },
    }
    const props: ComponentProps<typeof PreviewCanvas> = {
      imageRef,
      imageVersion: 1,
      decodedFrame: testFrame(1),
      color: defaultColor,
      viewMode: 'processed',
      lutDataRef: { current: null },
      lutDataVersion: 0,
      displaySource: 'quick',
      onStatsUpdate,
    }
    const { rerender } = render(createElement(PreviewCanvas, props))
    await waitFor(() => expect(onStatsUpdate).toHaveBeenCalledOnce())
    const pipeline = pipelineMock.instances[0]!
    pipeline.uploadImage.mockClear()
    pipeline.render.mockClear()
    pipeline.waitForGpu.mockClear()

    imageRef.current = {
      ...decodedImage,
      source: 'bounded-hq',
      width: 1600,
      height: 1200,
      data: new Uint16Array(1600 * 1200 * 3),
    }
    await act(async () => {
      rerender(
        createElement(PreviewCanvas, {
          ...props,
          imageVersion: 2,
          decodedFrame: testFrame(2),
          displaySource: 'bounded-hq',
        }),
      )
    })

    expect(pipeline.uploadImage).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ width: 1600, height: 1200 }),
    )
    expect(pipeline.render).toHaveBeenCalledOnce()
    expect(pipeline.waitForGpu).toHaveBeenCalledOnce()
    expect(onStatsUpdate).toHaveBeenCalledTimes(2)
    expect(pipelineMock.instances).toHaveLength(1)
  })

  it('draws the latest image and color once a late initialization completes', async () => {
    const initialize = deferred<void>()
    pipelineMock.initialize.mockReturnValueOnce(initialize.promise)
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
    imageRef.current = { ...decodedImage, width: 420, height: 320 }
    rerender(
      createElement(PreviewCanvas, {
        ...props,
        imageVersion: 2,
        decodedFrame: testFrame(2),
        color: { ...defaultColor, userExposureEv: 0.5 },
      }),
    )
    const pipeline = pipelineMock.instances[0]!
    expect(pipeline.uploadImage).not.toHaveBeenCalled()
    expect(pipeline.render).not.toHaveBeenCalled()

    await act(async () => initialize.resolve())

    await waitFor(() => expect(onStatsUpdate).toHaveBeenCalledOnce())
    expect(pipeline.uploadImage).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ width: 420, height: 320 }),
    )
    expect(pipeline.setParams).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ userExposureEv: 0.5 }),
    )
    expect(pipeline.render).toHaveBeenCalledOnce()
    expect(pipeline.waitForGpu).toHaveBeenCalledOnce()
  })

  it('reuploads and redraws once on resume while the suspended pipeline stays still', async () => {
    const onStatsUpdate = vi.fn()
    const props = {
      imageRef: { current: decodedImage },
      imageVersion: 1,
      decodedFrame: testFrame(1),
      color: defaultColor,
      viewMode: 'processed' as const,
      lutDataRef: { current: null },
      lutDataVersion: 0,
      onStatsUpdate,
    }
    const { rerender } = render(createElement(PreviewCanvas, props))
    await waitFor(() => expect(onStatsUpdate).toHaveBeenCalledOnce())
    const suspendedPipeline = pipelineMock.instances[0]!

    rerender(createElement(PreviewCanvas, { ...props, suspended: true }))
    rerender(
      createElement(PreviewCanvas, {
        ...props,
        suspended: true,
        color: { ...defaultColor, userExposureEv: 0.5 },
      }),
    )
    expect(suspendedPipeline.render).toHaveBeenCalledOnce()
    expect(pipelineMock.instances).toHaveLength(1)

    await act(async () => {
      rerender(
        createElement(PreviewCanvas, {
          ...props,
          color: { ...defaultColor, userExposureEv: 0.5 },
        }),
      )
    })
    await waitFor(() => expect(onStatsUpdate).toHaveBeenCalledTimes(2))
    const resumedPipeline = pipelineMock.instances[1]!
    expect(resumedPipeline.uploadImage).toHaveBeenCalledOnce()
    expect(resumedPipeline.setParams).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ userExposureEv: 0.5 }),
    )
    expect(resumedPipeline.render).toHaveBeenCalledOnce()
    // A new pipeline proves its first frame on the GPU again.
    expect(resumedPipeline.waitForGpu).toHaveBeenCalledOnce()
    expect(suspendedPipeline.render).toHaveBeenCalledOnce()
  })

  it('never marks a frame ready from GPU work that outlives an external disposal', async () => {
    const completed = deferred<void>()
    pipelineMock.waitForGpu.mockReturnValue(completed.promise)
    const resizeCallbacks = captureResizeObservers()
    const onStatsUpdate = vi.fn()
    const { container } = render(
      createElement(PreviewCanvas, {
        imageRef: { current: { ...decodedImage, source: 'quick' as const } },
        imageVersion: 1,
        decodedFrame: testFrame(1),
        color: defaultColor,
        viewMode: 'processed' as const,
        lutDataRef: { current: null },
        lutDataVersion: 0,
        embeddedPreviewUrl: 'blob:embedded-preview',
        displaySource: 'quick',
        onStatsUpdate,
      }),
    )
    await waitFor(() => expect(pipelineMock.waitForGpu).toHaveBeenCalled())
    act(() => fireResize(resizeCallbacks[0], 400, 300))

    const pipeline = pipelineMock.instances[0]!
    act(() => {
      pipeline.dispose({ releaseContext: true })
    })
    await act(async () => completed.resolve())

    expect(onStatsUpdate).not.toHaveBeenCalled()
    expect(
      container.querySelector('[data-raw-preview-handoff-preview]'),
    ).toHaveAttribute('src', 'blob:embedded-preview')
    expect(screen.queryByText('Preview unavailable')).toBeNull()
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

  it('reports a failed current draw without announcing its frame', async () => {
    const resizeCallbacks = captureResizeObservers()
    const onStatsUpdate = vi.fn()
    pipelineMock.initialize.mockImplementationOnce(
      (canvas: HTMLCanvasElement) => {
        const instance = pipelineMock.instances.find(
          (candidate) => candidate.canvas === canvas,
        )
        instance?.render.mockImplementationOnce(() => {
          throw new Error('Device lost while drawing')
        })
        return Promise.resolve()
      },
    )
    const { container } = render(
      createElement(PreviewCanvas, {
        imageRef: { current: { ...decodedImage, source: 'quick' as const } },
        imageVersion: 1,
        decodedFrame: testFrame(1),
        color: defaultColor,
        viewMode: 'processed' as const,
        lutDataRef: { current: null },
        lutDataVersion: 0,
        embeddedPreviewUrl: 'blob:embedded-preview',
        displaySource: 'quick',
        onStatsUpdate,
      }),
    )
    act(() => fireResize(resizeCallbacks[0], 400, 300))

    await waitFor(() =>
      expect(screen.getByText('Device lost while drawing')).toBeTruthy(),
    )
    const pipeline = pipelineMock.instances[0]!
    expect(pipeline.render).toHaveBeenCalled()
    expect(pipeline.waitForGpu).not.toHaveBeenCalled()
    expect(onStatsUpdate).not.toHaveBeenCalled()
    expect(
      container.querySelector('[data-raw-preview-handoff-preview]'),
    ).toHaveAttribute('src', 'blob:embedded-preview')
    expect(pipeline.disposeMock).not.toHaveBeenCalled()
  })

  it('takes down the draw error overlay once a later current draw succeeds', async () => {
    const onStatsUpdate = vi.fn()
    pipelineMock.initialize.mockImplementationOnce(
      (canvas: HTMLCanvasElement) => {
        const instance = pipelineMock.instances.find(
          (candidate) => candidate.canvas === canvas,
        )
        instance?.render.mockImplementationOnce(() => {
          throw new Error('Device lost while drawing')
        })
        return Promise.resolve()
      },
    )
    const props = {
      imageRef: { current: decodedImage },
      imageVersion: 1,
      decodedFrame: testFrame(1),
      color: defaultColor,
      viewMode: 'processed' as const,
      lutDataRef: { current: null },
      lutDataVersion: 0,
      onStatsUpdate,
    } satisfies ComponentProps<typeof PreviewCanvas>
    const { rerender } = render(createElement(PreviewCanvas, props))
    await waitFor(() =>
      expect(screen.getByText('Device lost while drawing')).toBeTruthy(),
    )

    await act(async () => {
      rerender(
        createElement(PreviewCanvas, {
          ...props,
          color: { ...defaultColor, userExposureEv: 0.4 },
        }),
      )
    })
    await waitFor(() => expect(onStatsUpdate).toHaveBeenCalledOnce())
    expect(screen.queryByText('Device lost while drawing')).toBeNull()
    expect(pipelineMock.instances[0]!.uploadImage).toHaveBeenCalledOnce()
  })

  it('withholds readiness from in-flight frames once the selected LUT fails to upload', async () => {
    const firstFrame = deferred<void>()
    pipelineMock.waitForGpu.mockReturnValue(firstFrame.promise)
    const resizeCallbacks = captureResizeObservers()
    const onStatsUpdate = vi.fn()
    const lutDataRef = { current: createTestLut() }
    const props = {
      imageRef: { current: { ...decodedImage, source: 'quick' as const } },
      imageVersion: 1,
      decodedFrame: testFrame(1),
      color: { ...defaultColor, styleKind: 'custom' as const },
      viewMode: 'processed' as const,
      lutDataRef,
      lutDataVersion: 1,
      embeddedPreviewUrl: 'blob:embedded-preview',
      displaySource: 'quick',
      onStatsUpdate,
    } satisfies ComponentProps<typeof PreviewCanvas>
    const { container, rerender } = render(createElement(PreviewCanvas, props))
    await waitFor(() => expect(pipelineMock.waitForGpu).toHaveBeenCalled())
    act(() => fireResize(resizeCallbacks[0], 400, 300))
    const pipeline = pipelineMock.instances[0]!
    pipeline.uploadLUT.mockImplementationOnce(() => {
      throw new Error('Failed to create LUT texture')
    })
    pipeline.render.mockClear()

    lutDataRef.current = createTestLut()
    rerender(createElement(PreviewCanvas, { ...props, lutDataVersion: 2 }))
    await act(async () => firstFrame.resolve())

    // The frame fenced before the failure would have published the old look
    // or a LUT-less one; it is superseded, and the handoff image stays up
    // until the CPU executor takes over.
    expect(pipeline.render).not.toHaveBeenCalled()
    expect(onStatsUpdate).not.toHaveBeenCalled()
    expect(
      container.querySelector('[data-raw-preview-handoff-preview]'),
    ).toHaveAttribute('src', 'blob:embedded-preview')
    expect(screen.queryByText('Preview unavailable')).toBeNull()
  })

  it('draws no LUT-less frame for edits or resizes after the selected LUT fails to upload', async () => {
    const resizeCallbacks = captureResizeObservers()
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
    await waitFor(() => expect(onStatsUpdate).toHaveBeenCalledOnce())
    act(() => fireResize(resizeCallbacks[0], 400, 300))
    const pipeline = pipelineMock.instances[0]!
    pipeline.uploadLUT.mockImplementationOnce(() => {
      throw new Error('Failed to create LUT texture')
    })
    lutDataRef.current = createTestLut()
    rerender(createElement(PreviewCanvas, { ...props, lutDataVersion: 2 }))
    pipeline.render.mockClear()
    pipeline.setParams.mockClear()
    onStatsUpdate.mockClear()

    rerender(
      createElement(PreviewCanvas, {
        ...props,
        lutDataVersion: 2,
        color: { ...props.color, intensity: 0.4 },
      }),
    )
    vi.useFakeTimers()
    try {
      act(() => fireResize(resizeCallbacks[0], 360, 270))
      act(() => vi.runAllTimers())
    } finally {
      vi.useRealTimers()
    }
    await act(async () => {
      await Promise.resolve()
    })

    expect(pipeline.resize).toHaveBeenCalled()
    expect(pipeline.setParams).not.toHaveBeenCalled()
    expect(pipeline.render).not.toHaveBeenCalled()
    expect(onStatsUpdate).not.toHaveBeenCalled()
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

    it.each([
      [
        'another source with an equal size',
        frameDescriptor({
          sessionId: 'session-2',
          frameId: 'decoded-frame-2',
          stage: 'bounded-hq',
          quickPredecessorFrameId: quickFrame.frameId,
        }),
      ],
      [
        'a restored frame that names no predecessor',
        frameDescriptor({ frameId: 'decoded-frame-2', stage: 'bounded-hq' }),
      ],
      [
        'a frame that names another quick frame',
        frameDescriptor({
          frameId: 'decoded-frame-3',
          stage: 'bounded-hq',
          quickPredecessorFrameId: 'decoded-frame-2',
        }),
      ],
    ])('never bridges the quick frame into %s', async (_, successor) => {
      const view = await renderFittedQuickFrame()

      showBoundedHq(view, successor)

      expect(trackOf(view.container)).toHaveAttribute(
        'data-preview-track-ready',
        'false',
      )
      await act(async () => {
        await Promise.resolve()
      })
    })

    it('shows a same-size frame without a predecessor again once its box is measured, with one draw', async () => {
      const observers = queueFrameResizeObservers()
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
      }
      const { container, rerender } = render(
        createElement(PreviewCanvas, props),
      )
      await waitFor(() => {
        expect(processedPipelines()[0]?.render).toHaveBeenCalled()
      })
      act(() => {
        observers.deliverPending(400, 300)
      })
      await waitFor(() => {
        expect(trackOf(container)).toHaveAttribute(
          'data-preview-track-ready',
          'true',
        )
      })
      const pipeline = processedPipelines()[0]!
      pipeline.resize.mockClear()
      pipelineMock.pipelineEvents.length = 0

      // A restored frame with the same size names no predecessor, so the
      // track hides until it is measured for this frame. The viewport never
      // changes: only the observe() notification can measure it.
      imageRef.current = {
        ...decodedImage,
        source: 'bounded-hq',
        data: new Uint16Array(400 * 300 * 3),
      }
      rerender(
        createElement(PreviewCanvas, {
          ...props,
          imageVersion: 2,
          decodedFrame: frameDescriptor({
            frameId: 'decoded-frame-2',
            stage: 'bounded-hq',
          }),
          displaySource: 'bounded-hq',
        }),
      )
      expect(trackOf(container)).toHaveAttribute(
        'data-preview-track-ready',
        'false',
      )
      await waitFor(() => {
        expect(
          pipelineMock.pipelineEvents.filter(
            (event) => event.kind === 'processed' && event.op === 'render',
          ),
        ).toHaveLength(1)
      })

      act(() => {
        expect(observers.deliverPending(400, 300)).toBe(1)
      })
      await act(async () => {
        await Promise.resolve()
      })

      expect(trackOf(container)).toHaveAttribute(
        'data-preview-track-ready',
        'true',
      )
      expect(
        pipelineMock.pipelineEvents.filter(
          (event) => event.kind === 'processed' && event.op === 'render',
        ),
      ).toHaveLength(1)
      expect(pipeline.resize).not.toHaveBeenCalled()
    })

    it('never holds another source behind the retained quick compare pair', async () => {
      const view = await renderFittedQuickFrame({
        viewMode: 'compare',
        dualGpuAllowed: true,
      })
      await waitFor(() => {
        expect(
          view.container.querySelector('[data-compare-mode="dual-gpu"]'),
        ).toBeTruthy()
      })
      const originalFrame = deferred<void>()
      pipelineMock.waitForGpu.mockImplementation((canvas: HTMLCanvasElement) =>
        canvas.className.includes('raw-preview-original-gpu-canvas')
          ? originalFrame.promise
          : Promise.resolve(),
      )
      pipelineMock.pipelineEvents.length = 0

      showBoundedHq(
        view,
        frameDescriptor({
          sessionId: 'session-2',
          frameId: 'decoded-frame-2',
          stage: 'bounded-hq',
        }),
      )

      // The new source draws at once instead of waiting behind the old
      // source's compare pair, and compare waits for its own original.
      expect(
        view.container.querySelector('[data-compare-mode="dual-gpu"]'),
      ).toBeNull()
      await waitFor(() => {
        expect(
          pipelineMock.pipelineEvents.filter(
            (event) => event.kind === 'processed' && event.op === 'render',
          ),
        ).toHaveLength(1)
      })
      expect(
        view.container.querySelector('[data-compare-mode="dual-gpu"]'),
      ).toBeNull()

      await act(async () => originalFrame.resolve())
      await waitFor(() => {
        expect(
          view.container.querySelector('[data-compare-mode="dual-gpu"]'),
        ).toBeTruthy()
      })
    })

    it('uploads and draws no decoded pixels without an accepted descriptor', async () => {
      const onStatsUpdate = vi.fn()
      const props: ComponentProps<typeof PreviewCanvas> = {
        imageRef: { current: { ...decodedImage, source: 'quick' as const } },
        imageVersion: 1,
        decodedFrame: null,
        color: defaultColor,
        viewMode: 'compare' as const,
        dualGpuAllowed: true,
        lutDataRef: { current: null },
        lutDataVersion: 0,
        displaySource: 'quick',
        onStatsUpdate,
      }
      const { rerender } = render(createElement(PreviewCanvas, props))
      await waitFor(() => {
        expect(processedPipelines()[0]?.initialize).toHaveBeenCalled()
      })
      await act(async () => {
        await Promise.resolve()
      })

      expect(pipelineMock.pipelineEvents).toEqual([])
      expect(processedPipelines()[0]?.clearImage).toHaveBeenCalled()
      expect(originalPipelines()).toHaveLength(0)
      expect(onStatsUpdate).not.toHaveBeenCalled()

      rerender(
        createElement(PreviewCanvas, { ...props, decodedFrame: quickFrame }),
      )
      await waitFor(() => expect(onStatsUpdate).toHaveBeenCalledOnce())
      expect(
        pipelineMock.pipelineEvents.filter((event) => event.op === 'upload'),
      ).toEqual([
        { kind: 'processed', op: 'upload', width: 400, height: 300 },
        { kind: 'original', op: 'upload', width: 400, height: 300 },
      ])
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

    it('aspect-fits a landscape source into a portrait frame at the capped pixel ratio', async () => {
      const restoreDpr = stubDevicePixelRatio(3)
      try {
        const { resizeCallbacks, track, canvas, pipeline } =
          await renderSizedPreview()

        act(() => fireResize(resizeCallbacks.at(-1), 300, 600))

        expect(track.style.width).toBe('300px')
        expect(track.style.height).toBe('225px')
        expect(canvas.style.width).toBe('100%')
        expect(canvas.style.height).toBe('100%')
        expect([canvas.width, canvas.height]).toEqual([600, 450])
        expect(pipeline.resize).toHaveBeenLastCalledWith(600, 450)
        expect(track).toHaveAttribute('data-preview-track-ready', 'true')
      } finally {
        restoreDpr()
      }
    })

    it('aspect-fits a portrait source and rounds the scaled backing store', async () => {
      const restoreDpr = stubDevicePixelRatio(1.5)
      try {
        const { resizeCallbacks, track, canvas, pipeline } =
          await renderSizedPreview({
            ...decodedImage,
            width: 300,
            height: 400,
            data: new Uint16Array(300 * 400 * 3),
            metadata: { width: 300, height: 400 },
          })

        act(() => fireResize(resizeCallbacks.at(-1), 333, 500))

        expect(track.style.width).toBe('333px')
        expect(track.style.height).toBe('444px')
        expect([canvas.width, canvas.height]).toEqual([500, 666])
        expect(pipeline.resize).toHaveBeenLastCalledWith(500, 666)
      } finally {
        restoreDpr()
      }
    })

    it('follows a zero-size frame without a minimum backing store', async () => {
      const { resizeCallbacks, track, canvas, pipeline } =
        await renderSizedPreview()

      act(() => fireResize(resizeCallbacks.at(-1), 0, 0))

      expect(track.style.width).toBe('0px')
      expect(track.style.height).toBe('0px')
      expect([canvas.width, canvas.height]).toEqual([0, 0])
      expect(pipeline.resize).toHaveBeenLastCalledWith(0, 0)
    })

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

    it('applies every resize at once while no pipeline exists', () => {
      pipelineMock.initialize.mockReturnValue(new Promise(() => {}))
      const resizeCallbacks = captureResizeObservers()
      const { container } = render(
        createElement(PreviewCanvas, {
          imageRef: { current: decodedImage },
          imageVersion: 1,
          decodedFrame: testFrame(1),
          color: defaultColor,
          viewMode: 'processed' as const,
          lutDataRef: { current: null },
          lutDataVersion: 0,
        }),
      )
      const canvas = container.querySelector<HTMLCanvasElement>(
        '[data-raw-compare-track="image"] canvas',
      )!

      vi.useFakeTimers()
      try {
        act(() => fireResize(resizeCallbacks.at(-1), 400, 300))
        expect([canvas.width, canvas.height]).toEqual([400, 300])
        act(() => fireResize(resizeCallbacks.at(-1), 200, 300))
        expect([canvas.width, canvas.height]).toEqual([200, 150])
        expect(vi.getTimerCount()).toBe(0)
      } finally {
        vi.useRealTimers()
      }
    })

    it('flushes a pending settled resize on unmount and leaves no timer', async () => {
      const { resizeCallbacks, canvas, pipeline, unmount } =
        await renderSizedPreview()
      const callback = resizeCallbacks.at(-1)

      vi.useFakeTimers()
      try {
        act(() => fireResize(callback, 400, 300))
        act(() => fireResize(callback, 200, 150))
        expect(vi.getTimerCount()).toBe(1)
        pipeline.resize.mockClear()

        unmount()

        expect([canvas.width, canvas.height]).toEqual([200, 150])
        expect(pipeline.resize).not.toHaveBeenCalled()
        expect(vi.getTimerCount()).toBe(0)
      } finally {
        vi.useRealTimers()
      }
    })

    it('refits a replacement source at once and flushes the previous pending size', async () => {
      const { resizeCallbacks, canvas, track, pipeline, props, rerender } =
        await renderSizedPreview()
      const firstCallback = resizeCallbacks.at(-1)

      vi.useFakeTimers()
      try {
        act(() => fireResize(firstCallback, 400, 300))
        act(() => fireResize(firstCallback, 200, 150))
        expect(vi.getTimerCount()).toBe(1)
        pipeline.resize.mockClear()

        const portrait: DecodedImage = {
          ...decodedImage,
          width: 300,
          height: 400,
          data: new Uint16Array(300 * 400 * 3),
          metadata: { width: 300, height: 400 },
        }
        props.imageRef.current = portrait
        rerender(
          createElement(PreviewCanvas, {
            ...props,
            imageVersion: 2,
            decodedFrame: testFrame(2),
          }),
        )

        expect(pipeline.resize).toHaveBeenCalledExactlyOnceWith(200, 150)
        expect(vi.getTimerCount()).toBe(0)
        const nextCallback = resizeCallbacks.at(-1)
        expect(nextCallback).not.toBe(firstCallback)

        act(() => fireResize(nextCallback, 400, 300))

        expect(track.style.width).toBe('225px')
        expect(track.style.height).toBe('300px')
        expect([canvas.width, canvas.height]).toEqual([225, 300])
        expect(pipeline.resize).toHaveBeenLastCalledWith(225, 300)
        expect(vi.getTimerCount()).toBe(0)
        await act(async () => {
          await Promise.resolve()
        })
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

    function node(
      tag: string,
      attrs: Record<string, string>,
      children: MarkupNode[] = [],
    ): MarkupNode {
      return { tag, attrs, children }
    }

    const FRAME_CLASS =
      'relative w-full h-full flex items-center justify-center bg-[var(--color-preview-mat)]'

    function frameOutline(container: HTMLElement) {
      const frame = container.querySelector('[data-raw-preview-frame]')
      expect(frame).not.toBeNull()
      expect(container.children).toHaveLength(1)
      expect(container.firstElementChild).toBe(frame)
      return outline(frame!)
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

    it('lays out the empty stage with its frame, track, surface, canvas and empty state', async () => {
      const { container } = render(
        createElement(PreviewCanvas, {
          imageRef: { current: null },
          imageVersion: 0,
          decodedFrame: testFrame(0),
          color: defaultColor,
          viewMode: 'processed' as const,
          lutDataRef: { current: null },
          lutDataVersion: 0,
          className: 'stage-extra',
        }),
      )
      await waitFor(() => expect(pipelineMock.instances).toHaveLength(1))

      expect(frameOutline(container)).toEqual(
        node(
          'div',
          {
            class: `${FRAME_CLASS} stage-extra`,
            'data-raw-preview-frame': 'true',
            'data-display-source': 'none',
          },
          [
            node(
              'div',
              {
                class: 'raw-preview-track',
                'data-raw-compare-track': 'image',
                'data-preview-track-ready': 'false',
              },
              [
                node(
                  'div',
                  {
                    class: 'raw-preview-surface',
                    'data-raw-preview-surface': 'true',
                  },
                  [
                    node(
                      'div',
                      {
                        class: 'raw-preview-processed-layer',
                        'data-compare-mode': 'off',
                      },
                      [node('canvas', { class: 'raw-preview-canvas' })],
                    ),
                  ],
                ),
              ],
            ),
            node(
              'div',
              { class: 'absolute inset-0 flex items-center justify-center' },
              [node('span', { class: 'text-text-tertiary text-sm' })],
            ),
          ],
        ),
      )
      expect(screen.getByText('No image loaded')).toBeTruthy()
    })

    it('shows the embedded preview over a hidden canvas and marks the frame interactive', async () => {
      const frameRef = vi.fn()
      const { container, unmount } = render(
        createElement(PreviewCanvas, {
          imageRef: { current: null },
          imageVersion: 0,
          decodedFrame: testFrame(0),
          color: defaultColor,
          viewMode: 'processed' as const,
          lutDataRef: { current: null },
          lutDataVersion: 0,
          embeddedPreviewUrl: 'blob:embedded-preview',
          displaySource: 'embedded',
          onPreviewViewportChange: vi.fn(),
          frameRef,
        }),
      )
      await waitFor(() => expect(pipelineMock.instances).toHaveLength(1))

      const frame = container.querySelector('[data-raw-preview-frame]')
      expect(frameRef).toHaveBeenCalledWith(frame)
      expect(frameOutline(container)).toEqual(
        node(
          'div',
          {
            class: `${FRAME_CLASS} raw-preview-frame-interactive`,
            'data-raw-preview-frame': 'true',
            'data-display-source': 'embedded',
          },
          [
            node(
              'div',
              {
                class: 'raw-preview-track',
                'data-raw-compare-track': 'image',
                'data-preview-track-ready': 'false',
              },
              [
                node(
                  'div',
                  {
                    class: 'raw-preview-surface',
                    'data-raw-preview-surface': 'true',
                  },
                  [
                    node(
                      'div',
                      {
                        class: 'raw-preview-processed-layer',
                        'data-compare-mode': 'off',
                      },
                      [
                        node('canvas', {
                          class: 'raw-preview-canvas opacity-0',
                        }),
                      ],
                    ),
                    node('img', {
                      src: 'blob:embedded-preview',
                      alt: 'Embedded RAW preview',
                      class: 'raw-preview-embedded',
                    }),
                  ],
                ),
              ],
            ),
          ],
        ),
      )
      expect(screen.getByAltText('Embedded RAW preview')).toBe(
        container.querySelector('.raw-preview-embedded'),
      )

      unmount()
      expect(frameRef).toHaveBeenLastCalledWith(null)
    })

    it('layers the dual-gpu original under the clipped processed layer', async () => {
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
        }),
      )
      await waitFor(() => {
        expect(
          container.querySelector('[data-compare-mode="dual-gpu"]'),
        ).toBeTruthy()
      })

      const surface = frameOutline(container).children[0]!.children[0]!
      expect(surface.children).toEqual([
        node(
          'div',
          { class: 'raw-preview-original-gpu-shell raw-preview-layer-clipped' },
          [
            node(
              'div',
              {
                class: 'raw-preview-original-gpu-layer',
                'aria-hidden': 'true',
              },
              [node('canvas', { class: 'raw-preview-original-gpu-canvas' })],
            ),
          ],
        ),
        node(
          'div',
          {
            class: 'raw-preview-processed-layer raw-preview-layer-clipped',
            'data-compare-mode': 'dual-gpu',
          },
          [node('canvas', { class: 'raw-preview-canvas' })],
        ),
      ])
    })

    it('hides a warming original GPU layer and shows the embedded original under the processed layer', async () => {
      const originalInitialize = deferred<void>()
      pipelineMock.initialize.mockImplementation((canvas: HTMLCanvasElement) =>
        canvas.className.includes('raw-preview-original-gpu-canvas')
          ? originalInitialize.promise
          : Promise.resolve(),
      )
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

      const surface = frameOutline(container).children[0]!.children[0]!
      expect(surface.children).toEqual([
        node(
          'div',
          {
            class:
              'raw-preview-original-gpu-shell opacity-0 pointer-events-none',
          },
          [
            node(
              'div',
              {
                class: 'raw-preview-original-gpu-layer',
                'aria-hidden': 'true',
              },
              [node('canvas', { class: 'raw-preview-original-gpu-canvas' })],
            ),
          ],
        ),
        node(
          'div',
          {
            class: 'raw-preview-original-layer',
            'aria-hidden': 'true',
            'data-original-reference-source': 'embedded',
          },
          [
            node('img', {
              src: 'blob:embedded-preview',
              alt: '',
              'aria-hidden': 'true',
              draggable: 'false',
              class: 'raw-preview-original-image',
              decoding: 'async',
            }),
          ],
        ),
        node(
          'div',
          {
            class: 'raw-preview-processed-layer raw-preview-layer-clipped',
            'data-compare-mode': 'embedded-fallback',
          },
          [node('canvas', { class: 'raw-preview-canvas' })],
        ),
      ])

      await act(async () => {
        originalInitialize.resolve()
        await originalInitialize.promise
        await Promise.resolve()
      })
    })

    it('places the JPEG original under the clipped processed layer', async () => {
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

      const surface = frameOutline(container).children[0]!.children[0]!
      expect(surface.children).toEqual([
        node(
          'div',
          {
            class: 'raw-preview-original-layer',
            'aria-hidden': 'true',
            'data-original-reference-source': 'quick',
          },
          [
            node('img', {
              src: 'blob:original-reference',
              width: '400',
              height: '300',
              alt: '',
              'aria-hidden': 'true',
              draggable: 'false',
              class: 'raw-preview-original-image',
              decoding: 'async',
            }),
          ],
        ),
        node(
          'div',
          {
            class: 'raw-preview-processed-layer raw-preview-layer-clipped',
            'data-compare-mode': 'jpeg-fallback',
          },
          [node('canvas', { class: 'raw-preview-canvas' })],
        ),
      ])
    })

    it('prefers the supplied original reference fallback reason on a processed-only layer', async () => {
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
          originalReferenceFallbackReason: 'snapshot-budget-exceeded',
        }),
      )
      await waitFor(() => {
        expect(
          container.querySelector('[data-compare-mode="processed-only"]'),
        ).toBeTruthy()
      })

      const surface = frameOutline(container).children[0]!.children[0]!
      expect(surface.children).toEqual([
        node(
          'div',
          {
            class: 'raw-preview-processed-layer',
            'data-compare-mode': 'processed-only',
            'data-compare-fallback-reason': 'snapshot-budget-exceeded',
          },
          [node('canvas', { class: 'raw-preview-canvas' })],
        ),
      ])
    })

    it('places the embedded handoff preview beside the track, outside the zoomed surface', async () => {
      const onStatsUpdate = vi.fn()
      const { container } = render(
        createElement(PreviewCanvas, {
          imageRef: { current: { ...decodedImage, source: 'quick' } },
          imageVersion: 1,
          decodedFrame: testFrame(1),
          color: defaultColor,
          viewMode: 'processed' as const,
          lutDataRef: { current: null },
          lutDataVersion: 0,
          embeddedPreviewUrl: 'blob:embedded-preview',
          displaySource: 'quick',
          onStatsUpdate,
        }),
      )

      const frame = frameOutline(container)
      expect(frame.children.map((child) => child.attrs.class)).toEqual([
        'raw-preview-track',
        'raw-preview-handoff-preview',
      ])
      expect(frame.children[1]).toEqual(
        node('img', {
          src: 'blob:embedded-preview',
          alt: '',
          'aria-hidden': 'true',
          draggable: 'false',
          class: 'raw-preview-handoff-preview',
          'data-raw-preview-handoff-preview': 'true',
        }),
      )

      // The mocked pipeline initializes and publishes the first frame
      // before the test ends.
      await waitFor(() => expect(onStatsUpdate).toHaveBeenCalledOnce())
    })

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
