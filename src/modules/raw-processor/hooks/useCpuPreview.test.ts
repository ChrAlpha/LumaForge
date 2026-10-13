import type {
  LUTColorProfile,
  LUTData,
  RawRenderExposure,
} from '@lumaforge/luma-color-runtime'
import {
  exposureMultiplierFromEv,
  NEUTRAL_SELECTIVE_COLOR,
} from '@lumaforge/luma-color-runtime'
import type {
  CpuPreviewRequest,
  CpuPreviewResponse,
  CpuPreviewVariant,
} from '@lumaforge/render-engine/preview'
import { resolvePreviewColorPlan } from '@lumaforge/render-engine/preview'
import { act, renderHook } from '@testing-library/react'
import type { ComponentType, PropsWithChildren } from 'react'
import { StrictMode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { DecodedPreviewFrame } from '~/lib/preview/preview-frame'
import type { DecodedImage } from '~/lib/raw/decoder'

import { createTestDecodedImage } from '../test-support/builders'
import type { CpuPreviewParams, UseCpuPreviewOptions } from './useCpuPreview'
import { useCpuPreview } from './useCpuPreview'

type RenderRequest = Extract<CpuPreviewRequest, { type: 'render' }>

const exposure: RawRenderExposure = {
  ev: 0.5,
  multiplier: exposureMultiplierFromEv(0.5),
  source: 'user',
}

const hqExposure: RawRenderExposure = {
  ev: 1.5,
  multiplier: exposureMultiplierFromEv(1.5),
  source: 'image-statistics',
}

// A look and user tone and color the original must leave out.
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

const displayProfile: LUTColorProfile = {
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

const LUT_BYTES = new Float32Array(2 * 2 * 2 * 3)

/** The same LUT bytes under another contract: a new LUT object each time. */
function lutUnder(profileResolution: LUTData['profileResolution']): LUTData {
  return {
    size: 2,
    data: LUT_BYTES,
    domainMin: [0, 0, 0],
    domainMax: [1, 1, 1],
    profileResolution,
  }
}

const refusedLut = lutUnder({ kind: 'unknown' })
const displayLut = lutUnder({
  kind: 'confirmed',
  profile: displayProfile,
  confidence: 'user',
})
const sceneLut = lutUnder({
  kind: 'confirmed',
  confidence: 'user',
  profile: {
    ...displayProfile,
    id: 'test-scene-look',
    role: 'scene-creative',
    inputGamut: 'prophoto-rgb',
    inputTransfer: 'linear',
  },
})

/** The graph the shared preview color plan draws on the CPU. */
function planGraph(
  params: CpuPreviewParams,
  variant: CpuPreviewVariant = 'processed',
) {
  return resolvePreviewColorPlan({
    intent: params,
    lut: params.lut,
    rawRenderExposure: params.rawRenderExposure,
    executor: 'cpu',
    variant,
  }).graph
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
    act(() => this.onmessage?.({ data: response }))
  }
}

function decodedImage(
  source: 'quick' | 'bounded-hq',
  over: Partial<DecodedImage> = {},
): DecodedImage {
  return createTestDecodedImage({
    width: 2,
    height: 2,
    source,
    renderExposure: exposure,
    ...over,
  })
}

function frame(
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

const quickFrame = frame({ frameId: 'decoded-frame-1', stage: 'quick' })
const hqFrame = frame({
  frameId: 'decoded-frame-2',
  stage: 'bounded-hq',
  quickPredecessorFrameId: quickFrame.frameId,
})
// Another RAW that decodes to identical dimensions and bytes.
const otherSourceFrame = frame({
  sessionId: 'session-2',
  frameId: 'decoded-frame-4',
  stage: 'quick',
})

beforeEach(() => {
  vi.stubGlobal('Worker', FakeWorker)
})

afterEach(() => {
  vi.unstubAllGlobals()
  FakeWorker.instances = []
})

/**
 * Mounts the hook on the quick frame. Each rerender merges its props over the
 * last ones and passes fresh params, as upstream rebuilds them every render.
 */
function mount(
  initial: Partial<UseCpuPreviewOptions> = {},
  wrapper?: ComponentType<PropsWithChildren>,
) {
  let props: UseCpuPreviewOptions = {
    enabled: true,
    image: decodedImage('quick'),
    decodedFrame: quickFrame,
    params: baseParams,
    variant: 'processed',
    ...initial,
  }
  const hook = renderHook(
    (input: UseCpuPreviewOptions) => useCpuPreview(input),
    {
      initialProps: props,
      wrapper,
    },
  )
  // A disable or a removed source disposes the client; the next one loads on
  // a fresh worker.
  const worker = () => FakeWorker.instances.at(-1)!
  const posted = <T extends CpuPreviewRequest['type']>(type: T) =>
    worker().posted.filter(
      (message): message is Extract<CpuPreviewRequest, { type: T }> =>
        message.type === type,
    )
  const renders = () => posted('render')
  const rerender = (next: Partial<UseCpuPreviewOptions> = {}) => {
    props = { ...props, params: { ...props.params }, ...next }
    hook.rerender(props)
  }
  return {
    result: hook.result,
    unmount: hook.unmount,
    worker,
    loads: () => posted('loadSource'),
    renders,
    params: () => props.params,
    rerender,
    show: (variant: CpuPreviewVariant) => rerender({ variant }),
    edit: (params: Partial<CpuPreviewParams>) =>
      rerender({ params: { ...props.params, ...params } }),
    /** Answers the latest render posted unless told which. */
    answer: (fill = 0, request: RenderRequest = renders().at(-1)!) =>
      worker().respond({
        type: 'rendered',
        sourceId: request.sourceId,
        requestId: request.requestId,
        rgba: new Uint8ClampedArray(2 * 2 * 4).fill(fill),
        width: 2,
        height: 2,
      }),
  }
}

describe('useCpuPreview source', () => {
  it('starts an editable CPU frame from a bounded-HQ frame a GPU preview held', () => {
    const recovery = frame({ frameId: 'decoded-frame-3', stage: 'bounded-hq' })
    const view = mount({
      image: decodedImage('bounded-hq'),
      decodedFrame: recovery,
    })

    expect(view.loads()).toMatchObject([
      { sourceId: recovery.frameId, width: 2, height: 2 },
    ])
    expect(view.renders()[0]?.sourceId).toBe(recovery.frameId)
    view.answer()
    expect(view.result.current.frame?.sourceId).toBe(recovery.frameId)
    expect(view.result.current.inFlight).toBe(false)
  })

  it('loads nothing for decoded pixels the workflow published no descriptor for', () => {
    const view = mount({ decodedFrame: null })
    expect(FakeWorker.instances).toHaveLength(0)
    expect(view.result.current).toEqual({
      frame: null,
      inFlight: false,
      failureReason: null,
    })
  })

  it('does not load the same accepted frame again for a fresh image object', () => {
    const view = mount()
    view.answer()
    view.rerender({ image: decodedImage('quick') })
    expect(view.loads()).toHaveLength(1)
    expect(view.renders()).toHaveLength(1)
    expect(view.result.current.inFlight).toBe(false)
  })

  it('loads a replacing source of the same size and bytes as a new source, and drops the first one’s original', () => {
    const view = mount()
    view.answer(200)
    view.show('neutral')
    view.answer(40)

    view.rerender({
      image: decodedImage('quick'),
      decodedFrame: otherSourceFrame,
    })
    expect(view.loads().map((load) => load.sourceId)).toEqual([
      quickFrame.frameId,
      otherSourceFrame.frameId,
    ])
    expect(view.worker().posted).toContainEqual({
      type: 'disposeSource',
      sourceId: quickFrame.frameId,
    })
    // The first source's cached original is not this source's original.
    expect(view.result.current.frame).toBeNull()
    expect(view.result.current.inFlight).toBe(true)
    expect(view.renders().at(-1)).toMatchObject({
      sourceId: otherSourceFrame.frameId,
      variant: 'neutral',
    })
    view.answer(90)
    expect(view.result.current.frame?.sourceId).toBe(otherSourceFrame.frameId)

    // The first descriptor comes back: its original went with the worker
    // source it was rendered from, so it renders again.
    view.rerender({ image: decodedImage('quick'), decodedFrame: quickFrame })
    expect(view.loads()).toHaveLength(3)
    expect(view.result.current.frame).toBeNull()
    expect(view.renders().at(-1)).toMatchObject({
      sourceId: quickFrame.frameId,
      variant: 'neutral',
    })
  })

  it('does not cache an original that lands after its source was replaced', () => {
    const view = mount()
    view.answer(200)
    view.show('neutral')
    const late = view.renders().at(-1)!

    view.rerender({
      image: decodedImage('quick'),
      decodedFrame: otherSourceFrame,
    })
    view.answer(40, late)
    expect(view.result.current.frame).toBeNull()
    expect(view.result.current.inFlight).toBe(true)

    view.rerender({ image: decodedImage('quick'), decodedFrame: quickFrame })
    expect(view.result.current.frame).toBeNull()
    expect(view.renders().at(-1)).toMatchObject({
      sourceId: quickFrame.frameId,
      variant: 'neutral',
    })
  })

  it.each([
    ['disabled', { enabled: false }],
    ['left without a source', { image: null, decodedFrame: null }],
  ] satisfies Array<[string, Partial<UseCpuPreviewOptions>]>)(
    'releases the worker and the cached original when the preview is %s',
    (_label, off) => {
      const view = mount()
      view.answer(200)
      view.show('neutral')
      view.answer(40)
      const first = view.worker()

      view.rerender(off)
      expect(first.terminate).toHaveBeenCalled()
      expect(view.result.current.frame).toBeNull()

      view.rerender({
        enabled: true,
        image: decodedImage('quick'),
        decodedFrame: quickFrame,
      })
      expect(view.worker()).not.toBe(first)
      expect(view.loads()).toHaveLength(1)
      expect(view.result.current.frame).toBeNull()
      expect(view.result.current.inFlight).toBe(true)
      expect(view.renders()).toMatchObject([
        { sourceId: quickFrame.frameId, variant: 'neutral' },
      ])
    },
  )

  it('loads the source again after a StrictMode effect replay and releases the worker on unmount', () => {
    const view = mount({}, StrictMode)
    const worker = view.worker()
    expect(worker.terminate).not.toHaveBeenCalled()
    expect(worker.posted[0]).toMatchObject({
      type: 'loadSource',
      sourceId: quickFrame.frameId,
    })
    view.answer()
    expect(view.result.current.frame?.sourceId).toBe(quickFrame.frameId)
    expect(view.result.current.inFlight).toBe(false)

    view.unmount()
    expect(worker.terminate).toHaveBeenCalled()
  })

  it('keeps the quick source and its cached original across its HQ continuation, and renders the current params on it', () => {
    const view = mount()
    view.answer(200)
    view.show('neutral')
    view.answer(40)
    view.show('processed')
    view.answer(200)
    const rendersBeforeHq = view.renders().length

    view.rerender({
      image: decodedImage('bounded-hq'),
      decodedFrame: hqFrame,
      variant: 'neutral',
    })
    expect(view.loads()).toHaveLength(1)
    expect(view.renders()).toHaveLength(rendersBeforeHq)
    expect(view.result.current.frame?.rgba[0]).toBe(40)
    expect(view.result.current.frame?.sourceId).toBe(quickFrame.frameId)

    view.rerender({
      variant: 'processed',
      params: { ...baseParams, rawRenderExposure: hqExposure },
    })
    expect(view.renders().at(-1)?.sourceId).toBe(quickFrame.frameId)
    expect(view.renders().at(-1)?.graph).toEqual(planGraph(view.params()))
  })

  it.each([
    [
      'names no quick predecessor',
      frame({ frameId: 'decoded-frame-5', stage: 'bounded-hq' }),
    ],
    [
      'belongs to another session',
      frame({
        sessionId: 'session-2',
        frameId: 'decoded-frame-6',
        stage: 'bounded-hq',
        quickPredecessorFrameId: quickFrame.frameId,
      }),
    ],
  ])('loads a bounded-HQ frame that %s as a new source', (_label, hq) => {
    const view = mount()
    view.answer()
    view.rerender({ image: decodedImage('bounded-hq'), decodedFrame: hq })
    expect(view.loads().map((load) => load.sourceId)).toEqual([
      quickFrame.frameId,
      hq.frameId,
    ])
    expect(view.result.current.frame).toBeNull()
    expect(view.renders().at(-1)?.sourceId).toBe(hq.frameId)
  })

  it('reports a worker failure and stops waiting, until a new source loads', () => {
    const view = mount()
    view.worker().respond({
      type: 'error',
      sourceId: quickFrame.frameId,
      requestId: view.renders()[0]!.requestId,
      reason: 'out-of-memory',
    })
    expect(view.result.current).toEqual({
      frame: null,
      inFlight: false,
      failureReason: 'out-of-memory',
    })

    view.rerender({
      image: decodedImage('quick'),
      decodedFrame: otherSourceFrame,
    })
    expect(view.result.current.failureReason).toBeNull()
    expect(view.result.current.inFlight).toBe(true)
  })
})

describe('useCpuPreview renders', () => {
  it.each([
    ['an edit', { params: { ...baseParams, userTemperature: 20 } }],
    [
      'the HQ continuation',
      {
        image: decodedImage('bounded-hq'),
        decodedFrame: hqFrame,
        params: { ...baseParams, rawRenderExposure: hqExposure },
      },
    ],
  ] satisfies Array<[string, Partial<UseCpuPreviewOptions>]>)(
    'stays in flight while a newer render after %s waits behind the frame that landed',
    (_label, next) => {
      const view = mount()
      view.answer(10)
      expect(view.result.current.inFlight).toBe(false)

      view.edit({ userContrast: 40 })
      const older = view.renders().at(-1)!
      // The newer render waits behind the one still on the worker.
      view.rerender(next)
      expect(view.renders()).toHaveLength(2)

      view.answer(100, older)
      const newer = view.renders().at(-1)!
      expect(newer.requestId).toBeGreaterThan(older.requestId)
      expect(newer.sourceId).toBe(quickFrame.frameId)
      // The older photo may stand in on screen, but it is not settled.
      expect(view.result.current.frame?.requestId).toBe(older.requestId)
      expect(view.result.current.inFlight).toBe(true)

      view.answer(200, newer)
      expect(view.result.current.frame?.requestId).toBe(newer.requestId)
      expect(view.result.current.inFlight).toBe(false)
    },
  )

  it('serves a cached original without a render and never shows a processed frame it overtook', () => {
    const view = mount()
    view.answer(200)
    view.show('neutral')
    expect(view.renders().at(-1)?.graph).toEqual(
      planGraph(baseParams, 'neutral'),
    )
    view.answer(40)
    expect(view.result.current.frame?.rgba[0]).toBe(40)
    view.show('processed')
    view.answer(200)

    const rendersWithCachedOriginal = view.renders().length
    view.show('neutral')
    expect(view.renders()).toHaveLength(rendersWithCachedOriginal)
    expect(view.result.current.frame?.rgba[0]).toBe(40)

    // The photo on screen is the original, so processed renders again rather
    // than matching the render it would otherwise duplicate.
    view.show('processed')
    const late = view.renders().at(-1)!
    expect(view.renders()).toHaveLength(rendersWithCachedOriginal + 1)
    expect(late.variant).toBe('processed')
    expect(view.result.current.inFlight).toBe(true)

    // The cached original returns before that render lands: the late frame
    // is neither shown nor cached as the original.
    view.show('neutral')
    expect(view.result.current.inFlight).toBe(false)
    view.answer(200, late)
    expect(view.result.current.frame?.rgba[0]).toBe(40)
    expect(view.result.current.inFlight).toBe(false)
    view.show('processed')
    view.answer(200)
    expect(view.result.current.frame?.rgba[0]).toBe(200)
    view.show('neutral')
    expect(view.renders()).toHaveLength(rendersWithCachedOriginal + 2)
    expect(view.result.current.frame?.rgba[0]).toBe(40)
  })

  it('caches an original only from a render requested as the original', () => {
    const view = mount()
    const firstProcessed = view.renders()[0]!

    // The original is asked for while the first processed render is still
    // running, so it waits behind it.
    view.show('neutral')
    expect(view.renders()).toHaveLength(1)
    view.answer(200, firstProcessed)
    expect(view.result.current.frame).toBeNull()
    expect(view.result.current.inFlight).toBe(true)
    const original = view.renders().at(-1)!
    expect(original.variant).toBe('neutral')

    // Processed is asked for again before the original lands.
    view.show('processed')
    view.answer(40, original)
    expect(view.result.current.frame).toBeNull()
    view.answer(200)
    expect(view.result.current.frame?.rgba[0]).toBe(200)

    const rendersBeforeCachedOriginal = view.renders().length
    view.show('neutral')
    expect(view.renders()).toHaveLength(rendersBeforeCachedOriginal)
    expect(view.result.current.frame?.rgba[0]).toBe(40)
  })

  it('does not ask for a second original when the look moves while the first renders', () => {
    const view = mount()
    view.answer(200)
    view.show('neutral')
    const original = view.renders().at(-1)!

    // The original draws none of the look, so the edit changes nothing the
    // pending render would draw.
    view.edit({ userContrast: 60, intensity: 0.37 })
    view.answer(40, original)
    expect(view.renders()).toHaveLength(2)
    expect(view.result.current.frame?.rgba[0]).toBe(40)
    expect(view.result.current.inFlight).toBe(false)
  })

  it('keeps the cached original through look, tone and LUT edits, and renders it again for a moved render exposure', () => {
    const view = mount({ params: { ...baseParams, lut: refusedLut } })
    view.answer(200)
    view.show('neutral')
    view.answer(40)
    view.show('processed')
    view.answer(200)
    view.show('neutral')
    const rendersWithCachedOriginal = view.renders().length

    view.edit({ userContrast: 60, intensity: 0.37 })
    view.edit({ userTemperature: -50 })
    view.edit({ lut: displayLut })
    expect(view.renders()).toHaveLength(rendersWithCachedOriginal)
    expect(view.result.current.frame?.rgba[0]).toBe(40)

    view.edit({ rawRenderExposure: hqExposure })
    expect(view.renders()).toHaveLength(rendersWithCachedOriginal + 1)
    expect(view.renders().at(-1)?.graph).toEqual(
      planGraph(view.params(), 'neutral'),
    )
  })
})

describe('useCpuPreview look', () => {
  it.each([
    ['a LUT whose contract export refuses', { lut: refusedLut }],
    ['a built-in preset', { styleKind: 'builtin', builtinPreset: 'mono' }],
    ['a custom look whose LUT has not loaded', {}],
  ] satisfies Array<[string, Partial<CpuPreviewParams>]>)(
    'draws the CPU plan graph for %s once, whatever the strength',
    (_label, look) => {
      const params = { ...baseParams, ...look }
      const view = mount({ params })
      expect(view.renders().map((render) => render.graph)).toEqual([
        planGraph(params),
      ])
      view.answer()
      expect(view.result.current.frame).not.toBeNull()
      expect(view.result.current.inFlight).toBe(false)
      expect(view.result.current.failureReason).toBeNull()

      for (const intensity of [0, 0.37, 1]) {
        // A new object with the same bytes and contract is the same LUT.
        view.edit({ intensity, lut: params.lut && { ...params.lut } })
      }
      expect(view.renders()).toHaveLength(1)
    },
  )

  it('renders again whenever the drawn LUT or its strength changes, comparing the LUT by identity', () => {
    const view = mount({ params: { ...baseParams, lut: refusedLut } })
    const lastGraph = () => view.renders().at(-1)?.graph
    view.answer()

    // The same bytes take a contract export accepts.
    view.edit({ lut: displayLut })
    expect(lastGraph()?.lutProfile?.id).toBe('test-display-look')
    view.answer()
    view.edit({ intensity: 0.37 })
    expect(lastGraph()).toEqual(planGraph(view.params()))
    view.answer()
    // Another accepted contract on the same bytes is another LUT.
    view.edit({ lut: sceneLut })
    expect(lastGraph()?.lutProfile?.id).toBe('test-scene-look')
    view.answer()
    view.edit({ lut: refusedLut })
    expect(view.renders()).toHaveLength(5)
    expect(lastGraph()).toEqual(planGraph(view.params()))
    expect(lastGraph()?.lutProfile).toBeNull()
  })
})
