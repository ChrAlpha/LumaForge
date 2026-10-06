import type {
  LUTData,
  PreviewHistogramState,
  ProcessingParams,
} from '@lumaforge/luma-color-runtime'
import { NEUTRAL_SELECTIVE_COLOR } from '@lumaforge/luma-color-runtime'
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { DecodedImage } from '~/lib/raw/decoder'

import type { DisplaySource } from '../model/session'
import { usePreviewHistogram } from './usePreviewHistogram'

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
  viewMode: 'processed',
  compareSplit: 0.5,
  styleKind: 'none',
  builtinPreset: null,
}

function mutableRef<T>(current: T) {
  return { current }
}

function createImage(
  source: 'quick' | 'bounded-hq',
  overrides: Partial<DecodedImage> = {},
): DecodedImage {
  const width = overrides.width ?? 2
  const height = overrides.height ?? 2
  const data =
    overrides.data ??
    new Uint16Array([
      0, 0, 0, 65535, 65535, 65535, 32768, 32768, 32768, 16384, 16384, 16384,
    ])

  return {
    width,
    height,
    channels: 3,
    bitsPerChannel: 16,
    data,
    layout: 'rgb-u16',
    colorSpace: 'linear-prophoto-rgb',
    source,
    metadata: { width, height },
    renderExposure: { ev: 0, multiplier: 1, source: 'identity' },
    ...overrides,
  }
}

function createLutData(profileId = 'test-vlog'): LUTData {
  return {
    size: 2,
    data: new Float32Array([
      0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0, 0, 0, 1, 1, 0, 1, 0, 1, 1, 1, 1, 1,
    ]),
    domainMin: [0, 0, 0],
    domainMax: [1, 1, 1],
    inputProfile: 'v-log',
    profileResolution: {
      kind: 'confirmed',
      confidence: 'metadata',
      profile: {
        id: profileId,
        label: 'Test V-Log',
        role: 'scene-creative',
        inputGamut: 'prophoto-rgb',
        inputTransfer: 'linear',
        inputRange: 'full',
        outputGamut: 'srgb-rec709',
        outputTransfer: 'srgb',
        outputRange: 'full',
        aliases: [],
      },
    },
  }
}

function renderPreviewHistogram(options: {
  enabled?: boolean
  image: DecodedImage | null
  imageVersion?: number
  params?: ProcessingParams
  lutData?: LUTData | null
  lutDataVersion?: number
  displaySource?: DisplaySource
}) {
  const imageRef = mutableRef<DecodedImage | null>(options.image)
  const lutDataRef = mutableRef<LUTData | null>(options.lutData ?? null)
  const props: Parameters<typeof usePreviewHistogram>[0] & {
    imageRef: typeof imageRef
    lutDataRef: typeof lutDataRef
  } = {
    enabled: options.enabled ?? true,
    imageRef,
    imageVersion: options.imageVersion ?? 1,
    params: options.params ?? defaultParams,
    lutDataRef,
    lutDataVersion: options.lutDataVersion ?? 0,
    displaySource: options.displaySource ?? 'quick',
  }

  const renders: PreviewHistogramState[] = []
  const hook = renderHook(
    (currentProps: typeof props) => {
      const state = usePreviewHistogram(currentProps)
      renders.push(state)
      return state
    },
    { initialProps: props },
  )

  return { ...hook, imageRef, lutDataRef, renders }
}

async function runDebouncedWork(ms = 150) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}

async function runAllWork() {
  await runDebouncedWork()
  await act(async () => {
    await vi.runOnlyPendingTimersAsync()
  })
}

async function runChunkedWorkUntilReady(
  result: ReturnType<typeof renderPreviewHistogram>['result'],
) {
  await runDebouncedWork()
  for (
    let attempt = 0;
    attempt < 128 && result.current.state !== 'ready';
    attempt += 1
  ) {
    await act(async () => {
      await vi.runOnlyPendingTimersAsync()
    })
  }
}

async function runImmediateChunkedWorkUntilReady(
  result: ReturnType<typeof renderPreviewHistogram>['result'],
) {
  for (
    let attempt = 0;
    attempt < 128 && result.current.state !== 'ready';
    attempt += 1
  ) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1)
    })
  }
}

