import type { ProcessingParams } from '@lumaforge/luma-color-runtime'
import { pickColorGraphIntent } from '@lumaforge/luma-color-runtime'
import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { DecodedPreviewFrame } from '~/lib/preview/preview-frame'
import type { DecodedImage } from '~/lib/raw/decoder'
import type { PipelineStats } from '~/lib/webgpu/raw-processing-pipeline'

import type {
  ProcessedPreviewOptions,
  ProcessedPreviewPipeline,
} from './useProcessedPreview'
import { useProcessedPreview } from './useProcessedPreview'

function deferred() {
  let resolve!: () => void
  let reject!: (error: unknown) => void
  const promise = new Promise<void>((onResolve, onReject) => {
    resolve = onResolve
    reject = onReject
  })
  return { promise, resolve, reject }
}

function createPipeline() {
  return {
    clearImage: vi.fn(),
    uploadImage: vi.fn(),
    clearLUT: vi.fn(),
    uploadLUT: vi.fn(),
    setParams: vi.fn(),
    render: vi.fn(() => ({ totalTime: 1 }) as PipelineStats),
    waitForGpu: vi.fn(() => Promise.resolve()),
  } satisfies Record<keyof ProcessedPreviewPipeline, unknown>
}

type TestPipeline = ReturnType<typeof createPipeline>

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
  intensity: 0.7,
  styleKind: 'none',
  builtinPreset: null,
}
const defaultColor = pickColorGraphIntent(defaultParams)

function decodedImage(overrides: Partial<DecodedImage> = {}): DecodedImage {
  const width = overrides.width ?? 400
  const height = overrides.height ?? 300
  return {
    width,
    height,
    channels: 3,
    bitsPerChannel: 16,
    data: new Uint16Array(width * height * 3),
    layout: 'rgb-u16',
    colorSpace: 'linear-prophoto-rgb',
    metadata: { width, height },
    renderExposure: { ev: 0, multiplier: 1, source: 'identity' },
    ...overrides,
  }
}

/** An accepted frame descriptor as the workflow's producer would mint it. */
function acceptedFrame(
  frameId: string,
  overrides: Partial<DecodedPreviewFrame> = {},
): DecodedPreviewFrame {
  return {
    sessionId: 'session-1',
    frameId,
    stage: 'unknown',
    width: 400,
    height: 300,
    exposure: {
      kind: 'unpinned',
      value: { ev: 0, multiplier: 1, source: 'identity' },
    },
    quickPredecessorFrameId: null,
    ...overrides,
  }
}

function createTestLut() {
  return {
    size: 2,
    data: new Float32Array(2 * 2 * 2 * 3),
    domainMin: [0, 0, 0] as [number, number, number],
    domainMax: [1, 1, 1] as [number, number, number],
    inputProfile: 'display-srgb' as const,
    profileResolution: { kind: 'unknown' as const },
  }
}

type Options = ProcessedPreviewOptions<TestPipeline>

function renderProcessed(initial: Partial<Options> = {}) {
  const onStatsUpdate = vi.fn()
  const onPipelineChange = vi.fn()
  const onRequestOriginalReferenceFallback = vi.fn()
  const base: Options = {
    imageRef: { current: decodedImage() },
    imageVersion: 1,
    decodedFrame: acceptedFrame('decoded-frame-1'),
    displaySource: 'quick',
    color: defaultColor,
    viewMode: 'processed',
    lutDataRef: { current: null },
    lutDataVersion: 0,
    embeddedPreviewUrl: null,
    dualGpuAllowed: false,
    suspended: false,
    supportsCssClip: true,
    jpegSnapshotReady: false,
    onStatsUpdate,
    onPipelineChange,
    onRequestOriginalReferenceFallback,
  }
  let props: Options = { ...base, ...initial }
  const result = renderHook(
    (current: Options) => useProcessedPreview<TestPipeline>(current),
    { initialProps: props },
  )
  const update = (next: Partial<Options>) => {
    props = { ...props, ...next }
    result.rerender(props)
  }
  const publish = async (pipeline: TestPipeline | null) => {
    await act(async () => {
      result.result.current.publishPipeline(pipeline)
    })
  }
  return {
    ...result,
    props: () => props,
    update,
    publish,
    onStatsUpdate,
    onPipelineChange,
    onRequestOriginalReferenceFallback,
  }
}

