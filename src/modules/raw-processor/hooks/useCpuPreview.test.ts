import type {
  ColorGraphIntent,
  LUTColorProfile,
  LUTData,
  RawRenderExposure,
} from '@lumaforge/luma-color-runtime'
import {
  exposureMultiplierFromEv,
  NEUTRAL_SELECTIVE_COLOR,
  resolveExportColorGraph,
} from '@lumaforge/luma-color-runtime'
import type {
  CpuPreviewRequest,
  CpuPreviewResponse,
} from '@lumaforge/render-engine/preview'
import { resolvePreviewColorPlan } from '@lumaforge/render-engine/preview'
import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest'

import type { DecodedPreviewFrame } from '~/lib/preview/preview-frame'
import type { DecodedImage } from '~/lib/raw/decoder'

import type { CpuPreviewParams } from './useCpuPreview'
import {
  buildCpuPreviewGraph,
  neutralFrameCacheKey,
  useCpuPreview,
} from './useCpuPreview'

const exposure: RawRenderExposure = {
  ev: 0.5,
  multiplier: exposureMultiplierFromEv(0.5),
  source: 'user',
}

// Non-trivial look + tone so the neutral path must zero ALL of it.
const baseParams: CpuPreviewParams = {
  styleKind: 'custom',
  intensity: 0.8,
  builtinPreset: null,
  lut: null,
  rawRenderExposure: exposure,
  userExposureEv: 0.7,
  userContrast: 20,
  userHighlights: -15,
  userShadows: 10,
  userWhites: 5,
  userBlacks: -5,
  userTemperature: 40,
  userTint: -20,
  userSaturation: 0,
  userVibrance: 0,
  selectiveColor: NEUTRAL_SELECTIVE_COLOR,
}

class FakeWorker {
  static instances: FakeWorker[] = []

  onmessage: ((event: { data: CpuPreviewResponse }) => void) | null = null
  onerror: ((event: unknown) => void) | null = null
  readonly posted: CpuPreviewRequest[] = []
  readonly terminate = vi.fn()

  constructor() {
    FakeWorker.instances.push(this)
  }

  postMessage(message: CpuPreviewRequest) {
    this.posted.push(message)
  }

  respond(response: CpuPreviewResponse) {
    this.onmessage?.({ data: response })
  }
}

function makeDecodedImage(
  source: 'quick' | 'bounded-hq',
  over: Partial<DecodedImage> = {},
): DecodedImage {
  return {
    width: 2,
    height: 2,
    channels: 3,
    bitsPerChannel: 16,
    data: new Uint16Array(12),
    layout: 'rgb-u16',
    colorSpace: 'linear-prophoto-rgb',
    source,
    metadata: { width: 2, height: 2 },
    renderExposure: exposure,
    ...over,
  }
}

function makeFrame(
  over: Partial<DecodedPreviewFrame> &
    Pick<DecodedPreviewFrame, 'frameId' | 'stage'>,
): DecodedPreviewFrame {
  return {
    sessionId: 'session-1',
    width: 2,
    height: 2,
    exposure: { kind: 'source-pin', value: exposure },
    quickPredecessorFrameId: null,
    ...over,
  }
}

const quickFrame = makeFrame({ frameId: 'decoded-frame-1', stage: 'quick' })
// A bounded-HQ frame the GPU preview accepted before CPU mode mounted.
const recoveryFrame = makeFrame({
  frameId: 'decoded-frame-3',
  stage: 'bounded-hq',
})

afterEach(() => {
  vi.unstubAllGlobals()
  FakeWorker.instances = []
})

