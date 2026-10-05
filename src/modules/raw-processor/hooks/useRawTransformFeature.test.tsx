import type { ExportGeometry } from '@lumaforge/render-engine/export'
import { act, renderHook } from '@testing-library/react'
import { useCallback, useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { identityMatrix } from '~/modules/transform-demo/geometry/matrix'
import type { UprightAnalysis } from '~/modules/transform-demo/geometry/types'
import type { PreviewSource } from '~/modules/transform-demo/preview-types'
import { NEUTRAL_TRANSFORM } from '~/modules/transform-demo/transform-types'
import type {
  TransformWorkerRequest,
  TransformWorkerResponse,
} from '~/modules/transform-demo/worker-protocol'

import { captureTransformSource } from '../services/preview/capture-transform-source'
import { useRawTransformFeature } from './useRawTransformFeature'
import type { UseRawWorkflowReturn } from './useRawWorkflow.types'

vi.mock(
  '../services/preview/capture-transform-source',
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import('../services/preview/capture-transform-source')
    >()),
    captureTransformSource: vi.fn(),
  }),
)

class FakeWorker {
  static instances: FakeWorker[] = []
  onmessage: ((event: MessageEvent<TransformWorkerResponse>) => void) | null =
    null
  onerror: (() => void) | null = null
  messages: TransformWorkerRequest[] = []
  terminated = false
  constructor() {
    FakeWorker.instances.push(this)
  }
  postMessage(message: TransformWorkerRequest) {
    this.messages.push(message)
  }
  terminate() {
    this.terminated = true
  }
  emit(data: TransformWorkerResponse) {
    this.onmessage?.({ data } as MessageEvent<TransformWorkerResponse>)
  }
}

type RenderRequest = Extract<TransformWorkerRequest, { type: 'render' }>

const solution = {
  matrix: identityMatrix(),
  confidence: 0.8,
  status: 'corrected' as const,
  reason: '',
  rotationDegrees: 0,
}
const analysis: UprightAnalysis = {
  lines: [],
  solutions: {
    off: solution,
    auto: solution,
    level: solution,
    vertical: solution,
    full: solution,
  },
}

function worker() {
  const live = FakeWorker.instances.at(-1)
  if (!live) throw new Error('expected a worker')
  return live
}

function lastRender(): RenderRequest {
  const request = worker().messages.findLast(
    (message) => message.type === 'render',
  )
  if (request?.type !== 'render') throw new Error('expected render')
  return request
}

function analyzeCapture() {
  const request = worker().messages.findLast(
    (message) => message.type === 'analyze',
  )
  if (!request) throw new Error('expected analyze')
  act(() =>
    worker().emit({
      type: 'analyzed',
      sourceId: request.sourceId,
      analysis,
      elapsedMs: 1,
    }),
  )
}

function answer(request: RenderRequest) {
  act(() =>
    worker().emit({
      type: 'rendered',
      sourceId: request.sourceId,
      requestId: request.requestId,
      result: {
        frame: { width: 80, height: 60, data: new Uint8ClampedArray(19200) },
        displayMatrix: request.matrix,
        retainedArea: 1,
      },
    }),
  )
}

function refuse(request: RenderRequest) {
  act(() =>
    worker().emit({
      type: 'error',
      sourceId: request.sourceId,
      requestId: request.requestId,
      message: 'invalid-transform',
    }),
  )
}

function geometryOf(request: RenderRequest): ExportGeometry {
  return {
    matrix: Array.from(request.matrix),
    constrainCrop: request.constrainCrop,
  }
}

function workflow(): UseRawWorkflowReturn {
  return {
    hasImage: true,
    sourceFileName: 'current.nef',
    status: 'ready',
    decodedImageVersion: 1,
    lutDataVersion: 1,
    decodedImageRef: { current: { width: 80, height: 60 } },
    pipelineRef: { current: {} },
    params: { viewMode: 'processed', compareSplit: 0.5, userExposureEv: 0 },
    previewTransform: {
      sourceId: 'one',
      active: false,
      geometry: null,
      commit: vi.fn(),
    },
    setViewMode: vi.fn(),
  } as unknown as UseRawWorkflowReturn
}

const image = { width: 80, height: 60 }
const pipelineRef = { current: {} }
const setViewMode = vi.fn()
const commits =
  vi.fn<(session: string, geometry: ExportGeometry | null) => void>()

interface SessionInput {
  session?: string
  decodedImageVersion?: number
  userExposureEv?: number
  /** A finished export released the preview. */
  released?: boolean
}

