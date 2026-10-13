import type {
  ColorGraphIntent,
  LUTData,
  PreviewHistogramState,
} from '@lumaforge/luma-color-runtime'
import {
  NEUTRAL_SELECTIVE_COLOR,
  NEUTRAL_USER_COLOR_INTENT,
} from '@lumaforge/luma-color-runtime'
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { DecodedPreviewFrame } from '~/lib/preview/preview-frame'
import type { DecodedImage, DecodedImageSource } from '~/lib/raw/decoder'

import { createTestDecodedImage } from '../test-support/builders'
import {
  HISTOGRAM_BUSY_SHARE_DENOMINATOR,
  HISTOGRAM_SETTLE_MS,
  HISTOGRAM_THROTTLE_MS,
  SCRUB_HISTOGRAM_SAMPLED_PIXELS,
  usePreviewHistogram,
} from './usePreviewHistogram'

// Every processor the hook creates, in order, and every band it was fed:
// a band fed to anything but the newest processor means two runs
// interleaved.
const tracker = vi.hoisted(() => ({
  created: [] as { finished: boolean }[],
  interleaved: false,
  // Every color graph the hook resolved, by the user exposure it was for.
  graphs: [] as (number | undefined)[],
  // The main-thread clock the hook reads: it moves only by what each
  // sampled row costs, so a chunk's busy time never depends on the host.
  clock: 0,
  rowCostMs: 0,
  rowsFed: 0,
}))

vi.mock('@lumaforge/luma-color-runtime', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@lumaforge/luma-color-runtime')>()
  return {
    ...actual,
    resolveExportColorGraph: (
      input: Parameters<typeof actual.resolveExportColorGraph>[0],
    ) => {
      tracker.graphs.push(input.userExposureEv)
      return actual.resolveExportColorGraph(input)
    },
    createPreviewHistogramProcessor: (
      input: Parameters<typeof actual.createPreviewHistogramProcessor>[0],
    ) => {
      const processor = actual.createPreviewHistogramProcessor(input)
      const entry = { finished: false }
      tracker.created.push(entry)
      return {
        ...processor,
        processUint16Rows: (
          ...args: Parameters<typeof processor.processUint16Rows>
        ) => {
          if (tracker.created.at(-1) !== entry) tracker.interleaved = true
          tracker.rowsFed += args[1]
          tracker.clock += args[1] * tracker.rowCostMs
          return processor.processUint16Rows(...args)
        },
        finish: (...args: Parameters<typeof processor.finish>) => {
          entry.finished = true
          return processor.finish(...args)
        },
      }
    },
  }
})

type HookInput = Parameters<typeof usePreviewHistogram>[0]
type Ready = Extract<PreviewHistogramState, { state: 'ready' }>

const baseParams: ColorGraphIntent = {
  ...NEUTRAL_USER_COLOR_INTENT,
  intensity: 0.7,
  styleKind: 'none',
  builtinPreset: null,
}

// Non-neutral user color, so a measure that drops it shows.
const adjusted: ColorGraphIntent = {
  ...baseParams,
  styleKind: 'custom',
  userExposureEv: 1,
  userContrast: 30,
  userSaturation: 20,
}

/**
 * Varied RGB16, 1000 wide: 501 rows are past the full sample budget and two
 * bands at the scrub budget.
 */