describe('useCpuPreview helpers', () => {
  it('requires the complete color intent', () => {
    expectTypeOf<CpuPreviewParams>().toMatchTypeOf<ColorGraphIntent>()
    expectTypeOf<CpuPreviewParams['selectiveColor']>().toEqualTypeOf<
      ColorGraphIntent['selectiveColor']
    >()
  })

  it('starts an editable CPU frame when mounted after a GPU bounded-HQ upgrade', () => {
    vi.stubGlobal('Worker', FakeWorker)
    const image = makeDecodedImage('bounded-hq')
    const { result } = renderHook(() =>
      useCpuPreview({
        enabled: true,
        image,
        decodedFrame: recoveryFrame,
        params: baseParams,
        variant: 'processed',
      }),
    )
    const worker = FakeWorker.instances[0]
    expect(worker).toBeDefined()
    // The accepted frame names the worker source.
    expect(worker.posted[0]).toMatchObject({
      type: 'loadSource',
      sourceId: recoveryFrame.frameId,
      width: 2,
      height: 2,
    })
    const render = worker.posted.find((message) => message.type === 'render')!
    if (render.type !== 'render') throw new Error('expected CPU render request')
    expect(render.sourceId).toBe(recoveryFrame.frameId)
    act(() =>
      worker.respond({
        type: 'rendered',
        sourceId: render.sourceId,
        requestId: render.requestId,
        width: 2,
        height: 2,
        rgba: new Uint8ClampedArray(16),
      }),
    )
    expect(result.current.frame?.width).toBe(2)
    expect(result.current.frame?.sourceId).toBe(recoveryFrame.frameId)
    expect(result.current.inFlight).toBe(false)
  })
  it('neutral cache key changes only with source + render exposure', () => {
    expect(neutralFrameCacheKey('s1', 0.5)).toBe(
      neutralFrameCacheKey('s1', 0.5),
    )
    expect(neutralFrameCacheKey('s1', 0.5)).not.toBe(
      neutralFrameCacheKey('s1', 1.0),
    )
    expect(neutralFrameCacheKey('s1', 0.5)).not.toBe(
      neutralFrameCacheKey('s2', 0.5),
    )
  })

  it('neutral zeros ALL look + tone but keeps render exposure', () => {
    const neutral = buildCpuPreviewGraph(baseParams, 'neutral')
    expect('unsupportedReason' in neutral).toBe(false)
    // Equivalent to a fully-zeroed-edits processed graph with the same exposure.
    const zeroed = buildCpuPreviewGraph(
      {
        styleKind: 'none',
        intensity: 0,
        builtinPreset: null,
        lut: null,
        rawRenderExposure: exposure,
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
      },
      'processed',
    )
    expect(neutral).toEqual(zeroed)
  })

  it('processed honors the look + tone params', () => {
    const processed = buildCpuPreviewGraph(baseParams, 'processed')
    expect('unsupportedReason' in processed).toBe(false)
    // Differs from neutral because edits are applied.
    expect(processed).not.toEqual(buildCpuPreviewGraph(baseParams, 'neutral'))
  })

  it('passes color balance params to the processed CPU preview graph', () => {
    const graph = buildCpuPreviewGraph(baseParams, 'processed')

    expect('unsupportedReason' in graph).toBe(false)
    if ('unsupportedReason' in graph) throw new Error('Expected graph')
    expect(
      graph.steps.find((step) => step.kind === 'user-color-balance'),
    ).toMatchObject({
      kind: 'user-color-balance',
      temperature: 40,
      tint: -20,
    })
  })

  it('resets color balance params in the neutral CPU preview graph', () => {
    const graph = buildCpuPreviewGraph(baseParams, 'neutral')

    expect('unsupportedReason' in graph).toBe(false)
    if ('unsupportedReason' in graph) throw new Error('Expected graph')
    expect(
      graph.steps.find((step) => step.kind === 'user-color-balance'),
    ).toMatchObject({
      kind: 'user-color-balance',
      temperature: 0,
      tint: 0,
    })
  })
})

describe('useCpuPreview hook', () => {
  it('keeps the quick CPU source but uses the current decoded image exposure after bounded-HQ replaces it', async () => {
    vi.stubGlobal('Worker', FakeWorker)
    const quickImage = makeDecodedImage('quick')
    const boundedHqExposure: RawRenderExposure = {
      ev: 2,
      multiplier: exposureMultiplierFromEv(2),
      source: 'image-statistics',
    }
    const boundedHqImage = makeDecodedImage('bounded-hq', {
      width: 4,
      height: 4,
      data: new Uint16Array(4 * 4 * 3),
      renderExposure: boundedHqExposure,
    })
    const hqFrame = makeFrame({
      frameId: 'decoded-frame-2',
      stage: 'bounded-hq',
      width: 4,
      height: 4,
      quickPredecessorFrameId: quickFrame.frameId,
    })

    const { result, rerender } = renderHook((props) => useCpuPreview(props), {
      initialProps: {
        enabled: true,
        image: quickImage,
        decodedFrame: quickFrame,
        params: baseParams,
        variant: 'processed' as const,
      },
    })

    const worker = FakeWorker.instances[0]
    expect(worker).toBeDefined()
    expect(result.current.inFlight).toBe(true)
    const firstRender = worker.posted.find((m) => m.type === 'render')
    expect(firstRender).toBeDefined()

    act(() => {
      worker.respond({
        type: 'rendered',
        sourceId: firstRender!.sourceId,
        requestId: firstRender!.requestId,
        rgba: new Uint8ClampedArray(2 * 2 * 4),
        width: 2,
        height: 2,
      })
    })

    expect(result.current.frame?.sourceId).toBe(firstRender!.sourceId)

    const renderCountBeforeHqReplace = worker.posted.filter(
      (m) => m.type === 'render',
    ).length

    rerender({
      enabled: true,
      image: boundedHqImage,
      decodedFrame: hqFrame,
      params: { ...baseParams, rawRenderExposure: boundedHqExposure },
      variant: 'processed' as const,
    })

    expect(result.current.frame?.sourceId).toBe(firstRender!.sourceId)
    // The retained quick source keeps its own frame ID, not the HQ frame's.
    expect(worker.posted.filter((m) => m.type === 'loadSource')).toHaveLength(1)
    expect(firstRender!.sourceId).toBe(quickFrame.frameId)

    const rendersAfterHqReplace = worker.posted.filter(
      (m) => m.type === 'render',
    )
    expect(rendersAfterHqReplace).toHaveLength(renderCountBeforeHqReplace + 1)
    const hqExposureRender = rendersAfterHqReplace.at(-1)
    expect(hqExposureRender?.sourceId).toBe(firstRender!.sourceId)
    expect(hqExposureRender?.graph.steps[1]).toMatchObject({
      kind: 'raw-render-exposure',
      ev: boundedHqExposure.ev,
      multiplier: boundedHqExposure.multiplier,
    })

    act(() => {
      worker.respond({
        type: 'rendered',
        sourceId: hqExposureRender!.sourceId,
        requestId: hqExposureRender!.requestId,
        rgba: new Uint8ClampedArray(2 * 2 * 4),
        width: 2,
        height: 2,
      })
    })

    const renderCountBeforeToneChange = worker.posted.filter(
      (m) => m.type === 'render',
    ).length

    rerender({
      enabled: true,
      image: boundedHqImage,
      decodedFrame: hqFrame,
      params: {
        ...baseParams,
        rawRenderExposure: boundedHqExposure,
        userContrast: 30,
      },
      variant: 'processed' as const,
    })

    const rendersAfterToneChange = worker.posted.filter(
      (m) => m.type === 'render',
    )
    expect(rendersAfterToneChange).toHaveLength(renderCountBeforeToneChange + 1)
    const latestRender = rendersAfterToneChange.at(-1)
    expect(latestRender?.sourceId).toBe(firstRender!.sourceId)
    expect(latestRender?.graph.steps[1]).toMatchObject({
      kind: 'raw-render-exposure',
      ev: boundedHqExposure.ev,
      multiplier: boundedHqExposure.multiplier,
    })

    const renderCountBeforeColorChange = worker.posted.filter(
      (m) => m.type === 'render',
    ).length

    await act(async () => {
      rerender({
        enabled: true,
        image: boundedHqImage,
        decodedFrame: hqFrame,
        params: {
          ...baseParams,
          rawRenderExposure: boundedHqExposure,
          userContrast: 30,
          userTemperature: -25,
        },
        variant: 'processed' as const,
      })
    })

    const rendersAfterColorChange = worker.posted.filter(
      (m) => m.type === 'render',
    )
    expect(rendersAfterColorChange).toHaveLength(renderCountBeforeColorChange)

    act(() => {
      worker.respond({
        type: 'rendered',
        sourceId: latestRender!.sourceId,
        requestId: latestRender!.requestId,
        rgba: new Uint8ClampedArray(2 * 2 * 4),
        width: 2,
        height: 2,
      })
    })

    const rendersAfterColorFlush = worker.posted.filter(
      (m) => m.type === 'render',
    )
    expect(rendersAfterColorFlush).toHaveLength(
      renderCountBeforeColorChange + 1,
    )
    expect(rendersAfterColorFlush.at(-1)?.graph.steps[2]).toMatchObject({
      kind: 'user-color-balance',
      temperature: -25,
      tint: -20,
    })
  })
})