/**
 * The workflow side of the contract: one committed geometry per RAW
 * session, changed only through `commit`, as the session reducer does.
 */
function useSessionHarness({
  session = 'one',
  decodedImageVersion = 1,
  userExposureEv = 0,
  released = false,
}: SessionInput) {
  const [geometries, setGeometries] = useState<
    Record<string, ExportGeometry | null>
  >({})
  const geometry = geometries[session] ?? null
  const commit = useCallback(
    (next: ExportGeometry | null) => {
      commits(session, next)
      setGeometries((previous) => ({ ...previous, [session]: next }))
    },
    [session],
  )
  const feature = useRawTransformFeature(
    {
      hasImage: true,
      sourceFileName: 'current.nef',
      status: 'ready',
      decodedImageVersion,
      lutDataVersion: 1,
      decodedImageRef: { current: released ? null : image },
      pipelineRef,
      params: { viewMode: 'processed', compareSplit: 0.5, userExposureEv },
      previewSuspended: released,
      previewTransform: {
        sourceId: session,
        active: Boolean(geometry),
        geometry,
        commit,
      },
      setViewMode,
    } as unknown as UseRawWorkflowReturn,
    false,
  )
  return { feature, geometry }
}

function renderSession(initial: SessionInput = {}) {
  return renderHook((input: SessionInput) => useSessionHarness(input), {
    initialProps: initial,
  })
}

async function captureNeutral(
  hook: ReturnType<typeof renderSession>,
): Promise<() => void> {
  let stop!: () => void
  act(() => {
    stop = hook.result.current.feature.observe()
  })
  await act(() => vi.advanceTimersByTimeAsync(150))
  analyzeCapture()
  answer(lastRender())
  return stop
}

