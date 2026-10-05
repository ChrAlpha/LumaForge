import type {
  PreviewHistogramState,
  ProcessingParams,
} from '@lumaforge/luma-color-runtime'
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { DecodedImage } from '~/lib/raw/decoder'

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
  created: [] as { id: number; finished: boolean }[],
  interleaved: false,
}))

vi.mock('@lumaforge/luma-color-runtime', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@lumaforge/luma-color-runtime')>()
  return {
    ...actual,
    createPreviewHistogramProcessor: (
      input: Parameters<typeof actual.createPreviewHistogramProcessor>[0],
    ) => {
      const processor = actual.createPreviewHistogramProcessor(input)
      const entry = { id: tracker.created.length, finished: false }
      tracker.created.push(entry)
      return {
        ...processor,
        processUint16Rows: (
          ...args: Parameters<typeof processor.processUint16Rows>
        ) => {
          if (tracker.created.at(-1) !== entry) tracker.interleaved = true
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

const baseParams: ProcessingParams = {
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

/** 1000 x 501: past the full budget, and two bands at the scrub budget. */
function largeImage(): DecodedImage {
  const width = 1000
  const height = 501
  const data = new Uint16Array(width * height * 3)
  for (let index = 0; index < data.length; index += 1) {
    data[index] = (index * 2654435761) & 0xFFFF
  }
  return {
    width,
    height,
    channels: 3,
    bitsPerChannel: 16,
    data,
    layout: 'rgb-u16',
    colorSpace: 'linear-prophoto-rgb',
    source: 'quick',
    metadata: { width, height },
    renderExposure: { ev: 0, multiplier: 1, source: 'identity' },
  }
}

function setup(image: DecodedImage = largeImage()) {
  const imageRef = { current: image as DecodedImage | null }
  const lutDataRef = { current: null }
  const props = (exposure: number) => ({
    imageRef,
    imageVersion: 1,
    params: { ...baseParams, userExposureEv: exposure },
    lutDataRef,
    lutDataVersion: 0,
    displaySource: 'quick' as const,
  })
  const hook = renderHook(
    (current: ReturnType<typeof props>) => usePreviewHistogram(current),
    { initialProps: props(0) },
  )
  return {
    result: hook.result,
    setExposure: (exposure: number) => hook.rerender(props(exposure)),
    unmount: hook.unmount,
  }
}

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}

async function settleFirstRun(
  result: ReturnType<typeof setup>['result'],
): Promise<Extract<PreviewHistogramState, { state: 'ready' }>> {
  for (let i = 0; i < 64 && result.current.state !== 'ready'; i += 1) {
    await advance(1)
  }
  const ready = result.current
  if (ready.state !== 'ready') throw new Error('first run never landed')
  return ready
}

function bins(state: PreviewHistogramState) {
  if (state.state === 'ready') return state
  if (state.state === 'stale' || state.state === 'computing') {
    return state.previous
  }
  return null
}

describe('usePreviewHistogram throttle', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    tracker.created.length = 0
    tracker.interleaved = false
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('answers a change at once when the last run started an interval ago', async () => {
    const { result, setExposure } = setup()
    const first = await settleFirstRun(result)
    await advance(HISTOGRAM_THROTTLE_MS)

    setExposure(0.5)
    expect(result.current).toEqual({ state: 'stale', previous: first })
    // Leading edge: two bands at the scrub budget, a macrotask apiece.
    await advance(2)
    expect(result.current.state).toBe('ready')
    expect(result.current).not.toBe(first)
  })

  it('keeps feedback live through a continuous scrub, at most one run per interval', async () => {
    const { result, setExposure } = setup()
    const first = await settleFirstRun(result)
    await advance(HISTOGRAM_THROTTLE_MS)
    const createdBefore = tracker.created.length

    const landed = new Set<unknown>([first])
    // A finger moving for 900ms, one change per frame.
    for (let frame = 1; frame <= 56; frame += 1) {
      setExposure(frame / 100)
      await advance(16)
      const current = bins(result.current)
      if (current) landed.add(current)
    }

    // The old trailing debounce answered only after the scrub stopped;
    // the throttle lands a histogram every interval while it moves.
    const runs = tracker.created.length - createdBefore
    expect(landed.size - 1).toBeGreaterThanOrEqual(5)
    expect(runs).toBeLessThanOrEqual(Math.ceil(900 / HISTOGRAM_THROTTLE_MS) + 1)
    expect(tracker.interleaved).toBe(false)

    // The run after the scrub is for the last params, and it is ready.
    await advance(HISTOGRAM_THROTTLE_MS)
    expect(result.current.state).toBe('ready')
  })

  it('lets a run finish, then skips straight to the latest params', async () => {
    const { result, setExposure } = setup()
    await settleFirstRun(result)
    await advance(HISTOGRAM_THROTTLE_MS)

    setExposure(0.1)
    // The leading run starts and does its first band...
    await advance(0)
    const createdAfterLead = tracker.created.length
    // ...while three more changes arrive before it finishes.
    setExposure(0.2)
    setExposure(0.3)
    setExposure(0.4)
    await advance(1)
    // It finished rather than being cancelled, and lags the latest params.
    expect(tracker.created.at(-1)?.finished).toBe(true)
    expect(result.current.state).toBe('stale')

    await advance(HISTOGRAM_THROTTLE_MS)
    // One run for the three changes, never two at once.
    expect(tracker.created.length).toBe(createdAfterLead + 1)
    expect(tracker.interleaved).toBe(false)
    expect(result.current.state).toBe('ready')
  })

  it('does not restart a first full run that a scrub catches mid-way', async () => {
    const { result, setExposure } = setup()
    // The first run has done its first chunk and is still going.
    await advance(0)
    expect(tracker.created).toHaveLength(1)
    expect(tracker.created[0]?.finished).toBe(false)

    setExposure(0.2)
    setExposure(0.3)
    for (let i = 0; i < 8 && !tracker.created[0]?.finished; i += 1) {
      await advance(1)
    }
    // It ran to the end and shows, marked stale, while the latest runs.
    expect(tracker.created[0]?.finished).toBe(true)
    expect(result.current.state).toBe('stale')
    await advance(HISTOGRAM_THROTTLE_MS)
    expect(tracker.created).toHaveLength(2)
    expect(tracker.interleaved).toBe(false)
    expect(result.current.state).toBe('ready')
  })

  it('samples less during a scrub and refines at the full budget once input settles', async () => {
    const { result, setExposure } = setup()
    const first = await settleFirstRun(result)
    await advance(HISTOGRAM_THROTTLE_MS)

    setExposure(0.5)
    await advance(2)
    const coarse = result.current
    expect(coarse.state).toBe('ready')
    if (coarse.state !== 'ready') return
    expect(coarse.sampledPixels).toBeLessThanOrEqual(
      SCRUB_HISTOGRAM_SAMPLED_PIXELS,
    )
    expect(coarse.sampledPixels).toBeLessThan(first.sampledPixels)

    // Quiet for the settle time: a full-budget pass replaces it, without
    // ever announcing itself as computing.
    await advance(HISTOGRAM_SETTLE_MS - 1)
    expect(result.current).toBe(coarse)
    for (let i = 0; i < 64 && result.current === coarse; i += 1) {
      await advance(1)
      expect(result.current.state).not.toBe('computing')
    }
    expect(result.current).toMatchObject({
      state: 'ready',
      sampledPixels: first.sampledPixels,
    })
  })

  it('stretches the interval so a slow run keeps the main thread mostly free', async () => {
    const { result, setExposure } = setup()
    await settleFirstRun(result)
    await advance(HISTOGRAM_THROTTLE_MS)

    // Every band of the next run reads as 25ms of busy main thread (the
    // clock moves 25ms between a band's start and end reads).
    let clock = 0
    vi.spyOn(performance, 'now').mockImplementation(() => {
      clock += 25
      return clock
    })
    setExposure(0.5)
    await advance(2)
    expect(result.current.state).toBe('ready')
    // Two bands, 50ms busy: past 150 / 6, so the interval becomes 300ms.
    const busyMs = 2 * 25
    const intervalMs = busyMs * HISTOGRAM_BUSY_SHARE_DENOMINATOR
    expect(intervalMs).toBeGreaterThan(HISTOGRAM_THROTTLE_MS)

    setExposure(0.6)
    const created = tracker.created.length
    await advance(intervalMs - 20)
    expect(tracker.created.length).toBe(created)
    expect(result.current.state).toBe('stale')
    await advance(20)
    expect(tracker.created.length).toBe(created + 1)
  })

  it('drops a pending run when the hook unmounts', async () => {
    const { result, setExposure, unmount } = setup()
    await settleFirstRun(result)
    setExposure(0.5)
    unmount()
    const created = tracker.created.length
    await advance(HISTOGRAM_THROTTLE_MS * 2)
    expect(tracker.created.length).toBe(created)
  })
})