describe('useCpuPreview original / processed toggle', () => {
  type RenderRequest = Extract<CpuPreviewRequest, { type: 'render' }>

  function mountToggle() {
    vi.stubGlobal('Worker', FakeWorker)
    const image = makeDecodedImage('quick')
    const props = (variant: 'processed' | 'neutral') => ({
      enabled: true,
      image,
      decodedFrame: quickFrame,
      params: baseParams,
      variant,
    })
    const hook = renderHook((input) => useCpuPreview(input), {
      initialProps: props('processed'),
    })
    const worker = FakeWorker.instances[0]!
    const renders = () =>
      worker.posted.filter(
        (message): message is RenderRequest => message.type === 'render',
      )
    // Answers the latest render posted to the worker unless told which.
    const answer = (
      fill: number,
      request: RenderRequest = renders().at(-1)!,
    ) => {
      act(() => {
        worker.respond({
          type: 'rendered',
          sourceId: request.sourceId,
          requestId: request.requestId,
          rgba: new Uint8ClampedArray(2 * 2 * 4).fill(fill),
          width: 2,
          height: 2,
        })
      })
    }
    const show = (variant: 'processed' | 'neutral') =>
      hook.rerender(props(variant))
    const edit = (
      variant: 'processed' | 'neutral',
      params: Partial<CpuPreviewParams>,
    ) =>
      hook.rerender({ ...props(variant), params: { ...baseParams, ...params } })

    return { result: hook.result, renders, answer, show, edit }
  }

  it('shows the processed frame again after a cached original', () => {
    const { result, renders, answer, show } = mountToggle()

    answer(200)
    expect(result.current.frame?.rgba[0]).toBe(200)

    // The first original is rendered, then cached.
    show('neutral')
    expect(renders().at(-1)?.variant).toBe('neutral')
    answer(40)
    expect(result.current.frame?.rgba[0]).toBe(40)

    show('processed')
    expect(renders().at(-1)?.variant).toBe('processed')
    answer(200)
    expect(result.current.frame?.rgba[0]).toBe(200)

    // The second original comes from the cache, without a render.
    const rendersBeforeCachedOriginal = renders().length
    show('neutral')
    expect(renders()).toHaveLength(rendersBeforeCachedOriginal)
    expect(result.current.frame?.rgba[0]).toBe(40)

    // Back to processed: the photo on screen is the original, so the
    // processed photo is rendered again instead of being taken as current.
    show('processed')
    expect(renders()).toHaveLength(rendersBeforeCachedOriginal + 1)
    expect(renders().at(-1)?.variant).toBe('processed')
    expect(result.current.inFlight).toBe(true)
    answer(200)
    expect(result.current.frame?.rgba[0]).toBe(200)
  })

  it('drops a processed frame that lands after a cached original replaced it', () => {
    const { result, renders, answer, show } = mountToggle()

    answer(200)
    show('neutral')
    answer(40)
    show('processed')
    answer(200)
    show('neutral')
    expect(result.current.frame?.rgba[0]).toBe(40)

    // Processed is asked for, then the cached original returns before the
    // processed render lands.
    show('processed')
    const lateProcessed = renders().at(-1)!
    expect(lateProcessed.variant).toBe('processed')
    expect(result.current.inFlight).toBe(true)
    const rendersBeforeReturn = renders().length
    show('neutral')
    expect(renders()).toHaveLength(rendersBeforeReturn)
    expect(result.current.frame?.rgba[0]).toBe(40)
    expect(result.current.inFlight).toBe(false)

    answer(200, lateProcessed)
    expect(result.current.frame?.rgba[0]).toBe(40)
    expect(result.current.inFlight).toBe(false)

    // The late frame was not cached as the original either.
    show('processed')
    expect(renders()).toHaveLength(rendersBeforeReturn + 1)
    answer(200)
    expect(result.current.frame?.rgba[0]).toBe(200)
    show('neutral')
    expect(renders()).toHaveLength(rendersBeforeReturn + 1)
    expect(result.current.frame?.rgba[0]).toBe(40)
  })

  it('keeps the cached original through look and tone edits', () => {
    const { result, renders, answer, show, edit } = mountToggle()

    answer(200)
    show('neutral')
    answer(40)
    show('processed')
    answer(200)
    show('neutral')
    const rendersWithCachedOriginal = renders().length

    edit('neutral', { userContrast: 60, intensity: 0.37 })
    edit('neutral', { userTemperature: -50 })
    expect(renders()).toHaveLength(rendersWithCachedOriginal)
    expect(result.current.frame?.rgba[0]).toBe(40)
  })

  it('does not ask for a second original when the look moves while the first renders', () => {
    const { result, renders, answer, show, edit } = mountToggle()

    answer(200)
    show('neutral')
    const original = renders().at(-1)!
    expect(original.variant).toBe('neutral')

    // The original carries none of the look, so editing it changes nothing
    // the pending render would draw.
    edit('neutral', { userContrast: 60, intensity: 0.37 })
    expect(renders()).toHaveLength(2)
    answer(40, original)
    expect(renders()).toHaveLength(2)
    expect(result.current.frame?.rgba[0]).toBe(40)
    expect(result.current.inFlight).toBe(false)
  })

  it('caches an original only from a render requested as the original', () => {
    const { result, renders, answer, show } = mountToggle()
    const firstProcessed = renders().at(-1)!

    // The original is asked for while the first processed render is still
    // running, so it waits behind it.
    show('neutral')
    expect(renders()).toHaveLength(1)
    answer(200, firstProcessed)
    expect(result.current.frame?.rgba[0]).not.toBe(200)
    expect(result.current.inFlight).toBe(true)
    const original = renders().at(-1)!
    expect(original.variant).toBe('neutral')

    // Processed is asked for again before the original lands.
    show('processed')
    answer(40, original)
    expect(result.current.frame?.rgba[0]).not.toBe(40)
    expect(renders().at(-1)?.variant).toBe('processed')
    answer(200)
    expect(result.current.frame?.rgba[0]).toBe(200)

    const rendersBeforeCachedOriginal = renders().length
    show('neutral')
    expect(renders()).toHaveLength(rendersBeforeCachedOriginal)
    expect(result.current.frame?.rgba[0]).toBe(40)
  })
})

