import type {
  LUTColorProfile,
  LUTData,
  RawRenderExposure,
} from '@lumaforge/luma-color-runtime'
import { exposureMultiplierFromEv } from '@lumaforge/luma-color-runtime'
import type {
  CpuPreviewRequest,
  CpuPreviewResponse,
} from '@lumaforge/render-engine/preview'
import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

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

afterEach(() => {
  vi.unstubAllGlobals()
  FakeWorker.instances = []
})

describe('useCpuPreview helpers', () => {
  it('starts an editable CPU frame when mounted after a GPU bounded-HQ upgrade', () => {
    vi.stubGlobal('Worker', FakeWorker)
    const image = makeDecodedImage('bounded-hq')
    const { result } = renderHook(() =>
      useCpuPreview({
        enabled: true,
        image,
        imageVersion: 3,
        params: baseParams,
        variant: 'processed',
      }),
    )
    const worker = FakeWorker.instances[0]
    expect(worker).toBeDefined()
    expect(worker.posted[0]).toMatchObject({
      type: 'loadSource',
      width: 2,
      height: 2,
    })
    const render = worker.posted.find((message) => message.type === 'render')!
    if (render.type !== 'render') throw new Error('expected CPU render request')
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

    const { result, rerender } = renderHook((props) => useCpuPreview(props), {
      initialProps: {
        enabled: true,
        image: quickImage,
        imageVersion: 1,
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
      imageVersion: 2,
      params: { ...baseParams, rawRenderExposure: boundedHqExposure },
      variant: 'processed' as const,
    })

    expect(result.current.frame?.sourceId).toBe(firstRender!.sourceId)

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
      imageVersion: 2,
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
        imageVersion: 2,
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

describe('useCpuPreview look degradation (LUT-before-RAW)', () => {
  const unconfirmedLut: LUTData = {
    size: 2,
    data: new Float32Array(2 * 2 * 2 * 3),
    domainMin: [0, 0, 0],
    domainMax: [1, 1, 1],
    title: 'Detached Look',
    inputProfile: 'display-srgb',
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
        imageVersion: 1,
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
      imageVersion: 1,
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
      imageVersion: 1,
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
        imageVersion: 1,
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
})
