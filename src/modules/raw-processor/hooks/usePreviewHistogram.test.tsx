import type {
  ColorGraphIntent,
  LUTData,
  PreviewHistogramState,
  ProcessingParams,
} from '@lumaforge/luma-color-runtime'
import {
  NEUTRAL_SELECTIVE_COLOR,
  NEUTRAL_USER_COLOR_INTENT,
} from '@lumaforge/luma-color-runtime'
import { act, renderHook } from '@testing-library/react'
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  expectTypeOf,
  it,
  vi,
} from 'vitest'

import type { DecodedPreviewFrame } from '~/lib/preview/preview-frame'
import type { DecodedImage } from '~/lib/raw/decoder'

import type { DisplaySource } from '../model/session'
import { usePreviewHistogram } from './usePreviewHistogram'

const defaultParams: ColorGraphIntent = {
  ...NEUTRAL_USER_COLOR_INTENT,
  intensity: 0.7,
  styleKind: 'none',
  builtinPreset: null,
}

/** The intent as a legacy record that still carries the view fields. */
function withLegacyView(
  params: ColorGraphIntent,
  view: Pick<ProcessingParams, 'viewMode' | 'compareSplit'>,
): ColorGraphIntent {
  const legacy: ColorGraphIntent & typeof view = { ...params, ...view }
  return legacy
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

let frameSequence = 0

function describeFrame(
  image: DecodedImage,
  overrides: Partial<DecodedPreviewFrame> = {},
): DecodedPreviewFrame {
  frameSequence += 1
  return {
    sessionId: 'session-a',
    frameId: `decoded-frame-${frameSequence}`,
    stage: image.source ?? 'unknown',
    width: image.width,
    height: image.height,
    exposure: { kind: 'source-pin', value: image.renderExposure },
    quickPredecessorFrameId: null,
    ...overrides,
  }
}

/**
 * Plays the frame producer: one descriptor per image it is handed, read
 * from the ref at render time, a bounded-HQ frame naming the quick frame it
 * replaces.
 */
function createFrameProducer() {
  const frames = new WeakMap<DecodedImage, DecodedPreviewFrame>()
  let live: DecodedPreviewFrame | null = null
  return (image: DecodedImage | null): DecodedPreviewFrame | null => {
    if (!image) {
      live = null
      return null
    }
    let frame = frames.get(image)
    if (!frame) {
      frame = describeFrame(image, {
        quickPredecessorFrameId:
          image.source === 'bounded-hq' && live?.stage === 'quick'
            ? live.frameId
            : null,
      })
      frames.set(image, frame)
    }
    live = frame
    return frame
  }
}

type HistogramHarnessProps = Omit<
  Parameters<typeof usePreviewHistogram>[0],
  'frame'
> & {
  /** The accepted descriptor; the harness producer's when left out. */
  frame?: DecodedPreviewFrame | null
}

function renderPreviewHistogram(options: {
  enabled?: boolean
  image: DecodedImage | null
  frame?: DecodedPreviewFrame | null
  params?: ColorGraphIntent
  lutData?: LUTData | null
  lutDataVersion?: number
  displaySource?: DisplaySource
}) {
  const imageRef = mutableRef<DecodedImage | null>(options.image)
  const lutDataRef = mutableRef<LUTData | null>(options.lutData ?? null)
  const props: HistogramHarnessProps & {
    imageRef: typeof imageRef
    lutDataRef: typeof lutDataRef
  } = {
    enabled: options.enabled ?? true,
    imageRef,
    ...('frame' in options ? { frame: options.frame } : {}),
    params: options.params ?? defaultParams,
    lutDataRef,
    lutDataVersion: options.lutDataVersion ?? 0,
    displaySource: options.displaySource ?? 'quick',
  }

  const produceFrame = createFrameProducer()
  const renders: PreviewHistogramState[] = []
  const hook = renderHook(
    ({ frame, ...currentProps }: HistogramHarnessProps) => {
      const state = usePreviewHistogram({
        ...currentProps,
        frame:
          frame === undefined
            ? produceFrame(currentProps.imageRef.current)
            : frame,
      })
      renders.push(state)
      return state
    },
    { initialProps: props },
  )

  return { ...hook, imageRef, lutDataRef, renders, produceFrame }
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

  it('requires the complete color intent', () => {
    expectTypeOf<
      Parameters<typeof usePreviewHistogram>[0]['params']
    >().toEqualTypeOf<ColorGraphIntent>()
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

  it.each<[string, ColorGraphIntent]>([
    ['look inputs are unchanged', defaultParams],
    [
      'saturation and vibrance are omitted',
      {
        ...defaultParams,
        userSaturation: undefined,
        userVibrance: undefined,
      } as unknown as ColorGraphIntent,
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

  it.each<[string, Partial<ColorGraphIntent>]>([
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

  it('lets only the bounded-HQ frame that names it take over from the first quick run', async () => {
    const quickData = new Uint16Array(1000 * 501 * 3)
    const hqData = new Uint16Array(1000 * 1001 * 3)
    quickData.fill(32768)
    hqData.fill(49152)
    const quick = createImage('quick', {
      width: 1000,
      height: 501,
      data: quickData,
    })
    const boundedHq = createImage('bounded-hq', {
      width: 1000,
      height: 1001,
      data: hqData,
    })
    const { result, rerender, imageRef, lutDataRef } = renderPreviewHistogram({
      image: quick,
    })

    // Same source and look, but the producer named no quick predecessor,
    // so the quick run is not this frame's stand-in.
    imageRef.current = boundedHq
    rerender({
      imageRef,
      frame: describeFrame(boundedHq, { quickPredecessorFrameId: null }),
      params: defaultParams,
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
        (result.current.state === 'ready' && result.current.source === 'quick')
    }

    expect(observedQuick).toBe(false)
    expect(result.current).toMatchObject({
      state: 'ready',
      source: 'bounded-hq',
    })
  })

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
      // A legacy record carrying view fields keeps the same job.
      params: withLegacyView(defaultParams, {
        viewMode: 'compare',
        compareSplit: 0.82,
      }),
      lutDataRef,
      lutDataVersion: 0,
      displaySource: 'quick',
    })

    expect(result.current).toBe(ready)
    await runAllWork()
    expect(result.current).toBe(ready)
  })

  it('keeps the job while the owner rerenders the same accepted frame', async () => {
    const image = createImage('quick')
    const frame = describeFrame(image)
    const { result, rerender, imageRef, lutDataRef } = renderPreviewHistogram({
      image,
      frame,
    })

    await runAllWork()
    expect(result.current.state).toBe('ready')
    const ready = result.current

    for (let attempt = 0; attempt < 2; attempt += 1) {
      rerender({
        imageRef,
        frame,
        params: { ...defaultParams },
        lutDataRef,
        lutDataVersion: 0,
        displaySource: 'quick',
      })
      expect(result.current).toBe(ready)
    }
    await runAllWork()
    expect(result.current).toBe(ready)
  })

  it('measures a newly accepted frame, however alike its size and stage', async () => {
    const first = createImage('quick')
    const again = createImage('quick', {
      data: new Uint16Array([
        65535, 0, 0, 0, 65535, 0, 0, 0, 65535, 65535, 65535, 65535,
      ]),
    })
    const { result, rerender, imageRef, lutDataRef } = renderPreviewHistogram({
      image: first,
    })

    await runAllWork()
    expect(result.current.state).toBe('ready')
    const previous = result.current

    // A frame decoded again for the same source, with the same size and
    // stage: only its descriptor says the pixels are new.
    imageRef.current = again
    rerender({
      imageRef,
      params: defaultParams,
      lutDataRef,
      lutDataVersion: 0,
      displaySource: 'quick',
    })
    expect(result.current).toEqual({ state: 'stale', previous })

    await runAllWork()
    expect(result.current.state).toBe('ready')
    expect(result.current).not.toEqual(previous)
  })

  it('measures a replacing source of identical size, never the old run landing late', async () => {
    const width = 1000
    const height = 501
    const oldData = new Uint16Array(width * height * 3)
    const newData = new Uint16Array(width * height * 3)
    oldData.fill(32768)
    newData.fill(8192)
    const oldImage = createImage('quick', { width, height, data: oldData })
    const newImage = createImage('quick', { width, height, data: newData })
    // Both producers numbered their first frame alike: only the session
    // tells the replacing source apart.
    const oldFrame = describeFrame(oldImage, {
      sessionId: 'session-old',
      frameId: 'decoded-frame-1',
    })
    const newFrame = describeFrame(newImage, {
      sessionId: 'session-new',
      frameId: 'decoded-frame-1',
    })

    const reference = renderPreviewHistogram({
      image: newImage,
      frame: describeFrame(newImage, { sessionId: 'session-reference' }),
    })
    await runChunkedWorkUntilReady(reference.result)
    const expected = reference.result.current
    reference.unmount()
    expect(expected.state).toBe('ready')

    const { result, rerender, imageRef, lutDataRef, renders } =
      renderPreviewHistogram({ image: oldImage, frame: oldFrame })

    // The old source's first run is under way, chunked, when it is replaced.
    await act(async () => {
      await vi.advanceTimersToNextTimerAsync()
    })
    expect(result.current).toEqual({ state: 'computing', previous: null })

    const rendersBeforeReplace = renders.length
    imageRef.current = newImage
    rerender({
      imageRef,
      frame: newFrame,
      params: defaultParams,
      lutDataRef,
      lutDataVersion: 0,
      displaySource: 'quick',
    })
    await runChunkedWorkUntilReady(result)

    const afterReplace = renders.slice(rendersBeforeReplace)
    const landed = afterReplace.filter((state) => state.state === 'ready')
    expect(landed.length).toBeGreaterThan(0)
    for (const state of [...afterReplace, result.current]) {
      expect(state.state === 'stale' ? state.previous : null).toBeNull()
    }
    if (result.current.state !== 'ready' || expected.state !== 'ready') {
      throw new Error('expected both histograms to be ready')
    }
    for (const state of landed) {
      if (state.state === 'ready') expect(state.bins).toEqual(expected.bins)
    }
    expect(result.current.bins).toEqual(expected.bins)
  })

  it('measures no pixels the workflow has not accepted', async () => {
    const { result } = renderPreviewHistogram({
      image: createImage('quick'),
      frame: null,
    })

    expect(result.current).toEqual({ state: 'unavailable', reason: 'no-image' })
    await runAllWork()
    expect(result.current).toEqual({ state: 'unavailable', reason: 'no-image' })
  })

  it.each<[string, Partial<ColorGraphIntent>]>([
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
        params: withLegacyView(
          { ...defaultParams, ...colorChange },
          { viewMode: 'compare', compareSplit: 0.82 },
        ),
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

  it('measures nothing for a built-in style the preview draws', () => {
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
      reason: 'The histogram does not measure built-in styles.',
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
      params: withLegacyView(defaultParams, { viewMode: 'original' }),
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

describe('usePreviewHistogram over the look the preview draws', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  // Non-neutral user color, so a measure that drops it shows.
  const adjusted: ColorGraphIntent = {
    ...defaultParams,
    styleKind: 'custom',
    intensity: 0.7,
    userExposureEv: 1,
    userContrast: 30,
    userSaturation: 20,
  }

  function refusedLut(kind: 'unconfirmed' | 'linear-output'): LUTData {
    const lut = createLutData()
    if (kind === 'unconfirmed') {
      return { ...lut, profileResolution: { kind: 'unknown' } }
    }
    if (lut.profileResolution.kind !== 'confirmed') throw new Error('fixture')
    return {
      ...lut,
      profileResolution: {
        ...lut.profileResolution,
        profile: {
          ...lut.profileResolution.profile,
          outputTransfer: 'linear',
        },
      },
    }
  }

  function measure(state: PreviewHistogramState) {
    if (state.state !== 'ready') throw new Error(`not ready: ${state.state}`)
    return { bins: state.bins, clipping: state.clipping }
  }

  async function settled(
    params: ColorGraphIntent,
    lutData: LUTData | null = null,
    lutDataVersion = 0,
  ) {
    const hook = renderPreviewHistogram({
      image: createImage('quick'),
      params,
      lutData,
      lutDataVersion,
    })
    await runAllWork()
    return hook
  }

  function rerenderWith(
    hook: Awaited<ReturnType<typeof settled>>,
    params: ColorGraphIntent,
    lutDataVersion: number,
  ) {
    hook.rerender({
      imageRef: hook.imageRef,
      params,
      lutDataRef: hook.lutDataRef,
      lutDataVersion,
      displaySource: 'quick',
    })
  }

  it.each(['unconfirmed', 'linear-output'] as const)(
    'measures the adjusted preview without the look for a %s LUT',
    async (kind) => {
      const refused = await settled(adjusted, refusedLut(kind), 1)
      const stripped = await settled({ ...adjusted, styleKind: 'none' })
      const neutral = await settled(defaultParams)

      expect(refused.result.current.state).toBe('ready')
      expect(measure(refused.result.current)).toEqual(
        measure(stripped.result.current),
      )
      expect(measure(refused.result.current)).not.toEqual(
        measure(neutral.result.current),
      )
    },
  )

  it('keeps the measure while the strength of a refused LUT moves', async () => {
    const hook = await settled(adjusted, refusedLut('linear-output'), 1)
    const ready = hook.result.current
    expect(ready.state).toBe('ready')

    for (const intensity of [0, 0.37, 1]) {
      rerenderWith(hook, { ...adjusted, intensity }, 1)
      expect(hook.result.current).toBe(ready)
      expect(vi.getTimerCount()).toBe(0)
    }
  })

  it('measures the LUT once the same bytes take a contract export accepts, and drops it again', async () => {
    const hook = await settled(adjusted, refusedLut('unconfirmed'), 1)
    const strippedMeasure = measure(hook.result.current)

    const accepted = createLutData()
    hook.lutDataRef.current = accepted
    rerenderWith(hook, adjusted, 2)
    expect(hook.result.current.state).toBe('stale')
    await runAllWork()
    const withLook = measure(hook.result.current)
    expect(withLook).not.toEqual(strippedMeasure)

    hook.lutDataRef.current = {
      ...accepted,
      profileResolution: { kind: 'unknown' },
    }
    rerenderWith(hook, adjusted, 3)
    await runAllWork()
    expect(measure(hook.result.current)).toEqual(strippedMeasure)
  })

  it('measures no look for a custom style whose LUT is not loaded, at any strength', async () => {
    const hook = await settled(adjusted)
    const stripped = await settled({ ...adjusted, styleKind: 'none' })
    const ready = hook.result.current
    expect(measure(ready)).toEqual(measure(stripped.result.current))

    rerenderWith(hook, { ...adjusted, intensity: 0.37 }, 0)
    expect(hook.result.current).toBe(ready)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('reports no numbers for a builtin preset the preview draws, at any strength', async () => {
    const builtin: ColorGraphIntent = {
      ...adjusted,
      styleKind: 'builtin',
      builtinPreset: 'cinematic',
    }
    const hook = await settled(builtin)

    // No TS executor draws a preset: the stripped graph would not measure
    // what the preview shows, so the histogram measures nothing.
    expect(hook.result.current.state).toBe('unsupported')
    expect(vi.getTimerCount()).toBe(0)
    for (const intensity of [0, 0.37, 1]) {
      rerenderWith(hook, { ...builtin, intensity }, 0)
      await runAllWork()
      expect(hook.result.current.state).toBe('unsupported')
    }
  })
})