describe('useCpuPreview look degradation (LUT-before-RAW)', () => {
  const unconfirmedLut: LUTData = {
    size: 2,
    data: new Float32Array(2 * 2 * 2 * 3),
    domainMin: [0, 0, 0],
    domainMax: [1, 1, 1],
    title: 'Detached Look',
    profileResolution: { kind: 'unknown' },
  }

  const confirmedProfile: LUTColorProfile = {
    id: 'test-display-look',
    label: 'Test Display Look',
    role: 'display-look',
    inputGamut: 'srgb-rec709',
    inputTransfer: 'srgb',
    inputRange: 'full',
    outputGamut: 'srgb-rec709',
    outputTransfer: 'srgb',
    outputRange: 'full',
    aliases: [],
  }

  const confirmedLut: LUTData = {
    ...unconfirmedLut,
    profileResolution: {
      kind: 'confirmed',
      profile: confirmedProfile,
      confidence: 'user',
    },
  }

  type HookProps = Parameters<typeof useCpuPreview>[0]

  function renderLutFirstHook(lut: LUTData) {
    vi.stubGlobal('Worker', FakeWorker)
    const image = makeDecodedImage('quick')

    return renderHook((props: HookProps) => useCpuPreview(props), {
      initialProps: {
        enabled: true,
        image,
        decodedFrame: quickFrame,
        params: { ...baseParams, lut },
        variant: 'processed' as const,
      },
    })
  }

  it('degrades to a look-stripped render instead of hanging when the LUT contract is unresolved at source load', () => {
    const { result } = renderLutFirstHook(unconfirmedLut)

    const worker = FakeWorker.instances[0]
    expect(worker).toBeDefined()

    // The unsupported processed graph must degrade to a look-stripped render
    // (user tone/colour retained, LUT excluded) — parity with the GPU
    // preview, which disables the LUT instead of blanking the photo.
    const render = worker!.posted.find((m) => m.type === 'render')
    expect(render).toBeDefined()
    expect(render!.graph).toEqual(
      buildCpuPreviewGraph(
        { ...baseParams, styleKind: 'none', builtinPreset: null, lut: null },
        'processed',
      ),
    )

    act(() => {
      worker!.respond({
        type: 'rendered',
        sourceId: render!.sourceId,
        requestId: render!.requestId,
        rgba: new Uint8ClampedArray(2 * 2 * 4),
        width: 2,
        height: 2,
      })
    })

    expect(result.current.frame).not.toBeNull()
    expect(result.current.inFlight).toBe(false)
    expect(result.current.failureReason).toBeNull()
  })

  it('does not re-request identical degraded renders when unconfirmed LUT identity churns', () => {
    const { rerender } = renderLutFirstHook(unconfirmedLut)

    const worker = FakeWorker.instances[0]!
    const initialRenderCount = worker.posted.filter(
      (m) => m.type === 'render',
    ).length
    expect(initialRenderCount).toBe(1)

    rerender({
      enabled: true,
      image: makeDecodedImage('quick'),
      decodedFrame: quickFrame,
      params: {
        ...baseParams,
        lut: { ...unconfirmedLut, title: 'Renamed Detached Look' },
      },
      variant: 'processed' as const,
    })

    expect(worker.posted.filter((m) => m.type === 'render')).toHaveLength(
      initialRenderCount,
    )
  })

  it('requests a full processed render once the LUT contract is confirmed', () => {
    const { rerender } = renderLutFirstHook(unconfirmedLut)

    const worker = FakeWorker.instances[0]!
    const degradedRender = worker.posted.find((m) => m.type === 'render')
    expect(degradedRender).toBeDefined()

    act(() => {
      worker.respond({
        type: 'rendered',
        sourceId: degradedRender!.sourceId,
        requestId: degradedRender!.requestId,
        rgba: new Uint8ClampedArray(2 * 2 * 4),
        width: 2,
        height: 2,
      })
    })

    rerender({
      enabled: true,
      image: makeDecodedImage('quick'),
      decodedFrame: quickFrame,
      params: { ...baseParams, lut: confirmedLut },
      variant: 'processed' as const,
    })

    const renders = worker.posted.filter((m) => m.type === 'render')
    expect(renders).toHaveLength(2)
    expect(renders.at(-1)?.graph).toEqual(
      buildCpuPreviewGraph({ ...baseParams, lut: confirmedLut }, 'processed'),
    )
    expect(renders.at(-1)?.graph.lutProfile).not.toBeNull()
  })

  it('degrades builtin styles to a look-stripped render instead of hanging', () => {
    vi.stubGlobal('Worker', FakeWorker)
    const image = makeDecodedImage('quick')

    const { result } = renderHook(() =>
      useCpuPreview({
        enabled: true,
        image,
        decodedFrame: quickFrame,
        params: {
          ...baseParams,
          styleKind: 'builtin',
          builtinPreset: 'mono',
          lut: null,
        },
        variant: 'processed',
      }),
    )

    const worker = FakeWorker.instances[0]!
    const render = worker.posted.find((m) => m.type === 'render')
    expect(render).toBeDefined()
    expect(render!.graph).toEqual(
      buildCpuPreviewGraph(
        { ...baseParams, styleKind: 'none', builtinPreset: null, lut: null },
        'processed',
      ),
    )
    expect(result.current.inFlight).toBe(true)
    expect(result.current.failureReason).toBeNull()
  })

  function answerLatest(worker: FakeWorker) {
    const render = worker.posted.filter((m) => m.type === 'render').at(-1)!
    act(() => {
      worker.respond({
        type: 'rendered',
        sourceId: render.sourceId,
        requestId: render.requestId,
        rgba: new Uint8ClampedArray(2 * 2 * 4),
        width: 2,
        height: 2,
      })
    })
  }

  it('renders again for a look strength between the detents', () => {
    const { rerender } = renderLutFirstHook(confirmedLut)
    const worker = FakeWorker.instances[0]!
    answerLatest(worker)

    rerender({
      enabled: true,
      image: makeDecodedImage('quick'),
      decodedFrame: quickFrame,
      params: { ...baseParams, lut: confirmedLut, intensity: 0.37 },
      variant: 'processed' as const,
    })

    const renders = worker.posted.filter((m) => m.type === 'render')
    expect(renders).toHaveLength(2)
    expect(renders.at(-1)?.graph).toEqual(
      buildCpuPreviewGraph(
        { ...baseParams, lut: confirmedLut, intensity: 0.37 },
        'processed',
      ),
    )
    expect(renders.at(-1)?.graph).not.toEqual(renders[0]?.graph)
  })

  it('renders again when the same LUT bytes take another contract', () => {
    const { rerender } = renderLutFirstHook(confirmedLut)
    const worker = FakeWorker.instances[0]!
    answerLatest(worker)

    const recontracted: LUTData = {
      ...confirmedLut,
      profileResolution: {
        kind: 'confirmed',
        profile: {
          ...confirmedProfile,
          id: 'test-scene-look',
          role: 'scene-creative',
          inputGamut: 'prophoto-rgb',
          inputTransfer: 'linear',
        },
        confidence: 'user',
      },
    }
    rerender({
      enabled: true,
      image: makeDecodedImage('quick'),
      decodedFrame: quickFrame,
      params: { ...baseParams, lut: recontracted },
      variant: 'processed' as const,
    })

    const renders = worker.posted.filter((m) => m.type === 'render')
    expect(renders).toHaveLength(2)
    expect(renders.at(-1)?.graph.lutProfile?.id).toBe('test-scene-look')
  })
})