const frame: PreviewSource = {
  name: 'current.nef',
  kind: 'raw',
  originalWidth: 80,
  originalHeight: 60,
  frame: { width: 80, height: 60, data: new Uint8ClampedArray(80 * 60 * 4) },
}
beforeEach(() => {
  vi.useFakeTimers()
  FakeWorker.instances = []
  vi.stubGlobal('Worker', FakeWorker)
  vi.mocked(captureTransformSource).mockResolvedValue(frame)
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('rAW Transform feature', () => {
  it('clears transient geometry on leaving the workspace without invalidating neutral exports', () => {
    const active = workflow()
    active.previewTransform!.active = true
    const first = renderHook(() => useRawTransformFeature(active, false))
    first.unmount()
    expect(active.previewTransform!.commit).toHaveBeenCalledWith(null)
    const neutral = workflow()
    const second = renderHook(() => useRawTransformFeature(neutral, false))
    second.unmount()
    expect(neutral.previewTransform!.commit).not.toHaveBeenCalled()
  })

  it('captures on demand and refreshes color without reopening the photo or resetting geometry', async () => {
    const initial = workflow()
    const { result, rerender, unmount } = renderHook(
      ({ input }) => useRawTransformFeature(input, false),
      { initialProps: { input: initial } },
    )
    await act(() => vi.advanceTimersByTimeAsync(150))
    expect(captureTransformSource).not.toHaveBeenCalled()
    act(() => {
      result.current.observe()
    })
    await act(() => vi.advanceTimersByTimeAsync(150))
    expect(worker().messages.at(-1)).toEqual({
      type: 'analyze',
      sourceId: expect.any(Number),
      frame: frame.frame,
    })
    rerender({
      input: {
        ...initial,
        params: { ...initial.params, viewMode: 'compare', compareSplit: 0.2 },
      },
    })
    await act(() => vi.advanceTimersByTimeAsync(150))
    expect(captureTransformSource).toHaveBeenCalledTimes(1)
    act(() => result.current.setMode('vertical'))
    rerender({
      input: { ...initial, params: { ...initial.params, userExposureEv: 1 } },
    })
    await act(() => vi.advanceTimersByTimeAsync(150))
    expect(captureTransformSource).toHaveBeenCalledTimes(2)
    expect(
      worker().messages.filter((message) => message.type === 'analyze'),
    ).toHaveLength(2)
    expect(result.current.demo.mode).toBe('vertical')
    expect(initial.setViewMode).toHaveBeenCalledWith('processed')
    unmount()
  })

  it('commits a first Transform only once the preview renders it, and blocks export until then', async () => {
    const hook = renderSession()
    await captureNeutral(hook)
    // Opening Transform and analysing a neutral photo blocks nothing.
    expect(hook.result.current.feature.exportBlock).toBeNull()
    expect(commits).not.toHaveBeenCalled()

    act(() =>
      hook.result.current.feature.setManual({
        ...NEUTRAL_TRANSFORM,
        rotate: 3,
      }),
    )
    const first = lastRender()
    // Nothing is committed yet, so export must not run without the geometry.
    expect(commits).not.toHaveBeenCalled()
    expect(hook.result.current.feature.active).toBe(false)
    expect(hook.result.current.feature.exportBlock).toBe('pending')

    answer(first)
    expect(commits).toHaveBeenCalledOnce()
    expect(commits).toHaveBeenLastCalledWith('one', geometryOf(first))
    expect(hook.result.current.geometry).toEqual(geometryOf(first))
    expect(hook.result.current.feature.active).toBe(true)
    expect(hook.result.current.feature.exportBlock).toBeNull()
    hook.unmount()
  })

  it('keeps the last rendered geometry while a newer edit is pending or refused', async () => {
    const hook = renderSession()
    await captureNeutral(hook)
    act(() =>
      hook.result.current.feature.setManual({
        ...NEUTRAL_TRANSFORM,
        rotate: 3,
      }),
    )
    const a = lastRender()
    answer(a)
    expect(hook.result.current.geometry).toEqual(geometryOf(a))

    act(() =>
      hook.result.current.feature.setManual({
        ...NEUTRAL_TRANSFORM,
        rotate: 6,
      }),
    )
    const b = lastRender()
    expect(hook.result.current.geometry).toEqual(geometryOf(a))
    expect(hook.result.current.feature.exportBlock).toBe('pending')

    refuse(b)
    // The refused edit never reaches the session, and export says why.
    expect(commits).toHaveBeenCalledOnce()
    expect(hook.result.current.geometry).toEqual(geometryOf(a))
    expect(hook.result.current.feature.active).toBe(true)
    expect(hook.result.current.feature.exportBlock).toBe('invalid')

    // A valid edit restores export with its own geometry.
    act(() =>
      hook.result.current.feature.setManual({
        ...NEUTRAL_TRANSFORM,
        rotate: 4,
      }),
    )
    const c = lastRender()
    expect(hook.result.current.feature.exportBlock).not.toBeNull()
    answer(c)
    expect(commits).toHaveBeenLastCalledWith('one', geometryOf(c))
    expect(hook.result.current.feature.exportBlock).toBeNull()

    // A neutral reset clears the geometry straight away.
    act(() => hook.result.current.feature.reset())
    expect(commits).toHaveBeenLastCalledWith('one', null)
    expect(hook.result.current.geometry).toBeNull()
    expect(hook.result.current.feature.active).toBe(false)
    expect(hook.result.current.feature.exportBlock).toBeNull()
    hook.unmount()
  })

  it('commits only the newest answered request when answers arrive out of order', async () => {
    const hook = renderSession()
    await captureNeutral(hook)
    act(() =>
      hook.result.current.feature.setManual({
        ...NEUTRAL_TRANSFORM,
        rotate: 3,
      }),
    )
    const a = lastRender()
    // B queues behind A; A's answer lands after the controls moved on.
    act(() =>
      hook.result.current.feature.setManual({
        ...NEUTRAL_TRANSFORM,
        rotate: 5,
      }),
    )
    answer(a)
    expect(commits).not.toHaveBeenCalled()
    expect(hook.result.current.feature.exportBlock).toBe('pending')

    const b = lastRender()
    expect(b.requestId).toBeGreaterThan(a.requestId)
    answer(b)
    answer(a)
    expect(commits).toHaveBeenCalledOnce()
    expect(commits).toHaveBeenLastCalledWith('one', geometryOf(b))
    expect(hook.result.current.feature.exportBlock).toBeNull()
    hook.unmount()
  })

  it('never commits a rendered geometry the export engine cannot plan', async () => {
    const hook = renderSession()
    await captureNeutral(hook)
    // The worker answers, but this frame leaves too little of the photo.
    act(() =>
      hook.result.current.feature.setManual({
        ...NEUTRAL_TRANSFORM,
        scale: 50,
        offsetX: 30,
        offsetY: 30,
      }),
    )
    answer(lastRender())
    expect(commits).not.toHaveBeenCalled()
    expect(hook.result.current.feature.exportBlock).toBe('invalid')
    hook.unmount()
  })

  it('gives a new RAW its own commit even for the same geometry values', async () => {
    const hook = renderSession({ session: 'one' })
    const stop = await captureNeutral(hook)
    act(() =>
      hook.result.current.feature.setManual({
        ...NEUTRAL_TRANSFORM,
        rotate: 3,
      }),
    )
    const onFirst = lastRender()
    answer(onFirst)
    expect(commits).toHaveBeenLastCalledWith('one', geometryOf(onFirst))
    stop()

    hook.rerender({ session: 'two' })
    // The old photo's answer never lands on the new session.
    expect(commits).toHaveBeenCalledOnce()
    expect(hook.result.current.geometry).toBeNull()
    expect(hook.result.current.feature.demo.mode).toBe('off')
    expect(hook.result.current.feature.demo.manual).toEqual(NEUTRAL_TRANSFORM)
    expect(hook.result.current.feature.exportBlock).toBeNull()
    expect(worker().messages.at(-1)).toMatchObject({ type: 'clear' })

    await captureNeutral(hook)
    act(() =>
      hook.result.current.feature.setManual({
        ...NEUTRAL_TRANSFORM,
        rotate: 3,
      }),
    )
    const onSecond = lastRender()
    expect(onSecond.matrix).toEqual(onFirst.matrix)
    expect(commits).toHaveBeenCalledOnce()
    expect(hook.result.current.feature.exportBlock).toBe('pending')
    answer(onSecond)
    expect(commits).toHaveBeenCalledTimes(2)
    expect(commits).toHaveBeenLastCalledWith('two', geometryOf(onSecond))
    expect(hook.result.current.feature.exportBlock).toBeNull()
    hook.unmount()
  })

  it('holds export while a replacement frame re-renders the same geometry, without re-committing it', async () => {
    const hook = renderSession()
    await captureNeutral(hook)
    act(() =>
      hook.result.current.feature.setManual({
        ...NEUTRAL_TRANSFORM,
        rotate: 3,
      }),
    )
    const before = lastRender()
    answer(before)
    expect(commits).toHaveBeenCalledOnce()

    hook.rerender({ userExposureEv: 1 })
    await act(() => vi.advanceTimersByTimeAsync(150))
    expect(captureTransformSource).toHaveBeenCalledTimes(2)
    // The committed geometry stays, but the new frame has not answered yet.
    expect(hook.result.current.geometry).toEqual(geometryOf(before))
    expect(hook.result.current.feature.exportBlock).toBe('pending')
    answer(before)
    expect(hook.result.current.feature.exportBlock).toBe('pending')

    analyzeCapture()
    const after = lastRender()
    expect(after.sourceId).toBeGreaterThan(before.sourceId)
    answer(after)
    expect(hook.result.current.feature.exportBlock).toBeNull()
    // Same geometry: re-committing would discard the delivered export.
    expect(commits).toHaveBeenCalledOnce()
    hook.unmount()
  })

  it('blocks export from the moment the colour or HQ frame moves on until the new frame answers', async () => {
    const hook = renderSession()
    await captureNeutral(hook)
    act(() =>
      hook.result.current.feature.setManual({
        ...NEUTRAL_TRANSFORM,
        rotate: 3,
      }),
    )
    const a = lastRender()
    answer(a)
    expect(hook.result.current.feature.exportBlock).toBeNull()

    // The colour moved on: the frame that answered A is no longer the photo.
    hook.rerender({ userExposureEv: 1 })
    expect(hook.result.current.feature.exportBlock).toBe('pending')
    await act(() => vi.advanceTimersByTimeAsync(60))
    expect(captureTransformSource).toHaveBeenCalledOnce()
    expect(hook.result.current.feature.exportBlock).toBe('pending')
    await act(() => vi.advanceTimersByTimeAsync(90))
    analyzeCapture()
    answer(lastRender())
    expect(hook.result.current.feature.exportBlock).toBeNull()

    // So did the HQ decode.
    hook.rerender({ userExposureEv: 1, decodedImageVersion: 2 })
    expect(hook.result.current.feature.exportBlock).toBe('pending')
    await act(() => vi.advanceTimersByTimeAsync(60))
    expect(hook.result.current.feature.exportBlock).toBe('pending')
    await act(() => vi.advanceTimersByTimeAsync(90))
    analyzeCapture()
    answer(lastRender())
    expect(hook.result.current.feature.exportBlock).toBeNull()
    expect(commits).toHaveBeenCalledOnce()
    expect(hook.result.current.geometry).toEqual(geometryOf(a))
    hook.unmount()
  })

  it('blocks export as unavailable when the capture after a committed geometry fails', async () => {
    const hook = renderSession()
    await captureNeutral(hook)
    act(() =>
      hook.result.current.feature.setManual({
        ...NEUTRAL_TRANSFORM,
        rotate: 3,
      }),
    )
    answer(lastRender())
    expect(commits).toHaveBeenCalledOnce()

    vi.mocked(captureTransformSource).mockRejectedValueOnce(new Error('lost'))
    hook.rerender({ userExposureEv: 1 })
    await act(() => vi.advanceTimersByTimeAsync(150))
    expect(hook.result.current.feature.captureError).toBe(true)
    // The session keeps A, but nothing shows A on the current photo.
    expect(hook.result.current.geometry).not.toBeNull()
    expect(hook.result.current.feature.exportBlock).toBe('unavailable')
    hook.unmount()
  })

  it('never commits a first answer that lands while the HQ frame is being re-captured', async () => {
    const hook = renderSession()
    await captureNeutral(hook)
    act(() =>
      hook.result.current.feature.setManual({
        ...NEUTRAL_TRANSFORM,
        rotate: 3,
      }),
    )
    const first = lastRender()
    hook.rerender({ decodedImageVersion: 2 })
    await act(() => vi.advanceTimersByTimeAsync(60))
    // The answer belongs to the frame the HQ decode replaced.
    answer(first)
    expect(commits).not.toHaveBeenCalled()
    expect(hook.result.current.feature.exportBlock).toBe('pending')

    await act(() => vi.advanceTimersByTimeAsync(90))
    expect(captureTransformSource).toHaveBeenCalledTimes(2)
    expect(commits).not.toHaveBeenCalled()
    analyzeCapture()
    const onHq = lastRender()
    expect(onHq.sourceId).toBeGreaterThan(first.sourceId)
    answer(onHq)
    expect(commits).toHaveBeenCalledOnce()
    expect(commits).toHaveBeenLastCalledWith('one', geometryOf(onHq))
    expect(hook.result.current.feature.exportBlock).toBeNull()
    hook.unmount()
  })

  it('never commits a first answer once the capture that replaced its frame failed', async () => {
    const hook = renderSession()
    await captureNeutral(hook)
    act(() =>
      hook.result.current.feature.setManual({
        ...NEUTRAL_TRANSFORM,
        rotate: 3,
      }),
    )
    const first = lastRender()
    vi.mocked(captureTransformSource).mockRejectedValueOnce(new Error('lost'))
    hook.rerender({ userExposureEv: 1 })
    await act(() => vi.advanceTimersByTimeAsync(150))
    expect(hook.result.current.feature.captureError).toBe(true)
    answer(first)
    expect(commits).not.toHaveBeenCalled()
    expect(hook.result.current.feature.exportBlock).toBe('unavailable')
    hook.unmount()
  })

  it('keeps capturing for an uncommitted Transform after the panel closes', async () => {
    const hook = renderSession()
    const stop = await captureNeutral(hook)
    act(() =>
      hook.result.current.feature.setManual({
        ...NEUTRAL_TRANSFORM,
        rotate: 3,
      }),
    )
    act(() => stop())
    // The colour changes before the first answer, with nothing committed.
    hook.rerender({ userExposureEv: 1 })
    await act(() => vi.advanceTimersByTimeAsync(150))
    expect(captureTransformSource).toHaveBeenCalledTimes(2)
    expect(hook.result.current.feature.exportBlock).toBe('pending')
    analyzeCapture()
    const current = lastRender()
    answer(current)
    expect(commits).toHaveBeenCalledOnce()
    expect(commits).toHaveBeenLastCalledWith('one', geometryOf(current))
    expect(hook.result.current.feature.exportBlock).toBeNull()
    hook.unmount()
  })

  it('keeps an answered geometry when the panel closes or an export releases the preview', async () => {
    const hook = renderSession()
    const stop = await captureNeutral(hook)
    act(() =>
      hook.result.current.feature.setManual({
        ...NEUTRAL_TRANSFORM,
        rotate: 3,
      }),
    )
    const pending = lastRender()
    // Opening the export panel unmounts Transform; the request still owns
    // the export gate, not the panel.
    act(() => stop())
    expect(hook.result.current.feature.exportBlock).toBe('pending')
    answer(pending)
    expect(commits).toHaveBeenCalledOnce()
    expect(hook.result.current.feature.exportBlock).toBeNull()

    // A finished export releases the preview. That is not a failure.
    hook.rerender({ released: true, decodedImageVersion: 2 })
    expect(hook.result.current.feature.available).toBe(false)
    expect(hook.result.current.feature.active).toBe(true)
    expect(hook.result.current.feature.exportBlock).toBeNull()
    expect(commits).toHaveBeenCalledOnce()

    // Restore re-renders the same geometry on the restored frame.
    hook.rerender({ decodedImageVersion: 3 })
    await act(() => vi.advanceTimersByTimeAsync(150))
    analyzeCapture()
    answer(lastRender())
    expect(hook.result.current.feature.exportBlock).toBeNull()
    expect(hook.result.current.geometry).toEqual(geometryOf(pending))
    expect(commits).toHaveBeenCalledOnce()
    hook.unmount()
  })

  it('never blocks a neutral export for view aids or analysis', async () => {
    const hook = renderSession()
    act(() => {
      hook.result.current.feature.observe()
    })
    expect(hook.result.current.feature.exportBlock).toBeNull()
    await act(() => vi.advanceTimersByTimeAsync(150))
    expect(hook.result.current.feature.exportBlock).toBeNull()
    analyzeCapture()
    // The neutral render is still in flight.
    expect(hook.result.current.feature.exportBlock).toBeNull()
    act(() => {
      hook.result.current.feature.setShowLines(true)
      hook.result.current.feature.setShowGrid(true)
    })
    answer(lastRender())
    expect(hook.result.current.feature.exportBlock).toBeNull()
    expect(commits).not.toHaveBeenCalled()
    hook.unmount()
  })

  it('discards a capture completed after the RAW session was replaced', async () => {
    let complete!: (source: PreviewSource) => void
    vi.mocked(captureTransformSource).mockReturnValueOnce(
      new Promise((resolve) => {
        complete = resolve
      }),
    )
    const initial = workflow()
    const { result, rerender, unmount } = renderHook(
      ({ input }) => useRawTransformFeature(input, false),
      { initialProps: { input: initial } },
    )
    act(() => {
      result.current.observe()
    })
    await act(() => vi.advanceTimersByTimeAsync(150))
    rerender({
      input: {
        ...initial,
        previewTransform: { ...initial.previewTransform!, sourceId: 'two' },
      },
    })
    await act(async () => {
      complete(frame)
      await Promise.resolve()
    })
    // The capture never reached the demo, so no worker analysed it.
    expect(FakeWorker.instances).toHaveLength(0)
    expect(result.current.demo.source).toBeNull()
    unmount()
  })

  it('waits for the current processed CPU frame', async () => {
    const input = workflow()
    const { result, unmount } = renderHook(() =>
      useRawTransformFeature(input, true),
    )
    act(() => {
      result.current.observe()
    })
    await act(() => vi.advanceTimersByTimeAsync(150))
    expect(captureTransformSource).not.toHaveBeenCalled()
    const cpuFrame = {
      requestId: 1,
      sourceId: 'v1:80x60:123',
      width: 80,
      height: 60,
      rgba: frame.frame.data,
    }
    act(() => result.current.setCpuFrame(cpuFrame))
    await act(() => vi.advanceTimersByTimeAsync(150))
    expect(captureTransformSource).toHaveBeenCalledWith(
      expect.objectContaining({ pipeline: null, cpuFrame }),
    )
    unmount()
  })

  it('retains the current RAW CPU frame across HQ upgrades, then clears it for a new session', async () => {
    const input = workflow()
    const { result, rerender, unmount } = renderHook(
      ({ value }) => useRawTransformFeature(value, true),
      { initialProps: { value: input } },
    )
    act(() => {
      result.current.observe()
      result.current.setCpuFrame({
        requestId: 1,
        sourceId: 'v1:80x60:123',
        width: 80,
        height: 60,
        rgba: frame.frame.data,
      })
    })
    await act(() => vi.advanceTimersByTimeAsync(150))
    expect(result.current.available).toBe(true)
    rerender({ value: { ...input, decodedImageVersion: 2 } })
    await act(() => vi.advanceTimersByTimeAsync(150))
    expect(result.current.available).toBe(true)
    expect(captureTransformSource).toHaveBeenCalledTimes(2)
    rerender({
      value: {
        ...input,
        decodedImageVersion: 3,
        previewTransform: {
          ...input.previewTransform!,
          sourceId: 'replacement',
        },
      },
    })
    await act(() => vi.advanceTimersByTimeAsync(150))
    expect(result.current.available).toBe(false)
    expect(captureTransformSource).toHaveBeenCalledTimes(2)
    unmount()
  })
})
