import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import type { ExportGeometry } from '@lumaforge/render-engine/export'
import type { CpuPreviewFrame } from '@lumaforge/render-engine/preview'
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { DecodedPreviewFrame } from '~/lib/preview/preview-frame'
import { identityMatrix, rotationMatrix } from '~/lib/transform/geometry/matrix'
import type { UprightAnalysis } from '~/lib/transform/geometry/types'
import type { PreviewSource } from '~/lib/transform/preview-types'
import { composeManualTransform } from '~/lib/transform/transform-render'
import { NEUTRAL_TRANSFORM } from '~/lib/transform/transform-types'
import type {
  TransformWorkerRequest,
  TransformWorkerResponse,
} from '~/lib/transform/worker-protocol'

import { captureTransformSource } from '../services/preview/capture-transform-source'
import { useTransformSessionFixture } from './transform-session.fixture'
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

/** An analysis whose Auto and Level solutions rotate by `degrees`. */
function uprightAnalysis(degrees: number): UprightAnalysis {
  const corrected = {
    ...solution,
    matrix: rotationMatrix(degrees, 80 / 60),
    rotationDegrees: degrees,
  }
  return {
    lines: [],
    solutions: { ...analysis.solutions, auto: corrected, level: corrected },
  }
}

function lastAnalyze() {
  const request = worker().messages.findLast(
    (message) => message.type === 'analyze',
  )
  if (!request) throw new Error('expected analyze')
  return request
}

function analyzeCapture(result: UprightAnalysis = analysis) {
  const request = lastAnalyze()
  act(() =>
    worker().emit({
      type: 'analyzed',
      sourceId: request.sourceId,
      analysis: result,
      elapsedMs: 1,
    }),
  )
}