describe('useCpuPreview shared preview color policy', () => {
  type HookProps = Parameters<typeof useCpuPreview>[0]

  const linearOutputLut: LUTData = {
    size: 2,
    data: new Float32Array(2 * 2 * 2 * 3),
    domainMin: [0, 0, 0],
    domainMax: [1, 1, 1],
    profileResolution: {
      kind: 'confirmed',
      confidence: 'user',
      profile: {
        id: 'test-linear-output',
        label: 'Test linear output',
        role: 'scene-creative',
        inputGamut: 'prophoto-rgb',
        inputTransfer: 'linear',
        inputRange: 'full',
        outputGamut: 'srgb-rec709',
        outputTransfer: 'linear',
        outputRange: 'full',
        aliases: [],
      },
    },
  }

  const acceptedLut: LUTData = {
    ...linearOutputLut,
    profileResolution: {
      kind: 'confirmed',
      confidence: 'user',
      profile: {
        ...(linearOutputLut.profileResolution.kind === 'confirmed'
          ? linearOutputLut.profileResolution.profile
          : (undefined as never)),
        id: 'test-srgb-output',
        outputTransfer: 'srgb',
      },
    },
  }

  function mount(params: CpuPreviewParams, variant: 'processed' | 'neutral') {
    vi.stubGlobal('Worker', FakeWorker)
    const image = makeDecodedImage('quick')
    const props = (
      next: CpuPreviewParams,
      nextVariant: 'processed' | 'neutral',
    ): HookProps => ({
      enabled: true,
      image,
      decodedFrame: quickFrame,
      params: next,
      variant: nextVariant,
    })
    const hook = renderHook((input: HookProps) => useCpuPreview(input), {
      initialProps: props(params, variant),
    })
    const worker = FakeWorker.instances[0]!
    const renders = () =>
      worker.posted.filter(
        (message): message is Extract<CpuPreviewRequest, { type: 'render' }> =>
          message.type === 'render',
      )
    const answer = (fill: number) => {
      const request = renders().at(-1)!
      act(() => {
        worker.respond({
          type: 'rendered',
          sourceId: request.sourceId,
          requestId: request.requestId,
          rgba: new Uint8ClampedArray(2 * 2 * 4).fill(fill),
          width: 2,
          height: 2,
        })
      })
    }
    const show = (
      next: CpuPreviewParams,
      nextVariant: 'processed' | 'neutral' = variant,
    ) => hook.rerender(props(next, nextVariant))
    return { result: hook.result, renders, answer, show }
  }

  it('draws the CPU plan graph for a refused LUT at any strength, rendering once', () => {
    const params = { ...baseParams, lut: linearOutputLut }
    const { renders, answer, show } = mount(params, 'processed')

    const plan = resolvePreviewColorPlan({
      intent: params,
      lut: linearOutputLut,
      rawRenderExposure: exposure,
      executor: 'cpu',
    })
    expect(plan.reason).toBe('lut-output-transfer-linear')
    expect(renders()).toHaveLength(1)
    expect(renders()[0]!.graph).toEqual(plan.graph)
    expect(renders()[0]!.graph.steps.some((s) => s.kind === 'lut3d')).toBe(
      false,
    )
    expect(
      renders()[0]!.graph.steps.find((s) => s.kind === 'user-color-balance'),
    ).toMatchObject({ temperature: 40, tint: -20 })
    answer(120)

    for (const intensity of [0, 0.37, 1]) {
      show({ ...params, intensity })
    }
    expect(renders()).toHaveLength(1)
    // The preview drops the look; export keeps refusing it.
    expect(resolveExportColorGraph(params).supported).toBe(false)
  })

  it('does not render again when the strength moves with no LUT loaded', () => {
    const { renders, answer, show } = mount(baseParams, 'processed')
    answer(120)

    show({ ...baseParams, intensity: 0.37 })
    show({ ...baseParams, intensity: 1 })
    expect(renders()).toHaveLength(1)
  })

  it('renders the LUT once the same bytes take a contract export accepts, and drops it again', () => {
    const params = { ...baseParams, lut: linearOutputLut }
    const { renders, answer, show } = mount(params, 'processed')
    answer(120)

    show({ ...params, lut: acceptedLut })
    expect(renders()).toHaveLength(2)
    expect(renders().at(-1)!.graph.lutProfile?.id).toBe('test-srgb-output')
    answer(160)

    show({ ...params, lut: { ...linearOutputLut } })
    expect(renders()).toHaveLength(3)
    expect(renders().at(-1)!.graph).toEqual(renders()[0]!.graph)
  })

  it('keeps the cached original through LUT contract changes', () => {
    const params = { ...baseParams, lut: linearOutputLut }
    const { result, renders, answer, show } = mount(params, 'processed')
    answer(200)
    show(params, 'neutral')
    answer(40)
    show(params, 'processed')
    answer(200)
    show(params, 'neutral')
    const rendersWithCachedOriginal = renders().length

    show({ ...params, lut: acceptedLut }, 'neutral')
    show({ ...params, lut: acceptedLut, intensity: 0.37 }, 'neutral')
    expect(renders()).toHaveLength(rendersWithCachedOriginal)
    expect(result.current.frame?.rgba[0]).toBe(40)
  })
})