function frameImage(
  source: DecodedImageSource = 'quick',
  { height = 501, seed = 0 } = {},
): DecodedImage {
  const image = createTestDecodedImage({ width: 1000, height, source })
  for (let index = 0; index < image.data.length; index += 1) {
    image.data[index] = (index * 2654435761 + seed) & 0xFFFF
  }
  return image
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

/** The LUT under a contract export refuses: unconfirmed. */
function refusedLut(lut = createLutData()): LUTData {
  return { ...lut, profileResolution: { kind: 'unknown' } }
}

let frameSequence = 0

/** Plays the frame producer: every accepted frame gets a new identity. */
function acceptFrame(
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

/** Renders the hook; `update` rerenders with the input merged in. */
function renderHistogram({
  image = frameImage(),
  ...initial
}: Partial<HookInput> & { image?: DecodedImage | null } = {}) {
  const imageRef = { current: image }
  let input: HookInput = {
    imageRef,
    frame: image ? acceptFrame(image) : null,
    params: baseParams,
    lutData: null,
    displaySource: 'quick',
    ...initial,
  }
  const states: PreviewHistogramState[] = []
  const hook = renderHook(
    (current: HookInput) => {
      const state = usePreviewHistogram(current)
      states.push(state)
      return state
    },
    { initialProps: input },
  )
  const update = (next: Partial<HookInput>) => {
    input = { ...input, ...next }
    hook.rerender(input)
  }
  /**
   * Puts a newly accepted frame in the ref and returns its input; a
   * bounded-HQ frame names the quick frame it replaces.
   */
  const showFrame = (
    next: DecodedImage,
    frame: Partial<DecodedPreviewFrame> = {},
  ): Partial<HookInput> => {
    const replaced = input.frame
    imageRef.current = next
    return {
      frame: acceptFrame(next, {
        quickPredecessorFrameId:
          next.source === 'bounded-hq' && replaced?.stage === 'quick'
            ? replaced.frameId
            : null,
        ...frame,
      }),
      displaySource: next.source ?? input.displaySource,
    }
  }
  return {
    result: hook.result,
    states,
    unmount: hook.unmount,
    update,
    showFrame,
    accept: (next: DecodedImage) => update(showFrame(next)),
    setParams: (change: Partial<ColorGraphIntent>) =>
      update({ params: { ...input.params, ...change } }),
  }
}

type HistogramView = ReturnType<typeof renderHistogram>

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}

/** Runs every queued run and refinement to the end. */
async function runAll() {
  await act(async () => {
    await vi.runAllTimersAsync()
  })
}

/** Advances a millisecond at a time until a result other than `previous` lands. */
async function nextReady(
  view: HistogramView,
  previous?: PreviewHistogramState,
) {
  for (let i = 0; i < 256; i += 1) {
    const current = view.result.current
    if (current.state === 'ready' && current !== previous) return current
    await advance(1)
  }
  throw new Error(`never ready: ${view.result.current.state}`)
}

/** The first run has landed and an interval has passed since it started. */
async function settledView(input?: Parameters<typeof renderHistogram>[0]) {
  const view = renderHistogram(input)
  const first = await nextReady(view)
  await advance(HISTOGRAM_THROTTLE_MS)
  return { view, first }
}

function measure(state: PreviewHistogramState) {
  if (state.state !== 'ready') throw new Error(`not ready: ${state.state}`)
  return { bins: state.bins, clipping: state.clipping }
}

async function settledMeasure(input: Partial<HookInput>) {
  const view = renderHistogram({ image: frameImage(), ...input })
  await runAll()
  return measure(view.result.current)
}

describe('usePreviewHistogram', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    tracker.created.length = 0
    tracker.interleaved = false
    tracker.graphs.length = 0
    tracker.clock = 0
    tracker.rowCostMs = 0
    tracker.rowsFed = 0
    vi.spyOn(performance, 'now').mockImplementation(() => tracker.clock)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  describe('what it measures', () => {
    it.each<
      [string, Parameters<typeof renderHistogram>[0], PreviewHistogramState]
    >([
      [
        'an embedded-only preview',
        { image: null, displaySource: 'embedded' },
        { state: 'unavailable', reason: 'embedded-only' },
      ],
      [
        'pixels the workflow has not accepted',
        { frame: null },
        { state: 'unavailable', reason: 'no-image' },
      ],
      [
        'preview data of the wrong length',
        {
          image: createTestDecodedImage({
            width: 800,
            height: 600,
            data: new Uint16Array(3),
          }),
        },
        {
          state: 'unsupported',
          reason:
            'Preview histogram requires RGB16 Linear ProPhoto preview data.',
        },
      ],
      [
        'a built-in style the preview draws, at any strength',
        {
          params: {
            ...adjusted,
            styleKind: 'builtin',
            builtinPreset: 'cinematic',
          },
        },
        {
          state: 'unsupported',
          reason: 'The histogram does not measure built-in styles.',
        },
      ],
    ])('measures nothing for %s', async (_case, input, expected) => {
      const view = renderHistogram(input)
      expect(view.result.current).toEqual(expected)
      for (const intensity of [0, 0.37, 1]) {
        view.setParams({ intensity })
        await runAll()
        expect(view.result.current).toEqual(expected)
      }
      expect(tracker.created).toHaveLength(0)
    })

    it('measures the adjusted preview without a look export refuses', async () => {
      const refused = await settledMeasure({
        params: adjusted,
        lutData: refusedLut(),
      })

      expect(refused).toEqual(
        await settledMeasure({ params: { ...adjusted, styleKind: 'none' } }),
      )
      expect(refused).not.toEqual(await settledMeasure({ params: baseParams }))
    })

    it.each([
      ['a LUT export refuses', refusedLut()],
      ['a LUT that has not loaded', null],
    ])(
      'keeps the measure while the strength of %s moves',
      async (_case, lutData) => {
        const view = renderHistogram({ params: adjusted, lutData })
        await runAll()
        const ready = view.result.current
        expect(ready.state).toBe('ready')

        for (const intensity of [0, 0.37, 1]) {
          view.setParams({ intensity })
          expect(view.result.current).toBe(ready)
          expect(vi.getTimerCount()).toBe(0)
        }
      },
    )

    it('keys the drawn LUT by its record, so a contract on the same bytes runs again', async () => {
      const view = renderHistogram({ params: adjusted, lutData: refusedLut() })
      await runAll()
      const stripped = measure(view.result.current)

      const accepted = createLutData()
      view.update({ lutData: accepted })
      expect(view.result.current.state).toBe('stale')
      await runAll()
      const withLook = view.result.current
      expect(measure(withLook)).not.toEqual(stripped)

      view.update({ lutData: createLutData('test-vlog-other') })
      expect(view.result.current).toEqual({
        state: 'stale',
        previous: withLook,
      })

      view.update({ lutData: refusedLut(accepted) })
      await runAll()
      expect(measure(view.result.current)).toEqual(stripped)
    })

    it('restarts and resolves nothing for an owner rerender or an equal intent rebuilt upstream', async () => {
      const params: ColorGraphIntent = {
        ...baseParams,
        selectiveColor: {
          ...NEUTRAL_SELECTIVE_COLOR,
          red: { hue: 12, saturation: -8, lightness: 4 },
        },
      }
      const view = renderHistogram({ params })
      await runAll()
      const ready = view.result.current
      const graphs = tracker.graphs.length
      const created = tracker.created.length

      view.update({})
      view.update({ params: structuredClone(params) })
      expect(view.result.current).toBe(ready)
      expect(vi.getTimerCount()).toBe(0)
      expect(tracker.graphs).toHaveLength(graphs)
      expect(tracker.created).toHaveLength(created)
    })
  })

  describe('frames', () => {
    it('computes the first quick histogram at once, at the full budget', async () => {
      const view = renderHistogram()
      expect(view.result.current).toEqual({
        state: 'computing',
        previous: null,
      })

      await advance(5)
      const ready = view.result.current
      expect(ready).toMatchObject({
        state: 'ready',
        source: 'quick',
        totalPixels: 1000 * 501,
      })
      expect((ready as Ready).sampledPixels).toBeGreaterThan(
        SCRUB_HISTOGRAM_SAMPLED_PIXELS,
      )
    })

    it.each<
      [string, Partial<ColorGraphIntent>, Partial<DecodedPreviewFrame>, boolean]
    >([
      [
        'shows the first quick histogram until the bounded-HQ frame that names it lands',
        {},
        {},
        true,
      ],
      [
        'drops the first quick run when the look changes with the bounded-HQ frame',
        { userHighlights: -40 },
        {},
        false,
      ],
      [
        'drops the first quick run for a bounded-HQ frame that names no quick predecessor',
        {},
        { quickPredecessorFrameId: null },
        false,
      ],
    ])('%s', async (_case, look, frame, quickShown) => {
      const view = renderHistogram()
      view.update({
        ...view.showFrame(frameImage('bounded-hq', { height: 1001 }), frame),
        params: { ...baseParams, ...look },
      })

      let sawQuick = false
      while (
        view.result.current.state !== 'ready' ||
        view.result.current.source !== 'bounded-hq'
      ) {
        const ready = await nextReady(view, view.result.current)
        sawQuick ||= ready.source === 'quick'
      }
      expect(sawQuick).toBe(quickShown)
    })

    it('shows the quick bins, stale, until the bounded-HQ frame replacing them lands', async () => {
      const view = renderHistogram()
      await runAll()
      const quick = view.result.current

      view.accept(frameImage('bounded-hq'))
      expect(view.result.current).toEqual({ state: 'stale', previous: quick })
      await runAll()
      expect(view.result.current).toMatchObject({
        state: 'ready',
        source: 'bounded-hq',
      })
    })

    it('measures a replacing source of identical size, never the old run landing late', async () => {
      const replacing = frameImage('quick', { seed: 7 })
      const reference = renderHistogram({ image: replacing })
      await runAll()
      const expected = measure(reference.result.current)
      reference.unmount()

      // Both producers numbered their first frame alike: only the session
      // tells the replacing source apart.
      const view = renderHistogram({
        frame: acceptFrame(frameImage(), {
          sessionId: 'session-old',
          frameId: 'decoded-frame-1',
        }),
      })
      // The old source's first run is under way, chunked, when it is replaced.
      await advance(0)
      expect(view.result.current).toEqual({
        state: 'computing',
        previous: null,
      })

      const replacedAt = view.states.length
      view.update({
        ...view.showFrame(replacing),
        frame: acceptFrame(replacing, {
          sessionId: 'session-new',
          frameId: 'decoded-frame-1',
        }),
      })
      await runAll()

      const after = view.states.slice(replacedAt)
      for (const state of after) {
        if (state.state === 'ready') expect(measure(state)).toEqual(expected)
        if (state.state === 'stale') expect(state.previous).toBeNull()
      }
      expect(measure(view.result.current)).toEqual(expected)
    })
  })

  describe('scrub scheduling', () => {
    it.each<
      [string, Parameters<typeof renderHistogram>[0], Partial<ColorGraphIntent>]
    >([
      ['temperature', {}, { userTemperature: 25 }],
      ['saturation', {}, { userSaturation: 25 }],
      ['vibrance', {}, { userVibrance: 25 }],
      [
        'a drawn look strength between the detents',
        {
          params: { ...baseParams, styleKind: 'custom' },
          lutData: createLutData(),
        },
        { intensity: 0.37 },
      ],
    ])(
      'answers a %s change at once, keeping the bins stale until it lands',
      async (_change, initial, change) => {
        const { view, first } = await settledView(initial)

        view.setParams(change)
        expect(view.result.current).toEqual({ state: 'stale', previous: first })
        // Leading edge: two bands at the scrub budget, a macrotask apiece.
        await advance(2)
        expect(view.result.current.state).toBe('ready')
        expect(view.result.current).not.toBe(first)
      },
    )

    it('keeps feedback live through a continuous scrub, at most one run per interval', async () => {
      const { view, first } = await settledView()
      const createdBefore = tracker.created.length

      const landed = new Set<unknown>([first])
      // A finger moving for 900ms, one change per frame.
      for (let frame = 1; frame <= 56; frame += 1) {
        view.setParams({ userExposureEv: frame / 100 })
        await advance(16)
        const current = view.result.current
        landed.add(
          current.state === 'ready'
            ? current
            : current.state === 'stale'
              ? current.previous
              : null,
        )
      }

      expect(landed.size - 1).toBeGreaterThanOrEqual(5)
      expect(tracker.created.length - createdBefore).toBeLessThanOrEqual(
        Math.ceil(900 / HISTOGRAM_THROTTLE_MS) + 1,
      )
      expect(tracker.interleaved).toBe(false)

      // The run after the scrub is for the last params, and it is ready.
      await advance(HISTOGRAM_THROTTLE_MS)
      expect(view.result.current.state).toBe('ready')
    })

    it.each([
      ['the first full run', async () => renderHistogram()],
      [
        'a scrub run',
        async () => {
          const { view } = await settledView()
          view.setParams({ userExposureEv: 0.1 })
          return view
        },
      ],
    ])(
      'lets %s caught mid-way finish, then runs once for the latest params',
      async (_run, start) => {
        const view = await start()
        // The run has done its first chunk and is still going...
        await advance(0)
        const running = tracker.created.at(-1)!
        const created = tracker.created.length
        expect(running.finished).toBe(false)

        // ...while more changes arrive before it finishes.
        view.setParams({ userExposureEv: 0.2 })
        view.setParams({ userExposureEv: 0.3 })
        for (let i = 0; i < 8 && !running.finished; i += 1) await advance(1)
        // It ran to the end and shows, marked stale, while the latest waits.
        expect(running.finished).toBe(true)
        expect(view.result.current.state).toBe('stale')

        await advance(HISTOGRAM_THROTTLE_MS)
        expect(tracker.created).toHaveLength(created + 1)
        expect(tracker.interleaved).toBe(false)
        expect(view.result.current.state).toBe('ready')
      },
    )

    it('samples less during a scrub and refines at the full budget once input settles', async () => {
      const { view, first } = await settledView()

      view.setParams({ userExposureEv: 0.5 })
      const coarse = await nextReady(view, first)
      expect(coarse.sampledPixels).toBeLessThanOrEqual(
        SCRUB_HISTOGRAM_SAMPLED_PIXELS,
      )
      expect(coarse.sampledPixels).toBeLessThan(first.sampledPixels)

      // Quiet for the settle time: a full-budget pass replaces it, without
      // ever announcing itself as computing.
      await advance(HISTOGRAM_SETTLE_MS - 1)
      expect(view.result.current).toBe(coarse)
      for (let i = 0; i < 64 && view.result.current === coarse; i += 1) {
        await advance(1)
        expect(view.result.current.state).not.toBe('computing')
      }
      expect(view.result.current).toMatchObject({
        state: 'ready',
        sampledPixels: first.sampledPixels,
      })
    })

    it('stretches the interval so a slow run keeps the main thread mostly free', async () => {
      const { view, first } = await settledView()

      // Every sampled row of the next run costs 1.25ms of main thread: its
      // chunks yield on their time budget, and their busy time adds up.
      const rowCostMs = 1.25
      tracker.rowCostMs = rowCostMs
      view.setParams({ userExposureEv: 0.5 })
      const coarse = await nextReady(view, first)
      // About 40 rows, 50ms busy: past 150 / 6, so the interval becomes ~300ms.
      const intervalMs =
        (coarse.sampledPixels / 1000) *
        rowCostMs *
        HISTOGRAM_BUSY_SHARE_DENOMINATOR
      expect(intervalMs).toBeGreaterThan(HISTOGRAM_THROTTLE_MS)

      view.setParams({ userExposureEv: 0.6 })
      const created = tracker.created.length
      await advance(intervalMs - 20)
      expect(tracker.created).toHaveLength(created)
      expect(view.result.current.state).toBe('stale')
      await advance(20)
      expect(tracker.created).toHaveLength(created + 1)
    })

    it('yields mid-band once a chunk has spent its time budget', async () => {
      const { view, first } = await settledView()

      // 2ms a row: a 32-row band would hold the main thread for 64ms.
      tracker.rowCostMs = 2
      const fedBefore = tracker.rowsFed
      view.setParams({ userExposureEv: 0.5 })
      await advance(0)
      const firstChunk = tracker.rowsFed - fedBefore
      expect(firstChunk).toBeGreaterThan(0)
      expect(firstChunk).toBeLessThan(32)
      expect(view.result.current).toEqual({ state: 'stale', previous: first })

      await nextReady(view, first)
      expect(tracker.interleaved).toBe(false)
    })
  })

  describe('visibility and release', () => {
    it('resolves no graph and schedules nothing while no surface shows it', async () => {
      const view = renderHistogram({ enabled: false })
      const image = frameImage()
      for (let step = 1; step <= 6; step += 1) {
        view.setParams({ userExposureEv: step / 10 })
        view.accept(image)
        await advance(16)
      }
      await advance(HISTOGRAM_THROTTLE_MS + HISTOGRAM_SETTLE_MS)

      expect(view.result.current).toEqual({
        state: 'unsupported',
        reason: 'No surface shows the preview histogram.',
      })
      expect(tracker.graphs).toHaveLength(0)
      expect(tracker.created).toHaveLength(0)
      expect(vi.getTimerCount()).toBe(0)
    })

    it('clears every queued run and refinement once it is hidden mid-scrub', async () => {
      const { view } = await settledView()
      // A scrub run lands and queues its refinement, then a change inside the
      // interval queues a trailing run.
      view.setParams({ userExposureEv: 0.5 })
      await advance(2)
      view.setParams({ userExposureEv: 0.6 })
      expect(vi.getTimerCount()).toBeGreaterThan(0)
      const created = tracker.created.length

      view.update({ enabled: false })
      expect(vi.getTimerCount()).toBe(0)
      await advance(HISTOGRAM_THROTTLE_MS + HISTOGRAM_SETTLE_MS)
      expect(tracker.created).toHaveLength(created)
      expect(view.result.current.state).toBe('unsupported')
    })

    it('computes the latest params once, at the full budget, when it is shown again', async () => {
      const view = renderHistogram()
      await nextReady(view)
      view.update({ enabled: false })
      view.setParams({ userExposureEv: 0.3 })
      view.setParams({ userExposureEv: 0.6 })
      await advance(HISTOGRAM_THROTTLE_MS)
      const graphs = tracker.graphs.length
      const created = tracker.created.length

      view.update({ enabled: true })
      expect(tracker.graphs.slice(graphs)).toEqual([0.6])
      expect(view.result.current).toEqual({
        state: 'computing',
        previous: null,
      })
      const ready = await nextReady(view)
      expect(ready.sampledPixels).toBeGreaterThan(
        SCRUB_HISTOGRAM_SAMPLED_PIXELS,
      )
      expect(tracker.created).toHaveLength(created + 1)
    })

    it('drops a pending run when the hook unmounts', async () => {
      const view = renderHistogram()
      await nextReady(view)
      view.setParams({ userExposureEv: 0.5 })
      view.unmount()
      const created = tracker.created.length
      await advance(HISTOGRAM_THROTTLE_MS * 2)
      expect(tracker.created).toHaveLength(created)
    })
  })
})