function failAnalysis() {
  const request = lastAnalyze()
  act(() =>
    worker().emit({
      type: 'error',
      sourceId: request.sourceId,
      phase: 'analysis',
      message: 'processing',
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

/** Answers renders in order until the newest one asked for is answered. */
function answerLatest(): RenderRequest {
  let request = lastRender()
  answer(request)
  while (lastRender() !== request) {
    request = lastRender()
    answer(request)
  }
  return request
}

function refuse(request: RenderRequest) {
  act(() =>
    worker().emit({
      type: 'error',
      sourceId: request.sourceId,
      requestId: request.requestId,
      phase: 'render',
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

/** Frames the Transform worker was asked to analyse, across workers. */
function analyses() {
  return FakeWorker.instances
    .flatMap((instance) => instance.messages)
    .filter((message) => message.type === 'analyze').length
}

/** A finished processed CPU frame, as the CPU stage hands it over. */
function cpuFrameOf(
  requestId: number,
  sourceId = 'v1:80x60:28800',
): CpuPreviewFrame {
  return {
    requestId,
    sourceId,
    width: 80,
    height: 60,
    rgba: new Uint8ClampedArray(80 * 60 * 4),
  }
}

function lastCapturedCpuFrame() {
  return vi.mocked(captureTransformSource).mock.lastCall?.[0].cpuFrame
}

/**
 * The accepted descriptor of decoded frame `n` of RAW `sessionId`, as the
 * workflow publishes it: the first frame is the quick decode, every later
 * one a bounded-HQ decode or a restored frame.
 */
function decodedFrameOf(n: number, sessionId = 'one'): DecodedPreviewFrame {
  return {
    sessionId,
    frameId: `decoded-frame-${n}`,
    stage: n === 1 ? 'quick' : 'bounded-hq',
    width: 80,
    height: 60,
    exposure: {
      kind: 'source-pin',
      value: { ev: 0, multiplier: 1, source: 'identity' },
    },
    quickPredecessorFrameId: null,
  }
}

function workflow(): UseRawWorkflowReturn {
  return {
    hasImage: true,
    sourceFileName: 'current.nef',
    status: 'ready',
    decodedImageVersion: 1,
    decodedFrame: decodedFrameOf(1),
    lutDataVersion: 1,
    decodedImageRef: { current: { width: 80, height: 60 } },
    pipelineRef: { current: {} },
    viewMode: 'processed',
    compareSplit: 0.5,
    params: { userExposureEv: 0 },
    setViewMode: vi.fn(),
  } as unknown as UseRawWorkflowReturn
}

/** The feature over `input`, with the session ports of RAW `sourceId`. */
function useFeature(
  input: UseRawWorkflowReturn,
  cpu: boolean,
  sourceId = 'one',
) {
  const { transform } = useTransformSessionFixture(sourceId, commits)
  return useRawTransformFeature({ ...input, transform }, cpu)
}

const image = { width: 80, height: 60 }
const pipelineRef = { current: {} }
const setViewMode = vi.fn()
const commits =
  vi.fn<(session: string, geometry: ExportGeometry | null) => void>()

interface SessionInput {
  session?: string
  /** The accepted decoded frame of the session the workflow holds. */
  frame?: number
  /**
   * The workflow's decoded image counter, which moves with every accepted
   * or released frame; it names no frame.
   */
  decodedImageVersion?: number
  lutDataVersion?: number
  userExposureEv?: number
  userSaturation?: number
  intensity?: number
  viewMode?: 'processed' | 'compare'
  /** The preview runs on the CPU worker instead of WebGPU. */
  cpu?: boolean
  /** A finished export released the preview. */
  released?: boolean
}

/**
 * The workflow side of the contract: one session per RAW, whose Transform
 * moves only through the events the feature dispatches.
 */
function useSessionHarness({
  session = 'one',
  frame = 1,
  decodedImageVersion = 1,
  lutDataVersion = 1,
  userExposureEv = 0,
  userSaturation = 0,
  intensity = 1,
  viewMode = 'processed',
  cpu = false,
  released = false,
}: SessionInput) {
  const { transform, geometry } = useTransformSessionFixture(session, commits)
  const feature = useRawTransformFeature(
    {
      hasImage: true,
      sourceFileName: 'current.nef',
      status: 'ready',
      decodedImageVersion,
      decodedFrame: released ? null : decodedFrameOf(frame, session),
      lutDataVersion,
      decodedImageRef: { current: released ? null : image },
      pipelineRef,
      viewMode,
      compareSplit: 0.5,
      params: {
        userExposureEv,
        userSaturation,
        intensity,
      },
      previewSuspended: released,
      transform,
      setViewMode,
    } as unknown as UseRawWorkflowReturn,
    cpu,
  )
  return { feature, geometry, transform }
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
  it('clears transient geometry on leaving the workspace without invalidating neutral exports', async () => {
    const active = renderSession()
    await captureNeutral(active)
    act(() =>
      active.result.current.feature.setManual({
        ...NEUTRAL_TRANSFORM,
        rotate: 3,
      }),
    )
    answer(lastRender())
    expect(commits).toHaveBeenCalledOnce()
    active.unmount()
    expect(commits).toHaveBeenLastCalledWith('one', null)

    commits.mockClear()
    const neutral = renderSession()
    await captureNeutral(neutral)
    neutral.unmount()
    expect(commits).not.toHaveBeenCalled()
  })

  it('captures on demand and refreshes color without reopening the photo or resetting geometry', async () => {
    const initial = workflow()
    const { result, rerender, unmount } = renderHook(
      ({ input }) => useFeature(input, false),
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
    // Moving the comparison is no new frame.
    rerender({
      input: { ...initial, viewMode: 'compare', compareSplit: 0.2 },
    })
    await act(() => vi.advanceTimersByTimeAsync(150))
    expect(captureTransformSource).toHaveBeenCalledTimes(1)
    act(() => result.current.setMode('vertical'))
    rerender({
      input: { ...initial, params: { ...initial.params, userExposureEv: 1 } },
    })
    await act(() => vi.advanceTimersByTimeAsync(150))
    // A Transform the controls ask for follows the colour on screen.
    expect(captureTransformSource).toHaveBeenCalledTimes(2)
    expect(
      worker().messages.filter((message) => message.type === 'analyze'),
    ).toHaveLength(2)
    expect(result.current.preview.mode).toBe('vertical')
    // The production contract names what it shows once, as the preview.
    expect(result.current).not.toHaveProperty('demo')
    expect(initial.setViewMode).toHaveBeenCalledWith('processed')
    unmount()
  })

  it('analyses a neutral Transform once, whatever the colour, LUT or strength does next', async () => {
    const hook = renderSession()
    await act(() => vi.advanceTimersByTimeAsync(150))
    expect(captureTransformSource).not.toHaveBeenCalled()
    await captureNeutral(hook)
    expect(captureTransformSource).toHaveBeenCalledOnce()
    expect(analyses()).toBe(1)

    // None of these is a new photo, and a neutral Transform shows none of
    // them: re-reading the frame would only repeat the same analysis.
    const edits: SessionInput[] = [
      { userExposureEv: 1 },
      { userExposureEv: 1.5, userSaturation: 20 },
      { userExposureEv: 1.5, userSaturation: 20, lutDataVersion: 2 },
      {
        userExposureEv: 1.5,
        userSaturation: 20,
        lutDataVersion: 2,
        intensity: 0.4,
      },
      {
        userExposureEv: 1.5,
        userSaturation: 20,
        lutDataVersion: 2,
        intensity: 0.7,
        viewMode: 'compare',
      },
    ]
    for (const edit of edits) {
      hook.rerender(edit)
      await act(() => vi.advanceTimersByTimeAsync(150))
    }
    expect(captureTransformSource).toHaveBeenCalledOnce()
    expect(analyses()).toBe(1)
    expect(hook.result.current.feature.current).toBe(true)
    expect(hook.result.current.feature.busy).toBe(false)
    expect(hook.result.current.feature.exportBlock).toBeNull()
    expect(commits).not.toHaveBeenCalled()
    hook.unmount()
  })

  it('captures the photo as it now looks before a first Transform can commit', async () => {
    const hook = renderSession()
    await captureNeutral(hook)
    hook.rerender({ userExposureEv: 1, lutDataVersion: 2, intensity: 0.5 })
    await act(() => vi.advanceTimersByTimeAsync(150))
    expect(captureTransformSource).toHaveBeenCalledOnce()

    const latest: PreviewSource = {
      ...frame,
      frame: { ...frame.frame, data: new Uint8ClampedArray(80 * 60 * 4) },
    }
    vi.mocked(captureTransformSource).mockResolvedValueOnce(latest)
    act(() =>
      hook.result.current.feature.setManual({
        ...NEUTRAL_TRANSFORM,
        rotate: 3,
      }),
    )
    // The request is posted on the frame from before the edits. Its answer
    // shows the old colour, so it is never what export reproduces.
    const stale = lastRender()
    answer(stale)
    expect(commits).not.toHaveBeenCalled()
    expect(hook.result.current.feature.active).toBe(false)
    expect(hook.result.current.feature.exportBlock).toBe('pending')

    await act(() => vi.advanceTimersByTimeAsync(150))
    expect(captureTransformSource).toHaveBeenCalledTimes(2)
    expect(hook.result.current.feature.preview.source).toBe(latest)
    expect(hook.result.current.feature.preview.manual.rotate).toBe(3)
    expect(hook.result.current.feature.exportBlock).toBe('pending')
    analyzeCapture()
    const fresh = lastRender()
    expect(fresh.sourceId).toBeGreaterThan(stale.sourceId)
    answer(fresh)
    expect(commits).toHaveBeenCalledOnce()
    expect(commits).toHaveBeenLastCalledWith('one', geometryOf(fresh))
    expect(hook.result.current.feature.exportBlock).toBeNull()

    // Back to neutral with the panel still open, colour edits stop costing a
    // capture again.
    act(() => hook.result.current.feature.reset())
    expect(commits).toHaveBeenLastCalledWith('one', null)
    hook.rerender({ userExposureEv: 2, lutDataVersion: 2, intensity: 0.5 })
    await act(() => vi.advanceTimersByTimeAsync(150))
    expect(captureTransformSource).toHaveBeenCalledTimes(2)
    expect(hook.result.current.feature.exportBlock).toBeNull()
    hook.unmount()
  })

  it('solves a first Upright on the photo as it now looks, and keeps a committed one where it is', async () => {
    // Every read-back is a new frame.
    vi.mocked(captureTransformSource).mockImplementation(async () => ({
      ...frame,
    }))
    const hook = renderSession()
    let stop!: () => void
    act(() => {
      stop = hook.result.current.feature.observe()
    })
    await act(() => vi.advanceTimersByTimeAsync(150))
    analyzeCapture(uprightAnalysis(1))
    answer(lastRender())
    hook.rerender({ userExposureEv: 1 })
    await act(() => vi.advanceTimersByTimeAsync(150))
    expect(captureTransformSource).toHaveBeenCalledOnce()

    // Auto is picked from the analysis of the frame before the edit, so
    // the frame captured for it has to solve it again.
    act(() => hook.result.current.feature.setMode('auto'))
    await act(() => vi.advanceTimersByTimeAsync(150))
    expect(captureTransformSource).toHaveBeenCalledTimes(2)
    analyzeCapture(uprightAnalysis(2))
    const first = answerLatest()
    expect(first.matrix).toEqual(
      composeManualTransform(
        rotationMatrix(2, 80 / 60),
        NEUTRAL_TRANSFORM,
        80 / 60,
      ),
    )
    expect(commits).toHaveBeenCalledOnce()
    expect(commits).toHaveBeenLastCalledWith('one', geometryOf(first))
    expect(hook.result.current.feature.exportBlock).toBeNull()

    // Once committed, the colour moving on does not move the geometry,
    // whatever the new frame's analysis would solve.
    hook.rerender({ userExposureEv: 2 })
    await act(() => vi.advanceTimersByTimeAsync(150))
    expect(captureTransformSource).toHaveBeenCalledTimes(3)
    analyzeCapture(uprightAnalysis(3))
    const refreshed = answerLatest()
    expect(refreshed.matrix).toEqual(first.matrix)
    expect(refreshed.sourceId).toBeGreaterThan(first.sourceId)
    expect(commits).toHaveBeenCalledOnce()
    expect(hook.result.current.geometry).toEqual(geometryOf(first))
    expect(hook.result.current.feature.exportBlock).toBeNull()

    // Nor does a mobile tool switch that closes the panel.
    act(() => stop())
    hook.rerender({ userExposureEv: 3 })
    await act(() => vi.advanceTimersByTimeAsync(150))
    expect(captureTransformSource).toHaveBeenCalledTimes(4)
    analyzeCapture(uprightAnalysis(4))
    expect(answerLatest().matrix).toEqual(first.matrix)
    expect(commits).toHaveBeenCalledOnce()
    expect(hook.result.current.feature.preview.mode).toBe('auto')
    expect(hook.result.current.feature.exportBlock).toBeNull()
    hook.unmount()
  })

  it('captures again on the next edit once the Transform worker failed the frame', async () => {
    const hook = renderSession()
    await captureNeutral(hook)

    // The worker crashes. Nothing retries by itself...
    act(() => worker().onerror?.())
    expect(hook.result.current.feature.preview.error).toBe('processing')
    expect(hook.result.current.feature.current).toBe(false)
    await act(() => vi.advanceTimersByTimeAsync(150))
    expect(captureTransformSource).toHaveBeenCalledOnce()
    // ...but the next change of input does, on a new worker.
    hook.rerender({ userExposureEv: 1 })
    await act(() => vi.advanceTimersByTimeAsync(150))
    expect(captureTransformSource).toHaveBeenCalledTimes(2)
    expect(FakeWorker.instances).toHaveLength(2)
    expect(hook.result.current.feature.preview.error).toBeNull()
    analyzeCapture()
    answer(lastRender())
    expect(hook.result.current.feature.current).toBe(true)

    // So does an analysis the worker failed.
    hook.rerender({ userExposureEv: 1, frame: 2 })
    await act(() => vi.advanceTimersByTimeAsync(150))
    expect(captureTransformSource).toHaveBeenCalledTimes(3)
    failAnalysis()
    expect(hook.result.current.feature.preview.error).toBe('processing')
    expect(hook.result.current.feature.preview.ready).toBe(false)
    await act(() => vi.advanceTimersByTimeAsync(150))
    expect(captureTransformSource).toHaveBeenCalledTimes(3)
    hook.rerender({ userExposureEv: 2, frame: 2 })
    await act(() => vi.advanceTimersByTimeAsync(150))
    expect(captureTransformSource).toHaveBeenCalledTimes(4)
    expect(hook.result.current.feature.preview.error).toBeNull()
    analyzeCapture()
    answer(lastRender())
    expect(hook.result.current.feature.current).toBe(true)
    expect(hook.result.current.feature.exportBlock).toBeNull()
    expect(commits).not.toHaveBeenCalled()
    hook.unmount()
  })

  it('keeps the view aids drawn on the colour on screen', async () => {
    const hook = renderSession()
    await captureNeutral(hook)
    // Lines and Grid draw over the captured frame, so it must follow.
    act(() => hook.result.current.feature.setShowLines(true))
    expect(hook.result.current.feature.showOverlay).toBe(true)
    hook.rerender({ userExposureEv: 1 })
    await act(() => vi.advanceTimersByTimeAsync(150))
    expect(captureTransformSource).toHaveBeenCalledTimes(2)
    analyzeCapture()
    answer(lastRender())
    expect(hook.result.current.feature.current).toBe(true)

    act(() => hook.result.current.feature.setShowLines(false))
    hook.rerender({ userExposureEv: 2 })
    await act(() => vi.advanceTimersByTimeAsync(150))
    expect(captureTransformSource).toHaveBeenCalledTimes(2)
    expect(hook.result.current.feature.exportBlock).toBeNull()
    hook.unmount()
  })

  it('keeps a neutral CPU analysis across colour frames and an original peek', async () => {
    const hook = renderSession({ cpu: true })
    let stop!: () => void
    act(() => {
      stop = hook.result.current.feature.observe()
    })
    await act(() => vi.advanceTimersByTimeAsync(150))
    expect(captureTransformSource).not.toHaveBeenCalled()
    const first = cpuFrameOf(1)
    act(() => hook.result.current.feature.setCpuFrame(first))
    await act(() => vi.advanceTimersByTimeAsync(150))
    expect(captureTransformSource).toHaveBeenCalledOnce()
    expect(lastCapturedCpuFrame()).toBe(first)
    analyzeCapture()
    answer(lastRender())
    const analysed = hook.result.current.feature.preview.source

    // Peeking at the original hands Transform nothing, and the processed
    // frame that comes back is the same photo, not a new one.
    act(() => hook.result.current.feature.setCpuFrame(null))
    expect(hook.result.current.feature.available).toBe(false)
    expect(hook.result.current.feature.preview.source).toBe(analysed)
    act(() => hook.result.current.feature.setCpuFrame(cpuFrameOf(2)))
    await act(() => vi.advanceTimersByTimeAsync(150))
    // So is every frame a colour edit renders.
    hook.rerender({ cpu: true, userExposureEv: 1 })
    act(() => hook.result.current.feature.setCpuFrame(null))
    const edited = cpuFrameOf(3)
    act(() => hook.result.current.feature.setCpuFrame(edited))
    await act(() => vi.advanceTimersByTimeAsync(150))
    expect(captureTransformSource).toHaveBeenCalledOnce()
    expect(analyses()).toBe(1)
    expect(worker().messages.some((message) => message.type === 'clear')).toBe(
      false,
    )
    expect(hook.result.current.feature.preview.source).toBe(analysed)
    expect(hook.result.current.feature.available).toBe(true)
    expect(hook.result.current.feature.current).toBe(true)

    // A first request reads the newest processed frame.
    act(() =>
      hook.result.current.feature.setManual({
        ...NEUTRAL_TRANSFORM,
        rotate: 3,
      }),
    )
    await act(() => vi.advanceTimersByTimeAsync(150))
    expect(captureTransformSource).toHaveBeenCalledTimes(2)
    expect(lastCapturedCpuFrame()).toBe(edited)
    analyzeCapture()
    const committed = lastRender()
    answer(committed)
    expect(commits).toHaveBeenCalledOnce()
    expect(commits).toHaveBeenLastCalledWith('one', geometryOf(committed))

    // A committed Transform keeps its overlay in colour after the panel
    // closes, and keeps its geometry while the new frame answers.
    act(() => stop())
    hook.rerender({ cpu: true, userExposureEv: 2 })
    act(() => hook.result.current.feature.setCpuFrame(null))
    const refreshed = cpuFrameOf(4)
    act(() => hook.result.current.feature.setCpuFrame(refreshed))
    expect(hook.result.current.feature.exportBlock).toBe('pending')
    await act(() => vi.advanceTimersByTimeAsync(150))
    expect(captureTransformSource).toHaveBeenCalledTimes(3)
    expect(lastCapturedCpuFrame()).toBe(refreshed)
    expect(hook.result.current.geometry).toEqual(geometryOf(committed))
    analyzeCapture()
    answer(lastRender())
    expect(hook.result.current.feature.exportBlock).toBeNull()
    expect(commits).toHaveBeenCalledOnce()
    hook.unmount()
  })

  it('analyses again for a new decoded source, a new preview executor or a new RAW', async () => {
    const hook = renderSession()
    await captureNeutral(hook)
    expect(captureTransformSource).toHaveBeenCalledOnce()

    // The HQ decode replaces the photo WebGPU renders.
    hook.rerender({ frame: 2 })
    await act(() => vi.advanceTimersByTimeAsync(150))
    expect(captureTransformSource).toHaveBeenCalledTimes(2)
    analyzeCapture()
    answer(lastRender())
    expect(analyses()).toBe(2)

    // Falling back to the CPU waits for its first finished frame.
    hook.rerender({ frame: 2, cpu: true })
    await act(() => vi.advanceTimersByTimeAsync(150))
    expect(captureTransformSource).toHaveBeenCalledTimes(2)
    const onCpu = cpuFrameOf(1, 'v2:80x60:28800')
    act(() => hook.result.current.feature.setCpuFrame(onCpu))
    await act(() => vi.advanceTimersByTimeAsync(150))
    expect(captureTransformSource).toHaveBeenCalledTimes(3)
    expect(lastCapturedCpuFrame()).toBe(onCpu)
    analyzeCapture()
    answer(lastRender())

    // The CPU stage keeps rendering its source across an HQ decode...
    hook.rerender({ frame: 3, cpu: true })
    await act(() => vi.advanceTimersByTimeAsync(150))
    expect(captureTransformSource).toHaveBeenCalledTimes(3)
    expect(hook.result.current.feature.available).toBe(true)
    // ...until it loads a new one.
    const reseeded = cpuFrameOf(2, 'v3:80x60:28800')
    act(() => hook.result.current.feature.setCpuFrame(reseeded))
    await act(() => vi.advanceTimersByTimeAsync(150))
    expect(captureTransformSource).toHaveBeenCalledTimes(4)
    expect(lastCapturedCpuFrame()).toBe(reseeded)
    analyzeCapture()
    answer(lastRender())

    // Back on WebGPU.
    hook.rerender({ frame: 3 })
    await act(() => vi.advanceTimersByTimeAsync(150))
    expect(captureTransformSource).toHaveBeenCalledTimes(5)
    expect(lastCapturedCpuFrame()).toBeNull()
    analyzeCapture()
    answer(lastRender())

    // A new RAW starts over.
    hook.rerender({ session: 'two', frame: 4 })
    expect(worker().messages.at(-1)).toMatchObject({ type: 'clear' })
    await act(() => vi.advanceTimersByTimeAsync(150))
    expect(captureTransformSource).toHaveBeenCalledTimes(6)
    expect(analyses()).toBe(6)
    expect(commits).not.toHaveBeenCalled()
    hook.unmount()
  })

  it('names the WebGPU frame by its accepted descriptor, never by the decoded image counter', async () => {
    const hook = renderSession()
    await captureNeutral(hook)
    expect(captureTransformSource).toHaveBeenCalledOnce()

    // The counter moves without a new accepted frame: the photo is the same.
    hook.rerender({ decodedImageVersion: 2 })
    await act(() => vi.advanceTimersByTimeAsync(150))
    expect(captureTransformSource).toHaveBeenCalledOnce()
    expect(hook.result.current.feature.current).toBe(true)

    // A new accepted frame is a new photo, whatever the counter says.
    hook.rerender({ decodedImageVersion: 2, frame: 2 })
    await act(() => vi.advanceTimersByTimeAsync(150))
    expect(captureTransformSource).toHaveBeenCalledTimes(2)
    analyzeCapture()
    answer(lastRender())

    act(() =>
      hook.result.current.feature.setManual({
        ...NEUTRAL_TRANSFORM,
        rotate: 3,
      }),
    )
    const answered = lastRender()
    answer(answered)
    expect(hook.result.current.feature.exportBlock).toBeNull()
    // The answer stands on the same accepted frame...
    hook.rerender({ decodedImageVersion: 5, frame: 2 })
    expect(hook.result.current.feature.exportBlock).toBeNull()
    await act(() => vi.advanceTimersByTimeAsync(150))
    expect(captureTransformSource).toHaveBeenCalledTimes(2)
    // ...and not on a frame decoded again for the same source.
    hook.rerender({ decodedImageVersion: 5, frame: 3 })
    expect(hook.result.current.feature.exportBlock).toBe('pending')
    await act(() => vi.advanceTimersByTimeAsync(150))
    expect(captureTransformSource).toHaveBeenCalledTimes(3)
    analyzeCapture()
    answerLatest()
    expect(hook.result.current.feature.exportBlock).toBeNull()
    expect(commits).toHaveBeenCalledOnce()
    expect(hook.result.current.geometry).toEqual(geometryOf(answered))
    hook.unmount()
  })

  it('captures no WebGPU frame the workflow has not accepted', async () => {
    const input = { ...workflow(), decodedFrame: null }
    const { result, rerender, unmount } = renderHook(
      ({ value }) => useFeature(value, false),
      { initialProps: { value: input as UseRawWorkflowReturn } },
    )
    act(() => {
      result.current.observe()
    })
    await act(() => vi.advanceTimersByTimeAsync(150))
    expect(result.current.available).toBe(false)
    expect(captureTransformSource).not.toHaveBeenCalled()

    rerender({ value: workflow() })
    expect(result.current.available).toBe(true)
    await act(() => vi.advanceTimersByTimeAsync(150))
    expect(captureTransformSource).toHaveBeenCalledOnce()
    unmount()
  })

  it('keeps the CPU frame its own source and request identity across accepted frames', async () => {
    const hook = renderSession({ cpu: true })
    act(() => {
      hook.result.current.feature.observe()
    })
    // The CPU stage names the quick source it renders, not the workflow's
    // descriptor.
    const quick = cpuFrameOf(1, 'cpu-source-quick')
    act(() => hook.result.current.feature.setCpuFrame(quick))
    await act(() => vi.advanceTimersByTimeAsync(150))
    expect(captureTransformSource).toHaveBeenCalledOnce()
    analyzeCapture()
    answer(lastRender())
    expect(hook.result.current.feature.current).toBe(true)

    // The bounded-HQ frame is accepted while the CPU stage keeps drawing its
    // quick source: the retained frame stays the photo a neutral analysis
    // was made on, though it is not the workflow's newest frame.
    hook.rerender({ cpu: true, frame: 2, decodedImageVersion: 2 })
    await act(() => vi.advanceTimersByTimeAsync(150))
    expect(captureTransformSource).toHaveBeenCalledOnce()
    expect(hook.result.current.feature.available).toBe(true)
    expect(hook.result.current.feature.current).toBe(true)

    // A Transform reads the newest processed frame the stage returned.
    const next = cpuFrameOf(2, 'cpu-source-quick')
    act(() => hook.result.current.feature.setCpuFrame(next))
    act(() =>
      hook.result.current.feature.setManual({
        ...NEUTRAL_TRANSFORM,
        rotate: 3,
      }),
    )
    await act(() => vi.advanceTimersByTimeAsync(150))
    expect(captureTransformSource).toHaveBeenCalledTimes(2)
    expect(lastCapturedCpuFrame()).toBe(next)
    analyzeCapture()
    answerLatest()
    expect(hook.result.current.feature.exportBlock).toBeNull()
    expect(commits).toHaveBeenCalledOnce()

    // A newer render request on the same source is a new frame to answer on.
    act(() =>
      hook.result.current.feature.setCpuFrame(
        cpuFrameOf(3, 'cpu-source-quick'),
      ),
    )
    expect(hook.result.current.feature.exportBlock).toBe('pending')
    await act(() => vi.advanceTimersByTimeAsync(150))
    expect(captureTransformSource).toHaveBeenCalledTimes(3)
    analyzeCapture()
    answerLatest()
    expect(hook.result.current.feature.exportBlock).toBeNull()
    expect(commits).toHaveBeenCalledOnce()
    hook.unmount()
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
    act(() => stop())

    hook.rerender({ session: 'two' })
    // The old photo's answer never lands on the new session.
    expect(commits).toHaveBeenCalledOnce()
    expect(hook.result.current.geometry).toBeNull()
    expect(hook.result.current.feature.preview.mode).toBe('off')
    expect(hook.result.current.feature.preview.manual).toEqual(
      NEUTRAL_TRANSFORM,
    )
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
    hook.rerender({ userExposureEv: 1, frame: 2 })
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

  it('tries the capture again after a failure even once the Transform is neutral', async () => {
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

    // Neutral no longer needs the new colour, but the failed frame cannot be
    // trusted as the photo either.
    act(() => hook.result.current.feature.reset())
    expect(commits).toHaveBeenLastCalledWith('one', null)
    await act(() => vi.advanceTimersByTimeAsync(150))
    expect(captureTransformSource).toHaveBeenCalledTimes(3)
    expect(hook.result.current.feature.captureError).toBe(false)
    analyzeCapture()
    answer(lastRender())
    expect(hook.result.current.feature.current).toBe(true)
    expect(hook.result.current.feature.exportBlock).toBeNull()
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
    hook.rerender({ frame: 2 })
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
    hook.rerender({ released: true, frame: 2 })
    expect(hook.result.current.feature.available).toBe(false)
    expect(hook.result.current.feature.active).toBe(true)
    expect(hook.result.current.feature.exportBlock).toBeNull()
    expect(commits).toHaveBeenCalledOnce()

    // Restore re-renders the same geometry on the restored frame.
    hook.rerender({ frame: 3 })
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

  it('keeps the Transform and its geometry when the panel closes and opens again', async () => {
    const hook = renderSession()
    const stop = await captureNeutral(hook)
    act(() =>
      hook.result.current.feature.setManual({
        ...NEUTRAL_TRANSFORM,
        rotate: 3,
      }),
    )
    const answered = lastRender()
    answer(answered)
    expect(commits).toHaveBeenCalledOnce()

    act(() => stop())
    let reopened!: () => void
    act(() => {
      reopened = hook.result.current.feature.observe()
    })
    await act(() => vi.advanceTimersByTimeAsync(150))
    // Nothing about the photo changed, so nothing is read back again.
    expect(captureTransformSource).toHaveBeenCalledOnce()
    expect(hook.result.current.feature.preview.manual.rotate).toBe(3)
    expect(hook.result.current.feature.active).toBe(true)
    expect(hook.result.current.feature.exportBlock).toBeNull()

    // A colour edit with the panel open again asks the new frame for the
    // same geometry, and holds export until it answers.
    hook.rerender({ userExposureEv: 1 })
    expect(hook.result.current.feature.exportBlock).toBe('pending')
    await act(() => vi.advanceTimersByTimeAsync(150))
    expect(captureTransformSource).toHaveBeenCalledTimes(2)
    analyzeCapture()
    const again = answerLatest()
    expect(again.matrix).toEqual(answered.matrix)
    expect(hook.result.current.feature.exportBlock).toBeNull()
    expect(commits).toHaveBeenCalledOnce()
    expect(hook.result.current.geometry).toEqual(geometryOf(answered))
    act(() => reopened())
    hook.unmount()
  })

  it('follows the preview between WebGPU and the CPU without committing again', async () => {
    const hook = renderSession()
    await captureNeutral(hook)
    act(() =>
      hook.result.current.feature.setManual({
        ...NEUTRAL_TRANSFORM,
        rotate: 3,
      }),
    )
    const onGpu = lastRender()
    answer(onGpu)
    expect(commits).toHaveBeenCalledOnce()

    // The CPU stage has not finished a frame yet: nothing to answer on.
    hook.rerender({ cpu: true })
    expect(hook.result.current.feature.exportBlock).toBe('pending')
    await act(() => vi.advanceTimersByTimeAsync(150))
    expect(captureTransformSource).toHaveBeenCalledOnce()
    expect(hook.result.current.feature.exportBlock).toBe('pending')
    const onCpu = cpuFrameOf(1)
    act(() => hook.result.current.feature.setCpuFrame(onCpu))
    await act(() => vi.advanceTimersByTimeAsync(150))
    expect(captureTransformSource).toHaveBeenCalledTimes(2)
    expect(lastCapturedCpuFrame()).toBe(onCpu)
    analyzeCapture()
    expect(answerLatest().matrix).toEqual(onGpu.matrix)
    expect(hook.result.current.feature.exportBlock).toBeNull()

    // And back on WebGPU.
    hook.rerender({})
    expect(hook.result.current.feature.exportBlock).toBe('pending')
    await act(() => vi.advanceTimersByTimeAsync(150))
    expect(captureTransformSource).toHaveBeenCalledTimes(3)
    expect(lastCapturedCpuFrame()).toBeNull()
    analyzeCapture()
    expect(answerLatest().matrix).toEqual(onGpu.matrix)
    expect(hook.result.current.feature.exportBlock).toBeNull()
    expect(commits).toHaveBeenCalledOnce()
    expect(hook.result.current.geometry).toEqual(geometryOf(onGpu))
    hook.unmount()
  })

  it('answers on the loaded frame again once the colour returns before it is read back', async () => {
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
    expect(commits).toHaveBeenCalledOnce()

    hook.rerender({ userExposureEv: 1 })
    expect(hook.result.current.feature.exportBlock).toBe('pending')
    await act(() => vi.advanceTimersByTimeAsync(60))
    // Back to the colour the loaded frame was read with.
    hook.rerender({ userExposureEv: 0 })
    await act(() => vi.advanceTimersByTimeAsync(150))
    expect(captureTransformSource).toHaveBeenCalledOnce()
    expect(answerLatest().matrix).toEqual(a.matrix)
    expect(hook.result.current.feature.exportBlock).toBeNull()
    expect(hook.result.current.feature.busy).toBe(false)
    expect(commits).toHaveBeenCalledOnce()
    hook.unmount()
  })

  it('commits only the last of a run of rapid edits', async () => {
    const hook = renderSession()
    await captureNeutral(hook)
    const inFlight: RenderRequest[] = []
    for (const rotate of [1, 2, 3, 4]) {
      act(() =>
        hook.result.current.feature.setManual({ ...NEUTRAL_TRANSFORM, rotate }),
      )
      inFlight.push(lastRender())
    }
    // Only the first edit reached the worker; the rest wait as one.
    expect(new Set(inFlight).size).toBe(1)
    answer(inFlight[0])
    expect(commits).not.toHaveBeenCalled()
    expect(hook.result.current.feature.exportBlock).toBe('pending')
    const last = lastRender()
    expect(last.requestId).toBeGreaterThan(inFlight[0].requestId)
    expect(last.matrix).toEqual(
      composeManualTransform(
        identityMatrix(),
        { ...NEUTRAL_TRANSFORM, rotate: 4 },
        80 / 60,
      ),
    )
    answer(last)
    expect(commits).toHaveBeenCalledOnce()
    expect(commits).toHaveBeenLastCalledWith('one', geometryOf(last))
    expect(hook.result.current.feature.exportBlock).toBeNull()
    hook.unmount()
  })

  it('holds the last geometry when the newest render fails, and never takes an older answer for it', async () => {
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
    expect(commits).toHaveBeenCalledOnce()

    act(() =>
      hook.result.current.feature.setManual({
        ...NEUTRAL_TRANSFORM,
        rotate: 6,
      }),
    )
    const b = lastRender()
    act(() =>
      worker().emit({
        type: 'error',
        sourceId: b.sourceId,
        requestId: b.requestId,
        phase: 'render',
        message: 'processing',
      }),
    )
    expect(hook.result.current.feature.exportBlock).toBe('unavailable')
    expect(hook.result.current.feature.active).toBe(true)
    expect(hook.result.current.geometry).toEqual(geometryOf(a))

    // A late copy of A's answer does not stand in for B.
    answer(a)
    expect(hook.result.current.feature.exportBlock).toBe('unavailable')
    expect(commits).toHaveBeenCalledOnce()

    act(() =>
      hook.result.current.feature.setManual({
        ...NEUTRAL_TRANSFORM,
        rotate: 4,
      }),
    )
    expect(hook.result.current.feature.exportBlock).not.toBeNull()
    const c = lastRender()
    answer(c)
    expect(commits).toHaveBeenCalledTimes(2)
    expect(commits).toHaveBeenLastCalledWith('one', geometryOf(c))
    expect(hook.result.current.feature.exportBlock).toBeNull()
    hook.unmount()
  })

  it('names its captures and requests after its client lifetime, and lets no other lifetime move the geometry', async () => {
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
    expect(commits).toHaveBeenCalledOnce()
    const answered = hook.result.current.transform!.state!
    const epoch = answered.capture!.clientEpoch
    expect(answered.request?.clientEpoch).toBe(epoch)
    expect(answered.accepted?.clientEpoch).toBe(epoch)

    act(() =>
      hook.result.current.feature.setManual({
        ...NEUTRAL_TRANSFORM,
        rotate: 6,
      }),
    )
    const b = lastRender()
    const { capture, request } = hook.result.current.transform!.state!
    expect(request?.requestId).toBe(b.requestId)
    // Another client numbers its frames and requests alike: every event below
    // repeats the current source, capture and request but for its lifetime.
    const other = {
      sourceId: 'one',
      captureKey: capture!.key,
      clientEpoch: epoch + 1,
    }
    const { dispatch } = hook.result.current.transform!
    act(() => {
      dispatch({
        type: 'rendered',
        ...other,
        requestId: b.requestId,
        geometry: geometryOf(b),
        frame: { width: 80, height: 60 },
      })
      dispatch({
        type: 'render-failed',
        ...other,
        requestId: b.requestId,
        failure: 'transform',
      })
      dispatch({ type: 'capture-failed', ...other })
      dispatch({
        type: 'request',
        ...other,
        requestId: b.requestId + 1,
        geometry: geometryOf(a),
      })
    })
    expect(hook.result.current.transform!.state!.request).toBe(request)
    expect(hook.result.current.feature.exportBlock).toBe('pending')
    expect(hook.result.current.geometry).toEqual(geometryOf(a))
    expect(commits).toHaveBeenCalledOnce()

    // The client that holds the frame still answers it.
    answer(b)
    expect(commits).toHaveBeenCalledTimes(2)
    expect(commits).toHaveBeenLastCalledWith('one', geometryOf(b))
    expect(hook.result.current.feature.exportBlock).toBeNull()
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
      ({ input, sourceId }) => useFeature(input, false, sourceId),
      { initialProps: { input: initial, sourceId: 'one' } },
    )
    act(() => {
      result.current.observe()
    })
    await act(() => vi.advanceTimersByTimeAsync(150))
    rerender({ input: initial, sourceId: 'two' })
    await act(async () => {
      complete(frame)
      await Promise.resolve()
    })
    // The capture never reached the preview, so no worker analysed it.
    expect(FakeWorker.instances).toHaveLength(0)
    expect(result.current.preview.source).toBeNull()
    unmount()
  })

  it('waits for the current processed CPU frame', async () => {
    const input = workflow()
    const { result, unmount } = renderHook(() => useFeature(input, true))
    act(() => {
      result.current.observe()
    })
    await act(() => vi.advanceTimersByTimeAsync(150))
    expect(captureTransformSource).not.toHaveBeenCalled()
    // Without the CPU stage's current frame there is nothing to capture.
    expect(result.current.available).toBe(false)
    const cpuFrame = {
      requestId: 1,
      sourceId: 'v1:80x60:123',
      width: 80,
      height: 60,
      rgba: frame.frame.data,
    }
    act(() => result.current.setCpuFrame(cpuFrame))
    expect(result.current.available).toBe(true)
    await act(() => vi.advanceTimersByTimeAsync(150))
    expect(captureTransformSource).toHaveBeenCalledWith(
      expect.objectContaining({ pipeline: null, cpuFrame }),
    )
    unmount()
  })

  it('schedules its capture apart from the stage, and holds no command lock of its own', async () => {
    const input = { ...workflow(), status: 'decoding' } as UseRawWorkflowReturn
    const { result, unmount } = renderHook(() => useFeature(input, false))
    // The decode locks the Transform commands through the shared action
    // policy, not through the feature; the frame they wait for still comes.
    expect(result.current).not.toHaveProperty('isProcessing')
    expect(result.current.available).toBe(true)
    expect(result.current.busy).toBe(false)
    act(() => {
      result.current.observe()
    })
    // What the feature reports busy is its own capture, not the stage.
    expect(result.current.busy).toBe(true)
    await act(() => vi.advanceTimersByTimeAsync(150))
    expect(captureTransformSource).toHaveBeenCalledOnce()
    unmount()
  })

  it('retains the current RAW CPU frame across HQ upgrades, then clears it for a new session', async () => {
    const input = workflow()
    const { result, rerender, unmount } = renderHook(
      ({ value, sourceId }) => useFeature(value, true, sourceId),
      { initialProps: { value: input, sourceId: 'one' } },
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
    rerender({
      value: {
        ...input,
        decodedImageVersion: 2,
        decodedFrame: decodedFrameOf(2),
      },
      sourceId: 'one',
    })
    await act(() => vi.advanceTimersByTimeAsync(150))
    expect(result.current.available).toBe(true)
    // The retained quick frame is the photo already analysed.
    expect(captureTransformSource).toHaveBeenCalledOnce()
    rerender({
      value: {
        ...input,
        decodedImageVersion: 3,
        decodedFrame: decodedFrameOf(1, 'replacement'),
      },
      sourceId: 'replacement',
    })
    await act(() => vi.advanceTimersByTimeAsync(150))
    expect(result.current.available).toBe(false)
    expect(captureTransformSource).toHaveBeenCalledOnce()
    unmount()
  })
})

describe('rAW Transform production ownership', () => {
  it('drives the preview, overlay and fields from production homes only', () => {
    for (const file of [
      'src/modules/raw-processor/hooks/useRawTransformFeature.ts',
      'src/modules/raw-processor/components/RawTransformOverlay.tsx',
      'src/modules/raw-processor/components/transform-fields.ts',
    ]) {
      const source = readFileSync(resolve(process.cwd(), file), 'utf8')
      expect(source, file).not.toMatch(/transform-demo/)
    }
  })
})