describe('useCpuPreview queued renders', () => {
  type RenderRequest = Extract<CpuPreviewRequest, { type: 'render' }>

  it('stays in flight while a newer render waits behind the frame that landed', () => {
    vi.stubGlobal('Worker', FakeWorker)
    const image = makeDecodedImage('quick')
    const props = (userTemperature: number) => ({
      enabled: true,
      image,
      decodedFrame: quickFrame,
      params: { ...baseParams, userTemperature },
      variant: 'processed' as const,
    })
    const { result, rerender } = renderHook((input) => useCpuPreview(input), {
      initialProps: props(0),
    })
    const worker = FakeWorker.instances[0]!
    const renders = () =>
      worker.posted.filter(
        (message): message is RenderRequest => message.type === 'render',
      )
    const answer = (request: RenderRequest, fill: number) => {
      act(() => {
        worker.respond({
          type: 'rendered',
          sourceId: request.sourceId,
          requestId: request.requestId,
          rgba: new Uint8ClampedArray(2 * 2 * 4).fill(fill),
          width: 2,
          height: 2,
        })
      })
    }
    answer(renders().at(-1)!, 10)
    expect(result.current.inFlight).toBe(false)

    rerender(props(10))
    const older = renders().at(-1)!
    // A second edit waits behind the render still on the worker.
    rerender(props(20))
    expect(renders()).toHaveLength(2)

    answer(older, 100)
    const newer = renders().at(-1)!
    expect(newer.requestId).toBeGreaterThan(older.requestId)
    // The older colour may stand in on screen, but it is not settled.
    expect(result.current.frame?.requestId).toBe(older.requestId)
    expect(result.current.inFlight).toBe(true)

    answer(newer, 200)
    expect(result.current.frame?.requestId).toBe(newer.requestId)
    expect(result.current.inFlight).toBe(false)
  })
})