describe('usePreviewHistogram', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('computes a quick histogram without copying/detaching the active buffer', async () => {
    const image = createImage('quick')
    const sliceSpy = vi
      .spyOn(Uint16Array.prototype, 'slice')
      .mockImplementation(() => {
        throw new Error('copying source preview data is forbidden')
      })

    const { result } = renderPreviewHistogram({ image })

    expect(result.current).toEqual({ state: 'computing', previous: null })

    await runAllWork()

    expect(result.current.state).toBe('ready')
    expect(result.current).toMatchObject({
      state: 'ready',
      source: 'quick',
      width: 2,
      height: 2,
      sampledPixels: 4,
      totalPixels: 4,
      diagnostics: {
        ownership: 'main-thread-chunked-no-copy',
        copiedInputBytes: 0,
        transferredInput: false,
        inputByteLength: image.data.buffer.byteLength,
        rowBandRows: 32,
      },
    })
    if (result.current.state === 'ready') {
      expect(
        result.current.bins.luma.reduce((sum, value) => sum + value, 0),
      ).toBe(4)
    }
    expect(image.data.byteLength).toBe(24)
    expect(sliceSpy).not.toHaveBeenCalled()
  })

  it('bounds large preview sampling without copying the active buffer', async () => {
    const width = 1000
    const height = 501
    const data = new Uint16Array(width * height * 3)
    data.fill(32768)
    const image = createImage('quick', { width, height, data })
    const sliceSpy = vi
      .spyOn(Uint16Array.prototype, 'slice')
      .mockImplementation(() => {
        throw new Error('copying source preview data is forbidden')
      })

    const { result } = renderPreviewHistogram({ image })

    await runChunkedWorkUntilReady(result)

    expect(result.current.state).toBe('ready')
    expect(result.current).toMatchObject({
      state: 'ready',
      source: 'quick',
      totalPixels: width * height,
      diagnostics: {
        ownership: 'main-thread-chunked-no-copy',
        copiedInputBytes: 0,
        transferredInput: false,
        inputByteLength: data.buffer.byteLength,
      },
    })
    if (result.current.state === 'ready') {
      expect(result.current.sampledPixels).toBeLessThan(
        result.current.totalPixels,
      )
      expect(result.current.sampledPixels).toBeGreaterThan(0)
    }
    expect(data.buffer.byteLength).toBe(width * height * 3 * 2)
    expect(sliceSpy).not.toHaveBeenCalled()
  })

  it('publishes a large quick preview histogram before debounce can be cancelled by HQ', async () => {
    const width = 1000
    const height = 501
    const data = new Uint16Array(width * height * 3)
    data.fill(32768)
    const image = createImage('quick', { width, height, data })

    const { result } = renderPreviewHistogram({ image })

    await runImmediateChunkedWorkUntilReady(result)

    expect(result.current).toMatchObject({
      state: 'ready',
      source: 'quick',
    })
  })

  it('yields between chunks while computing the first large quick preview', async () => {
    const width = 1000
    const height = 501
    const data = new Uint16Array(width * height * 3)
    data.fill(32768)
    const image = createImage('quick', { width, height, data })
    const subarraySpy = vi.spyOn(Uint16Array.prototype, 'subarray')

    const { result } = renderPreviewHistogram({ image })

    await act(async () => {
      await vi.advanceTimersToNextTimerAsync()
    })

    expect(result.current).toEqual({ state: 'computing', previous: null })
    expect(subarraySpy.mock.calls.length).toBeGreaterThan(0)
    expect(subarraySpy.mock.calls.length).toBeLessThan(Math.ceil(height / 2))

    await runImmediateChunkedWorkUntilReady(result)

    expect(result.current).toMatchObject({
      state: 'ready',
      source: 'quick',
    })
  })

  it.each<[string, ProcessingParams]>([
    ['look inputs are unchanged', defaultParams],
    [
      'saturation and vibrance are omitted',
      {
        ...defaultParams,
        userSaturation: undefined,
        userVibrance: undefined,
      } as unknown as ProcessingParams,
    ],
  ])(
    'keeps a superseded first quick histogram observable before bounded-HQ is ready when %s',
    async (_case, hqParams) => {
      const quickWidth = 1000
      const quickHeight = 501
      const hqWidth = 1000
      const hqHeight = 1001
      const quickData = new Uint16Array(quickWidth * quickHeight * 3)
      const hqData = new Uint16Array(hqWidth * hqHeight * 3)
      quickData.fill(32768)
      hqData.fill(49152)
      const quick = createImage('quick', {
        width: quickWidth,
        height: quickHeight,
        data: quickData,
      })
      const boundedHq = createImage('bounded-hq', {
        width: hqWidth,
        height: hqHeight,
        data: hqData,
      })
      const { result, rerender, imageRef, lutDataRef } = renderPreviewHistogram(
        {
          image: quick,
        },
      )

      imageRef.current = boundedHq
      rerender({
        imageRef,
        imageVersion: 2,
        params: hqParams,
        lutDataRef,
        lutDataVersion: 0,
        displaySource: 'bounded-hq',
      })

      let observedQuick = false
      for (let attempt = 0; attempt < 128 && !observedQuick; attempt += 1) {
        await act(async () => {
          await vi.advanceTimersToNextTimerAsync()
        })
        observedQuick =
          result.current.state === 'ready' && result.current.source === 'quick'
      }

      expect(observedQuick).toBe(true)

      for (
        let attempt = 0;
        attempt < 128 &&
        !(
          result.current.state === 'ready' &&
          result.current.source === 'bounded-hq'
        );
        attempt += 1
      ) {
        await act(async () => {
          await vi.advanceTimersToNextTimerAsync()
        })
      }

      expect(result.current).toMatchObject({
        state: 'ready',
        source: 'bounded-hq',
      })
    },
  )

  it.each<[string, Partial<ProcessingParams>]>([
    ['highlights', { userHighlights: -40 }],
    ['saturation', { userSaturation: 40 }],
    ['vibrance', { userVibrance: 40 }],
  ])(
    'cancels superseded first quick work when %s changes before bounded-HQ is ready',
    async (_field, lookChange) => {
      const quickWidth = 1000
      const quickHeight = 501
      const hqWidth = 1000
      const hqHeight = 1001
      const quickData = new Uint16Array(quickWidth * quickHeight * 3)
      const hqData = new Uint16Array(hqWidth * hqHeight * 3)
      quickData.fill(32768)
      hqData.fill(49152)
      const quick = createImage('quick', {
        width: quickWidth,
        height: quickHeight,
        data: quickData,
      })
      const boundedHq = createImage('bounded-hq', {
        width: hqWidth,
        height: hqHeight,
        data: hqData,
      })
      const { result, rerender, imageRef, lutDataRef } = renderPreviewHistogram(
        {
          image: quick,
        },
      )

      imageRef.current = boundedHq
      rerender({
        imageRef,
        imageVersion: 2,
        params: { ...defaultParams, ...lookChange },
        lutDataRef,
        lutDataVersion: 0,
        displaySource: 'bounded-hq',
      })

      let observedQuick = false
      for (
        let attempt = 0;
        attempt < 128 &&
        !(
          result.current.state === 'ready' &&
          result.current.source === 'bounded-hq'
        );
        attempt += 1
      ) {
        await act(async () => {
          await vi.advanceTimersToNextTimerAsync()
        })
        observedQuick =
          observedQuick ||
          (result.current.state === 'ready' &&
            result.current.source === 'quick')
      }

      expect(observedQuick).toBe(false)
      expect(result.current).toMatchObject({
        state: 'ready',
        source: 'bounded-hq',
      })
    },
  )

  it('runs nothing while no surface shows it, and computes once one does', async () => {
    const image = createImage('quick')
    const { result, rerender, imageRef, lutDataRef } = renderPreviewHistogram({
      enabled: false,
      image,
    })
    await runAllWork()
    expect(result.current.state).toBe('unsupported')

    rerender({
      enabled: true,
      imageRef,
      imageVersion: 1,
      params: defaultParams,
      lutDataRef,
      lutDataVersion: 0,
      displaySource: 'quick',
    })
    await runChunkedWorkUntilReady(result)
    expect(result.current).toMatchObject({ state: 'ready', source: 'quick' })

    // Turned off mid-session, it stops reporting bins it no longer updates.
    rerender({
      enabled: false,
      imageRef,
      imageVersion: 1,
      params: { ...defaultParams, userExposureEv: 1 },
      lutDataRef,
      lutDataVersion: 0,
      displaySource: 'quick',
    })
    await runAllWork()
    expect(result.current.state).toBe('unsupported')
  })

  it('reports embedded-only preview as unavailable', () => {
    const { result } = renderPreviewHistogram({
      image: null,
      displaySource: 'embedded',
    })

    expect(result.current).toEqual({
      state: 'unavailable',
      reason: 'embedded-only',
    })
  })

  it('reports preview data with mismatched dimensions as unsupported', async () => {
    const { result } = renderPreviewHistogram({
      image: createImage('quick', {
        width: 800,
        height: 600,
        data: new Uint16Array([0, 1024, 65535]),
      }),
    })

    await runAllWork()

    expect(result.current).toEqual({
      state: 'unsupported',
      reason: 'Preview histogram requires RGB16 Linear ProPhoto preview data.',
    })
  })

  it('replaces quick histogram with bounded-HQ after source replacement', async () => {
    const quick = createImage('quick')
    const boundedHq = createImage('bounded-hq', {
      data: new Uint16Array([
        65535, 0, 0, 0, 65535, 0, 0, 0, 65535, 65535, 65535, 65535,
      ]),
    })
    const { result, rerender, imageRef, lutDataRef } = renderPreviewHistogram({
      image: quick,
    })

    await runAllWork()
    expect(result.current.state).toBe('ready')
    expect(result.current).toMatchObject({ state: 'ready', source: 'quick' })

    imageRef.current = boundedHq
    rerender({
      imageRef,
      imageVersion: 2,
      params: defaultParams,
      lutDataRef,
      lutDataVersion: 0,
      displaySource: 'bounded-hq',
    })

    expect(result.current).toMatchObject({
      state: 'stale',
      previous: { state: 'ready', source: 'quick' },
    })

    await runAllWork()

    expect(result.current.state).toBe('ready')
    expect(result.current).toMatchObject({
      state: 'ready',
      source: 'bounded-hq',
      sampledPixels: 4,
    })
  })

  it('does not recompute on compare split changes', async () => {
    const { result, rerender, imageRef, lutDataRef } = renderPreviewHistogram({
      image: createImage('quick'),
    })

    await runAllWork()
    expect(result.current.state).toBe('ready')
    const ready = result.current

    rerender({
      imageRef,
      imageVersion: 1,
      params: { ...defaultParams, viewMode: 'compare', compareSplit: 0.82 },
      lutDataRef,
      lutDataVersion: 0,
      displaySource: 'quick',
    })

    expect(result.current).toBe(ready)
    await runAllWork()
    expect(result.current).toBe(ready)
  })

  it.each<[string, Partial<ProcessingParams>]>([
    ['temperature', { userTemperature: 25 }],
    ['saturation', { userSaturation: 25 }],
    ['vibrance', { userVibrance: 25 }],
  ])(
    'recomputes on %s changes while compare split remains irrelevant',
    async (_field, colorChange) => {
      const { result, rerender, imageRef, lutDataRef, renders } =
        renderPreviewHistogram({
          image: createImage('quick'),
        })

      await runAllWork()
      expect(result.current.state).toBe('ready')
      const previous = result.current
      const rendersBeforeChange = renders.length

      rerender({
        imageRef,
        imageVersion: 1,
        params: {
          ...defaultParams,
          viewMode: 'compare',
          compareSplit: 0.82,
          ...colorChange,
        },
        lutDataRef,
        lutDataVersion: 0,
        displaySource: 'quick',
      })

      expect(renders.slice(rendersBeforeChange)).not.toContain(previous)
      expect(result.current).toEqual({ state: 'stale', previous })

      // A scrub run on the same source never flips the label to computing:
      // the bins stay until the new run lands.
      await runDebouncedWork(1)
      expect(result.current.state).toBe('ready')
      expect(result.current).not.toBe(previous)
    },
  )

  it('keeps previous bins on screen, marked stale, until the new run lands', async () => {
    const { result, rerender, imageRef, lutDataRef } = renderPreviewHistogram({
      image: createImage('quick'),
    })

    await runAllWork()
    expect(result.current.state).toBe('ready')
    const previous = result.current

    rerender({
      imageRef,
      imageVersion: 1,
      params: { ...defaultParams, userExposureEv: 1 },
      lutDataRef,
      lutDataVersion: 0,
      displaySource: 'quick',
    })

    // A scrub run never flips the label to computing: the bins stay.
    expect(result.current).toEqual({ state: 'stale', previous })

    await act(async () => {
      await vi.runOnlyPendingTimersAsync()
    })
    expect(result.current.state).toBe('ready')
    expect(result.current).not.toBe(previous)
  })

  it('fails closed for built-in styles', () => {
    const { result } = renderPreviewHistogram({
      image: createImage('quick'),
      params: {
        ...defaultParams,
        styleKind: 'builtin',
        builtinPreset: 'cinematic',
      },
    })

    expect(result.current).toEqual({
      state: 'unsupported',
      reason:
        'Built-in styles are not supported by full-resolution JPEG export.',
    })
  })

  it('recomputes when LUT data changes', async () => {
    const { result, rerender, imageRef, lutDataRef } = renderPreviewHistogram({
      image: createImage('quick'),
    })

    await runAllWork()
    expect(result.current.state).toBe('ready')
    const previous = result.current

    lutDataRef.current = createLutData()
    rerender({
      imageRef,
      imageVersion: 1,
      params: { ...defaultParams, styleKind: 'custom' },
      lutDataRef,
      lutDataVersion: 1,
      displaySource: 'quick',
    })

    expect(result.current).toEqual({ state: 'stale', previous })
    await runAllWork()
    expect(result.current.state).toBe('ready')
    expect(result.current).not.toBe(previous)
  })

  it('does not recompute when only the view mode changes', async () => {
    const { result, rerender, imageRef, lutDataRef } = renderPreviewHistogram({
      image: createImage('quick'),
    })

    await runAllWork()
    const ready = result.current
    expect(ready.state).toBe('ready')

    rerender({
      imageRef,
      imageVersion: 1,
      params: { ...defaultParams, viewMode: 'original' },
      lutDataRef,
      lutDataVersion: 0,
      displaySource: 'quick',
    })

    expect(result.current).toBe(ready)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not recompute for an equal HSL record rebuilt upstream', async () => {
    const hsl = () => ({
      ...NEUTRAL_SELECTIVE_COLOR,
      red: { hue: 12, saturation: -8, lightness: 4 },
    })
    const params = { ...defaultParams, selectiveColor: hsl() }
    const { result, rerender, imageRef, lutDataRef } = renderPreviewHistogram({
      image: createImage('quick'),
      params,
    })

    await runAllWork()
    const ready = result.current
    expect(ready.state).toBe('ready')

    rerender({
      imageRef,
      imageVersion: 1,
      params: { ...params, selectiveColor: hsl() },
      lutDataRef,
      lutDataVersion: 0,
      displaySource: 'quick',
    })

    expect(result.current).toBe(ready)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('recomputes for a look strength between the detents', async () => {
    const lutData = createLutData()
    const params = { ...defaultParams, styleKind: 'custom' as const }
    const { result, rerender, imageRef, lutDataRef } = renderPreviewHistogram({
      image: createImage('quick'),
      params,
      lutData,
      lutDataVersion: 1,
    })

    await runAllWork()
    const previous = result.current
    expect(previous.state).toBe('ready')

    rerender({
      imageRef,
      imageVersion: 1,
      params: { ...params, intensity: 0.37 },
      lutDataRef,
      lutDataVersion: 1,
      displaySource: 'quick',
    })

    expect(result.current).toEqual({ state: 'stale', previous })
    await runAllWork()
    expect(result.current.state).toBe('ready')
    expect(result.current).not.toBe(previous)
  })

  it('recomputes when the same LUT bytes take another contract', async () => {
    const lutData = createLutData()
    const params = { ...defaultParams, styleKind: 'custom' as const }
    const { result, rerender, imageRef, lutDataRef } = renderPreviewHistogram({
      image: createImage('quick'),
      params,
      lutData,
      lutDataVersion: 1,
    })

    await runAllWork()
    const previous = result.current
    expect(previous.state).toBe('ready')

    const recontracted = createLutData('test-vlog-other')
    expect(recontracted.data).toEqual(lutData.data)
    lutDataRef.current = recontracted
    rerender({
      imageRef,
      imageVersion: 1,
      params,
      lutDataRef,
      lutDataVersion: 2,
      displaySource: 'quick',
    })

    expect(result.current).toEqual({ state: 'stale', previous })
    await runAllWork()
    expect(result.current.state).toBe('ready')
    expect(result.current).not.toBe(previous)
  })
})