async function flush() {
  await act(async () => {
    await Promise.resolve()
  })
}

describe('useProcessedPreview', () => {
  it('announces a frame only after its first GPU completion, then reuses that proof for edits', async () => {
    const firstFrame = deferred()
    const pipeline = createPipeline()
    pipeline.waitForGpu.mockReturnValueOnce(firstFrame.promise)
    const view = renderProcessed()
    await view.publish(pipeline)

    expect(view.onPipelineChange).toHaveBeenLastCalledWith(pipeline)
    expect(pipeline.uploadImage).toHaveBeenCalledOnce()
    expect(pipeline.render).toHaveBeenCalledOnce()
    expect(view.result.current.currentProcessedFrameReady).toBe(false)

    // Edits while the first frame is in flight share its one fence.
    for (const userExposureEv of [0.1, 0.2]) {
      view.update({ color: { ...defaultColor, userExposureEv } })
    }
    expect(pipeline.waitForGpu).toHaveBeenCalledOnce()
    expect(pipeline.uploadImage).toHaveBeenCalledOnce()
    expect(view.onStatsUpdate).not.toHaveBeenCalled()

    await act(async () => firstFrame.resolve())
    expect(view.result.current.currentProcessedFrameReady).toBe(true)
    expect(view.onStatsUpdate).toHaveBeenCalledOnce()

    pipeline.render.mockClear()
    view.onStatsUpdate.mockClear()
    view.update({ color: { ...defaultColor, userExposureEv: 0.3 } })
    await flush()
    expect(pipeline.render).toHaveBeenCalledOnce()
    expect(pipeline.waitForGpu).toHaveBeenCalledOnce()
    expect(view.onStatsUpdate).toHaveBeenCalledOnce()
  })

  it('never announces a frame from a superseded image', async () => {
    const staleFrame = deferred()
    const currentFrame = deferred()
    const pipeline = createPipeline()
    pipeline.waitForGpu
      .mockReturnValueOnce(staleFrame.promise)
      .mockReturnValueOnce(currentFrame.promise)
    const view = renderProcessed()
    await view.publish(pipeline)

    view.props().imageRef.current = decodedImage({ width: 420, height: 320 })
    await act(async () =>
      view.update({
        imageVersion: 2,
        decodedFrame: acceptedFrame('decoded-frame-2'),
      }),
    )
    expect(pipeline.uploadImage).toHaveBeenCalledTimes(2)
    expect(pipeline.waitForGpu).toHaveBeenCalledTimes(2)

    // The superseded frame's failure is neither a frame nor an error.
    await act(async () => staleFrame.reject(new Error('stale frame failed')))
    expect(view.result.current.error).toBeNull()
    expect(view.onStatsUpdate).not.toHaveBeenCalled()
    expect(view.result.current.currentProcessedFrameReady).toBe(false)

    await act(async () => currentFrame.resolve())
    expect(view.onStatsUpdate).toHaveBeenCalledOnce()
    expect(view.result.current.currentProcessedFrameReady).toBe(true)
  })

  it.each(['forgotten', 'replaced', 'suspended'] as const)(
    'never announces a frame whose pipeline was %s while it ran',
    async (stop) => {
      const firstFrame = deferred()
      const pipeline = createPipeline()
      pipeline.waitForGpu.mockReturnValueOnce(firstFrame.promise)
      const replacement = createPipeline()
      const replacementFrame = deferred()
      replacement.waitForGpu.mockReturnValueOnce(replacementFrame.promise)
      const view = renderProcessed()
      await view.publish(pipeline)

      if (stop === 'forgotten') await view.publish(null)
      else if (stop === 'replaced') await view.publish(replacement)
      else await act(async () => view.update({ suspended: true }))
      await act(async () => firstFrame.resolve())

      expect(view.onStatsUpdate).not.toHaveBeenCalled()
      expect(view.result.current.currentProcessedFrameReady).toBe(false)
      if (stop === 'replaced') {
        // The replacement uploads and proves its own first frame.
        expect(replacement.uploadImage).toHaveBeenCalledOnce()
        expect(replacement.waitForGpu).toHaveBeenCalledOnce()
        await act(async () => replacementFrame.resolve())
        expect(view.onStatsUpdate).toHaveBeenCalledOnce()
        expect(view.result.current.currentProcessedFrameReady).toBe(true)
      }
    },
  )

  it('forgets a ready frame when its pipeline is forgotten or replaced', async () => {
    const pipeline = createPipeline()
    const view = renderProcessed()
    await view.publish(pipeline)
    await flush()
    expect(view.result.current.currentProcessedFrameReady).toBe(true)

    const replacement = createPipeline()
    const replacementFrame = deferred()
    replacement.waitForGpu.mockReturnValueOnce(replacementFrame.promise)
    await view.publish(replacement)
    expect(view.result.current.currentProcessedFrameReady).toBe(false)
    expect(replacement.uploadImage).toHaveBeenCalledOnce()

    await view.publish(null)
    await act(async () => replacementFrame.resolve())
    expect(view.result.current.currentProcessedFrameReady).toBe(false)
    expect(view.onPipelineChange).toHaveBeenLastCalledWith(null)
  })

  it('redraws only for the original output; compare, split, and viewport stay off the pipeline', async () => {
    const pipeline = createPipeline()
    const view = renderProcessed({ viewMode: 'processed' })
    await view.publish(pipeline)
    await flush()
    pipeline.setParams.mockClear()
    pipeline.render.mockClear()

    view.update({ viewMode: 'compare' })
    // A new record with an equal color intent is the same color.
    view.update({ color: { ...defaultColor } })
    await flush()
    expect(pipeline.setParams).not.toHaveBeenCalled()
    expect(pipeline.render).not.toHaveBeenCalled()

    await act(async () => view.update({ viewMode: 'original' }))
    expect(pipeline.setParams).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ viewMode: 'original' }),
    )
    expect(pipeline.render).toHaveBeenCalledOnce()

    await act(async () => view.update({ viewMode: 'compare' }))
    expect(pipeline.setParams).toHaveBeenLastCalledWith(
      expect.objectContaining({ viewMode: 'processed' }),
    )
    expect(pipeline.render).toHaveBeenCalledTimes(2)
    // The image on the GPU and its first-frame proof survive view changes.
    expect(pipeline.uploadImage).toHaveBeenCalledOnce()
    expect(pipeline.waitForGpu).toHaveBeenCalledOnce()
  })

  it('withholds and supersedes frames while the selected LUT is missing from the GPU', async () => {
    const inFlight = deferred()
    const pipeline = createPipeline()
    pipeline.waitForGpu.mockReturnValueOnce(inFlight.promise)
    const lutDataRef = { current: createTestLut() }
    const view = renderProcessed({
      lutDataRef,
      lutDataVersion: 1,
      color: { ...defaultColor, styleKind: 'custom' },
    })
    await view.publish(pipeline)
    expect(pipeline.uploadLUT).toHaveBeenCalledOnce()
    expect(pipeline.render).toHaveBeenCalledOnce()

    pipeline.uploadLUT.mockImplementationOnce(() => {
      throw new Error('Failed to create LUT texture')
    })
    lutDataRef.current = createTestLut()
    view.update({ lutDataVersion: 2 })
    await act(async () => inFlight.resolve())

    // The failure stays inside the hook: no error, no frame, no stats, and
    // edits and redraws draw no LUT-less frame.
    expect(view.result.current.error).toBeNull()
    expect(view.onStatsUpdate).not.toHaveBeenCalled()
    expect(view.result.current.currentProcessedFrameReady).toBe(false)
    view.update({
      color: { ...defaultColor, styleKind: 'custom', intensity: 0.4 },
    })
    act(() => view.result.current.redraw())
    await flush()
    expect(pipeline.render).toHaveBeenCalledOnce()

    const replacementLut = createTestLut()
    lutDataRef.current = replacementLut
    await act(async () => view.update({ lutDataVersion: 3 }))
    expect(pipeline.uploadLUT).toHaveBeenLastCalledWith(replacementLut)
    expect(pipeline.render).toHaveBeenCalledTimes(2)
    expect(view.onStatsUpdate).toHaveBeenCalledOnce()
    expect(view.result.current.currentProcessedFrameReady).toBe(true)
  })

  it('reports a failed current draw and an initialization failure without announcing a frame', async () => {
    const pipeline = createPipeline()
    pipeline.render.mockImplementationOnce(() => {
      throw new Error('Device lost while drawing')
    })
    const view = renderProcessed()
    await view.publish(pipeline)

    expect(view.result.current.error).toBe('Device lost while drawing')
    expect(pipeline.waitForGpu).not.toHaveBeenCalled()
    expect(view.onStatsUpdate).not.toHaveBeenCalled()
    expect(view.result.current.currentProcessedFrameReady).toBe(false)

    act(() => view.result.current.reportInitializationError('lost'))
    expect(view.result.current.error).toBe('GPU preview initialization failed')
    // A newly published pipeline clears the failure.
    await view.publish(createPipeline())
    expect(view.result.current.error).toBeNull()
  })

  it('draws nothing before a pipeline is published and catches up once it is', async () => {
    const view = renderProcessed()
    view.props().imageRef.current = decodedImage({ width: 420, height: 320 })
    view.update({
      imageVersion: 2,
      decodedFrame: acceptedFrame('decoded-frame-2'),
      color: { ...defaultColor, userExposureEv: 0.5 },
    })
    act(() => view.result.current.redraw())

    const pipeline = createPipeline()
    await view.publish(pipeline)
    await flush()
    expect(pipeline.uploadImage).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ width: 420, height: 320 }),
    )
    expect(pipeline.setParams).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ userExposureEv: 0.5 }),
    )
    expect(pipeline.render).toHaveBeenCalledOnce()
    expect(view.onStatsUpdate).toHaveBeenCalledOnce()
  })

  describe('compare handoff', () => {
    const compare = {
      viewMode: 'compare',
      dualGpuAllowed: true,
      embeddedPreviewUrl: 'blob:embedded',
    } satisfies Partial<Options>

    it('keeps the embedded camera reference apart from the technical original', async () => {
      const view = renderProcessed(compare)
      await view.publish(createPipeline())
      await flush()

      // While the original GPU layer warms, the embedded JPEG stands in.
      expect(view.result.current.shouldMountOriginalGpuLayer).toBe(true)
      expect(view.result.current.compareRenderMode).toEqual({
        kind: 'embedded-fallback',
        reason: 'original-gpu-pending',
      })

      const { generationKey } = view.result.current.originalGpuLayer
      act(() => view.result.current.originalGpuLayer.onReady(generationKey))
      expect(view.result.current.compareRenderMode).toEqual({
        kind: 'dual-gpu',
      })
    })

    it('falls back to the JPEG snapshot, then to processed-only, when the original layer fails', async () => {
      const view = renderProcessed({ ...compare, embeddedPreviewUrl: null })
      await view.publish(createPipeline())
      await flush()
      const { generationKey } = view.result.current.originalGpuLayer

      act(() => {
        view.result.current.originalGpuLayer.onError(
          new Error('stale'),
          'some-other-generation',
        )
      })
      expect(view.onRequestOriginalReferenceFallback).not.toHaveBeenCalled()

      act(() => {
        view.result.current.originalGpuLayer.onError(
          new Error('Original layer failed'),
          generationKey,
        )
      })
      expect(view.onRequestOriginalReferenceFallback).toHaveBeenCalledOnce()
      expect(view.result.current.shouldMountOriginalGpuLayer).toBe(false)
      expect(view.result.current.compareRenderMode).toEqual({
        kind: 'processed-only',
        reason: 'jpeg-fallback-unavailable',
      })

      view.update({ jpegSnapshotReady: true })
      expect(view.result.current.compareRenderMode).toEqual({
        kind: 'jpeg-fallback',
        reason: 'original-gpu-failed',
      })
    })

    it('holds the bounded-HQ draw behind the retained quick pair until the original layer reaches it', async () => {
      const pipeline = createPipeline()
      const imageRef = { current: decodedImage({ source: 'quick' }) }
      const quickFrame = acceptedFrame('decoded-frame-1', { stage: 'quick' })
      const view = renderProcessed({
        ...compare,
        imageRef,
        decodedFrame: quickFrame,
      })
      await view.publish(pipeline)
      await flush()
      act(() => view.result.current.markTrackReady())
      act(() => {
        view.result.current.originalGpuLayer.onReady(
          view.result.current.originalGpuLayer.generationKey,
        )
      })
      expect(view.result.current.compareRenderMode).toEqual({
        kind: 'dual-gpu',
      })
      pipeline.uploadImage.mockClear()
      pipeline.render.mockClear()

      imageRef.current = decodedImage({
        source: 'bounded-hq',
        width: 1600,
        height: 1200,
      })
      await act(async () =>
        view.update({
          imageVersion: 2,
          decodedFrame: acceptedFrame('decoded-frame-2', {
            stage: 'bounded-hq',
            width: 1600,
            height: 1200,
            quickPredecessorFrameId: quickFrame.frameId,
          }),
          displaySource: 'bounded-hq',
        }),
      )

      // The quick pair stays on screen and the track keeps its fit.
      expect(view.result.current.shouldDelayProcessedCompareRender).toBe(true)
      expect(view.result.current.compareRenderMode).toEqual({
        kind: 'dual-gpu',
      })
      expect(view.result.current.trackReady).toBe(true)
      expect(pipeline.render).not.toHaveBeenCalled()

      const hqKey = view.result.current.originalGpuLayer.generationKey
      await act(async () => view.result.current.originalGpuLayer.onReady(hqKey))
      // The handoff draws once and the lifted delay draws the same input once
      // more; the new image uploads once.
      expect(pipeline.uploadImage).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ width: 1600, height: 1200 }),
      )
      expect(pipeline.render).toHaveBeenCalledTimes(2)
      await flush()
      expect(view.result.current.currentProcessedFrameReady).toBe(true)
      expect(view.result.current.compareRenderMode).toEqual({
        kind: 'dual-gpu',
      })
    })
    it('draws a restored frame as its own generation, with no quick bridge', async () => {
      const pipeline = createPipeline()
      const imageRef = { current: decodedImage({ source: 'quick' }) }
      const quickFrame = acceptedFrame('decoded-frame-1', { stage: 'quick' })
      const view = renderProcessed({
        ...compare,
        imageRef,
        decodedFrame: quickFrame,
      })
      await view.publish(pipeline)
      await flush()
      act(() => view.result.current.markTrackReady())
      act(() => {
        view.result.current.originalGpuLayer.onReady(
          view.result.current.originalGpuLayer.generationKey,
        )
      })
      expect(view.result.current.compareRenderMode).toEqual({
        kind: 'dual-gpu',
      })

      // The preview is released for export, then restored.
      imageRef.current = null as never
      await act(async () =>
        view.update({ imageVersion: 2, decodedFrame: null }),
      )
      expect(view.result.current.shouldMountOriginalGpuLayer).toBe(false)
      expect(pipeline.clearImage).toHaveBeenCalled()
      pipeline.uploadImage.mockClear()
      pipeline.render.mockClear()

      imageRef.current = decodedImage({ source: 'bounded-hq' })
      await act(async () =>
        view.update({
          imageVersion: 3,
          decodedFrame: acceptedFrame('decoded-frame-3', {
            stage: 'bounded-hq',
          }),
          displaySource: 'bounded-hq',
        }),
      )

      // Nothing holds the restored frame back: it uploads, draws, and is
      // ready on its own, while compare waits for its own original.
      expect(view.result.current.retainedProcessedFrameReady).toBe(false)
      expect(view.result.current.shouldDelayProcessedCompareRender).toBe(false)
      expect(pipeline.uploadImage).toHaveBeenCalledOnce()
      expect(pipeline.render).toHaveBeenCalledOnce()
      expect(view.result.current.currentProcessedFrameReady).toBe(true)
      expect(view.result.current.compareRenderMode).toEqual({
        kind: 'embedded-fallback',
        reason: 'original-gpu-pending',
      })
    })

    it('publishes no original readiness from another frame', async () => {
      const imageRef = { current: decodedImage({ source: 'quick' }) }
      const view = renderProcessed({
        ...compare,
        imageRef,
        decodedFrame: acceptedFrame('decoded-frame-1', { stage: 'quick' }),
      })
      await view.publish(createPipeline())
      await flush()
      const staleKey = view.result.current.originalGpuLayer.generationKey

      imageRef.current = decodedImage({ source: 'quick' })
      await act(async () =>
        view.update({
          imageVersion: 2,
          decodedFrame: acceptedFrame('decoded-frame-1', {
            sessionId: 'session-2',
            stage: 'quick',
          }),
        }),
      )
      expect(view.result.current.originalGpuLayer.generationKey).not.toBe(
        staleKey,
      )
      act(() => view.result.current.originalGpuLayer.onReady(staleKey))

      expect(view.result.current.originalGpuReady).toBe(false)
      expect(view.result.current.retainedOriginalGpuFrameReady).toBe(false)
      expect(view.result.current.compareRenderMode).toEqual({
        kind: 'embedded-fallback',
        reason: 'original-gpu-pending',
      })

      act(() =>
        view.result.current.originalGpuLayer.onReady(
          view.result.current.originalGpuLayer.generationKey,
        ),
      )
      expect(view.result.current.compareRenderMode).toEqual({
        kind: 'dual-gpu',
      })
    })
  })

  it('resets the track fit for a new image unless a frame or handoff covers it', () => {
    const imageRef = { current: decodedImage() }
    const view = renderProcessed({ imageRef, displaySource: 'bounded-hq' })
    act(() => view.result.current.markTrackReady())
    expect(view.result.current.trackReady).toBe(true)

    imageRef.current = decodedImage({ width: 420, height: 320 })
    view.update({
      imageVersion: 2,
      decodedFrame: acceptedFrame('decoded-frame-2'),
    })
    expect(view.result.current.trackReady).toBe(false)

    // The embedded JPEG covers the quick decode, so the fit is kept.
    act(() => view.result.current.markTrackReady())
    imageRef.current = decodedImage({ source: 'quick', width: 500 })
    view.update({
      imageVersion: 3,
      decodedFrame: acceptedFrame('decoded-frame-3', { stage: 'quick' }),
      displaySource: 'quick',
      embeddedPreviewUrl: 'blob:embedded',
    })
    expect(view.result.current.embeddedHandoffPreviewVisible).toBe(true)
    expect(view.result.current.trackReady).toBe(true)
  })
})