describe('useCpuPreview source identity', () => {
  type RenderRequest = Extract<CpuPreviewRequest, { type: 'render' }>
  type HookProps = Parameters<typeof useCpuPreview>[0]

  function mount(image: DecodedImage, decodedFrame: DecodedPreviewFrame) {
    vi.stubGlobal('Worker', FakeWorker)
    const props = (
      next: Partial<HookProps> = {},
      variant: 'processed' | 'neutral' = 'processed',
    ): HookProps => ({
      enabled: true,
      image,
      decodedFrame,
      // Upstream rebuilds the params on every render.
      params: { ...baseParams },
      variant,
      ...next,
    })
    const hook = renderHook((input: HookProps) => useCpuPreview(input), {
      initialProps: props(),
    })
    const worker = () => FakeWorker.instances[0]!
    const loads = () =>
      worker().posted.filter((message) => message.type === 'loadSource')
    const renders = () =>
      worker().posted.filter(
        (message): message is RenderRequest => message.type === 'render',
      )
    const answer = (
      fill: number,
      request: RenderRequest = renders().at(-1)!,
    ) => {
      act(() => {
        worker().respond({
          type: 'rendered',
          sourceId: request.sourceId,
          requestId: request.requestId,
          rgba: new Uint8ClampedArray(2 * 2 * 4).fill(fill),
          width: 2,
          height: 2,
        })
      })
    }
    return {
      result: hook.result,
      rerender: (
        next: Partial<HookProps> = {},
        variant: 'processed' | 'neutral' = 'processed',
      ) => hook.rerender(props(next, variant)),
      worker,
      loads,
      renders,
      answer,
    }
  }

  it('loads a replacing source of the same size and bytes as a new source', () => {
    const view = mount(makeDecodedImage('quick'), quickFrame)
    view.answer(200)
    view.rerender({}, 'neutral')
    view.answer(40)
    expect(view.result.current.frame?.rgba[0]).toBe(40)

    // Another RAW decodes to identical dimensions and bytes.
    const replacement = makeFrame({
      sessionId: 'session-2',
      frameId: 'decoded-frame-4',
      stage: 'quick',
    })
    view.rerender(
      { image: makeDecodedImage('quick'), decodedFrame: replacement },
      'neutral',
    )

    expect(view.loads()).toHaveLength(2)
    expect(view.loads().at(-1)).toMatchObject({
      sourceId: replacement.frameId,
    })
    expect(view.worker().posted).toContainEqual({
      type: 'disposeSource',
      sourceId: quickFrame.frameId,
    })
    // The first source's cached original is not this source's original.
    expect(view.result.current.frame).toBeNull()
    expect(view.renders().at(-1)).toMatchObject({
      sourceId: replacement.frameId,
      variant: 'neutral',
    })
    expect(view.result.current.inFlight).toBe(true)
    view.answer(90)
    expect(view.result.current.frame?.sourceId).toBe(replacement.frameId)
    expect(view.result.current.frame?.rgba[0]).toBe(90)
  })

  it('does not load the same accepted frame again for a fresh image object', () => {
    const view = mount(makeDecodedImage('quick'), quickFrame)
    view.answer(200)
    view.rerender({ image: makeDecodedImage('quick') })
    expect(view.loads()).toHaveLength(1)
    expect(view.renders()).toHaveLength(1)
    expect(view.result.current.inFlight).toBe(false)
  })

  it('keeps the quick source and its cached original across its HQ continuation', () => {
    const view = mount(makeDecodedImage('quick'), quickFrame)
    view.answer(200)
    view.rerender({}, 'neutral')
    view.answer(40)
    view.rerender()
    view.answer(200)
    const rendersBeforeHq = view.renders().length

    const hqFrame = makeFrame({
      frameId: 'decoded-frame-2',
      stage: 'bounded-hq',
      width: 4,
      height: 4,
      quickPredecessorFrameId: quickFrame.frameId,
    })
    const hqImage = makeDecodedImage('bounded-hq', {
      width: 4,
      height: 4,
      data: new Uint16Array(4 * 4 * 3),
    })
    view.rerender({ image: hqImage, decodedFrame: hqFrame }, 'neutral')

    expect(view.loads()).toHaveLength(1)
    expect(view.renders()).toHaveLength(rendersBeforeHq)
    expect(view.result.current.frame?.rgba[0]).toBe(40)
    expect(view.result.current.frame?.sourceId).toBe(quickFrame.frameId)
  })

  it('does not settle a stale render of the retained source after the HQ continuation', () => {
    const view = mount(makeDecodedImage('quick'), quickFrame)
    view.answer(10)
    view.rerender({ params: { ...baseParams, userContrast: 40 } })
    const older = view.renders().at(-1)!

    const hqExposure: RawRenderExposure = {
      ev: 1.5,
      multiplier: exposureMultiplierFromEv(1.5),
      source: 'image-statistics',
    }
    view.rerender({
      image: makeDecodedImage('bounded-hq', { renderExposure: hqExposure }),
      decodedFrame: makeFrame({
        frameId: 'decoded-frame-2',
        stage: 'bounded-hq',
        quickPredecessorFrameId: quickFrame.frameId,
      }),
      params: {
        ...baseParams,
        userContrast: 40,
        rawRenderExposure: hqExposure,
      },
    })
    expect(view.loads()).toHaveLength(1)

    // The older render shares the decoded source, yet the params moved on.
    view.answer(100, older)
    const newer = view.renders().at(-1)!
    expect(newer.requestId).toBeGreaterThan(older.requestId)
    expect(newer.sourceId).toBe(quickFrame.frameId)
    expect(view.result.current.frame?.requestId).toBe(older.requestId)
    expect(view.result.current.inFlight).toBe(true)

    view.answer(200, newer)
    expect(view.result.current.frame?.requestId).toBe(newer.requestId)
    expect(view.result.current.inFlight).toBe(false)
  })

  it('loads a bounded-HQ frame that does not continue the loaded quick frame', () => {
    const view = mount(makeDecodedImage('quick'), quickFrame)
    view.answer(200)

    // A bounded-HQ frame of the same session that names no quick predecessor.
    const unrelated = makeFrame({
      frameId: 'decoded-frame-5',
      stage: 'bounded-hq',
    })
    view.rerender({
      image: makeDecodedImage('bounded-hq'),
      decodedFrame: unrelated,
    })
    expect(view.loads()).toHaveLength(2)
    expect(view.loads().at(-1)).toMatchObject({ sourceId: unrelated.frameId })
    expect(view.result.current.frame).toBeNull()
    expect(view.renders().at(-1)?.sourceId).toBe(unrelated.frameId)
  })

  it('loads a bounded-HQ frame of another session that names the same predecessor ID', () => {
    const view = mount(makeDecodedImage('quick'), quickFrame)
    view.answer(200)

    const otherSession = makeFrame({
      sessionId: 'session-2',
      frameId: 'decoded-frame-6',
      stage: 'bounded-hq',
      quickPredecessorFrameId: quickFrame.frameId,
    })
    view.rerender({
      image: makeDecodedImage('bounded-hq'),
      decodedFrame: otherSession,
    })
    expect(view.loads()).toHaveLength(2)
    expect(view.loads().at(-1)).toMatchObject({
      sourceId: otherSession.frameId,
    })
  })

  it('loads nothing for decoded pixels the workflow published no descriptor for', () => {
    vi.stubGlobal('Worker', FakeWorker)
    const { result } = renderHook(() =>
      useCpuPreview({
        enabled: true,
        image: makeDecodedImage('quick'),
        decodedFrame: null,
        params: baseParams,
        variant: 'processed',
      }),
    )
    expect(FakeWorker.instances).toHaveLength(0)
    expect(result.current).toEqual({
      frame: null,
      inFlight: false,
      failureReason: null,
    })
  })
})
