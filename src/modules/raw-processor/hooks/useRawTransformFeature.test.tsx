import type { LUTData } from '@lumaforge/luma-color-runtime'
import { generateIdentityLUT, toLUTData } from '@lumaforge/luma-color-runtime'
import type { ExportGeometry } from '@lumaforge/render-engine/export'
import type { CpuPreviewFrame } from '@lumaforge/render-engine/preview'
import { act, cleanup, renderHook } from '@testing-library/react'
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
  constructor() {
    FakeWorker.instances.push(this)
  }
  postMessage(message: TransformWorkerRequest) {
    this.messages.push(message)
  }
  terminate() {}
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

function worker() {
  const live = FakeWorker.instances.at(-1)
  if (!live) throw new Error('expected a worker')
  return live
}

function lastOf<T extends TransformWorkerRequest['type']>(type: T) {
  const request = worker().messages.findLast((message) => message.type === type)
  if (!request) throw new Error(`expected ${type}`)
  return request as Extract<TransformWorkerRequest, { type: T }>
}
const lastRender = () => lastOf('render')

function analyzeCapture(result: UprightAnalysis = analysis) {
  act(() =>
    worker().emit({
      type: 'analyzed',
      sourceId: lastOf('analyze').sourceId,
      analysis: result,
      elapsedMs: 1,
    }),
  )
}

function failAnalysis() {
  act(() =>
    worker().emit({
      type: 'error',
      sourceId: lastOf('analyze').sourceId,
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

/** Fails `request` as a refused geometry or as a frame that did not render. */
function failRender(
  request: RenderRequest,
  message: 'invalid-transform' | 'processing',
) {
  act(() =>
    worker().emit({
      type: 'error',
      sourceId: request.sourceId,
      requestId: request.requestId,
      phase: 'render',
      message,
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
function decodedFrameOf(n: number, sessionId: string): DecodedPreviewFrame {
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

const lutRecords = new Map<number, LUTData>()
/** One LUT record per number, the same object each time it is asked for. */
function lutRecord(record: number): LUTData {
  let lut = lutRecords.get(record)
  if (!lut) {
    lut = toLUTData(generateIdentityLUT(2))
    lutRecords.set(record, lut)
  }
  return lut
}

const image = { width: 80, height: 60 }
const pipelineRef = { current: {} }
const setViewMode = vi.fn()
const commits =
  vi.fn<(session: string, geometry: ExportGeometry | null) => void>()

interface SessionInput {
  session?: string
  /** The accepted decoded frame of the session; null while none is accepted. */
  frame?: number | null
  /** The LUT record the store holds, by number; each number is one record. */
  lut?: number
  userExposureEv?: number
  userSaturation?: number
  intensity?: number
  viewMode?: 'processed' | 'compare'
  status?: 'ready' | 'decoding'
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
  lut = 1,
  userExposureEv = 0,
  userSaturation = 0,
  intensity = 1,
  viewMode = 'processed',
  status = 'ready',
  cpu = false,
  released = false,
}: SessionInput) {
  const { transform, geometry } = useTransformSessionFixture(session, commits)
  const feature = useRawTransformFeature(
    {
      hasImage: true,
      sourceFileName: 'current.nef',
      status,
      decodedFrame:
        released || frame === null ? null : decodedFrameOf(frame, session),
      lutData: lutRecord(lut),
      decodedImageRef: { current: released ? null : image },
      pipelineRef,
      viewMode,
      compareSplit: 0.5,
      params: { userExposureEv, userSaturation, intensity },
      previewSuspended: released,
      transform,
      setViewMode,
    } as unknown as UseRawWorkflowReturn,
    cpu,
  )
  return { feature, geometry }
}

type Hook = ReturnType<typeof renderSession>

function renderSession(initial: SessionInput = {}) {
  return renderHook((input: SessionInput) => useSessionHarness(input), {
    initialProps: initial,
  })
}

const featureOf = (hook: Hook) => hook.result.current.feature

/** Lets the capture's debounce and read-back run. */
const settle = (ms = 150) => act(() => vi.advanceTimersByTimeAsync(ms))

/** Opens the Transform panel; the returned function closes it. */
function observe(hook: Hook) {
  let stop!: () => void
  act(() => {
    stop = featureOf(hook).observe()
  })
  return stop
}

function rotate(hook: Hook, degrees: number) {
  act(() =>
    featureOf(hook).setManual({ ...NEUTRAL_TRANSFORM, rotate: degrees }),
  )
}

/** Opens the panel and analyses and renders a neutral frame. */
async function captureNeutral(hook: Hook) {
  const stop = observe(hook)
  await settle()
  analyzeCapture()
  answer(lastRender())
  return stop
}

/** A neutral capture, then a rotation the preview answers on that frame. */
async function commitRotation(hook: Hook) {
  const stop = await captureNeutral(hook)
  rotate(hook, 3)
  const committed = lastRender()
  answer(committed)
  expect(commits).toHaveBeenCalledExactlyOnceWith('one', geometryOf(committed))
  return { stop, committed }
}

const frame: PreviewSource = {
  frame: { width: 80, height: 60, data: new Uint8ClampedArray(80 * 60 * 4) },
}
beforeEach(() => {
  vi.useFakeTimers()
  FakeWorker.instances = []
  vi.stubGlobal('Worker', FakeWorker)
  vi.mocked(captureTransformSource).mockResolvedValue(frame)
})
afterEach(() => {
  // Unmounting resets the Transform, so it must land before the mocks clear.
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('useRawTransformFeature', () => {
  describe('frame capture', () => {
    it('captures only once observed, and analyses a neutral Transform again only for a new decoded frame', async () => {
      const hook = renderSession()
      await settle()
      expect(captureTransformSource).not.toHaveBeenCalled()
      observe(hook)
      // Analysing a neutral photo blocks no export.
      expect(featureOf(hook).exportBlock).toBeNull()
      await settle()
      expect(worker().messages.at(-1)).toEqual({
        type: 'analyze',
        sourceId: expect.any(Number),
        frame: frame.frame,
      })
      analyzeCapture()
      answer(lastRender())

      // None of these is a new photo, and a neutral Transform shows none of
      // them: re-reading the frame would only repeat the same analysis.
      const edited: SessionInput = { userExposureEv: 1 }
      for (const edit of [
        { userSaturation: 20 },
        { lut: 2 },
        { intensity: 0.4 },
        { viewMode: 'compare' as const },
      ]) {
        Object.assign(edited, edit)
        hook.rerender({ ...edited })
        await settle()
      }
      expect(captureTransformSource).toHaveBeenCalledOnce()
      expect(analyses()).toBe(1)
      expect(featureOf(hook)).toMatchObject({
        current: true,
        busy: false,
        exportBlock: null,
      })

      // A new accepted decoded frame is a new photo.
      hook.rerender({ ...edited, frame: 2 })
      await settle()
      expect(captureTransformSource).toHaveBeenCalledTimes(2)
      expect(commits).not.toHaveBeenCalled()
    })

    it('captures the photo as it now looks before a first Transform can commit, and stops following the colour once neutral again', async () => {
      const hook = renderSession()
      await captureNeutral(hook)
      hook.rerender({ userExposureEv: 1, lut: 2, intensity: 0.5 })
      await settle()
      expect(captureTransformSource).toHaveBeenCalledOnce()

      rotate(hook, 3)
      // Posted on the frame from before the edits, its answer shows the old
      // colour, so it is never what export reproduces.
      const stale = lastRender()
      answer(stale)
      expect(commits).not.toHaveBeenCalled()
      expect(featureOf(hook).exportBlock).toBe('pending')

      await settle()
      expect(captureTransformSource).toHaveBeenCalledTimes(2)
      analyzeCapture()
      const fresh = lastRender()
      expect(fresh.sourceId).toBeGreaterThan(stale.sourceId)
      answer(fresh)
      expect(commits).toHaveBeenCalledExactlyOnceWith('one', geometryOf(fresh))
      expect(featureOf(hook).exportBlock).toBeNull()

      act(() => featureOf(hook).reset())
      expect(commits).toHaveBeenLastCalledWith('one', null)
      hook.rerender({ userExposureEv: 2, lut: 2, intensity: 0.5 })
      await settle()
      expect(captureTransformSource).toHaveBeenCalledTimes(2)
    })

    it('solves a first Upright on the photo as it now looks, and keeps an accepted one where it is', async () => {
      // Every read-back is a new frame.
      vi.mocked(captureTransformSource).mockImplementation(async () => ({
        ...frame,
      }))
      const hook = renderSession()
      observe(hook)
      await settle()
      analyzeCapture(uprightAnalysis(1))
      answer(lastRender())
      hook.rerender({ userExposureEv: 1 })
      await settle()

      // Auto is picked from the analysis of the frame before the edit, so
      // the frame captured for it has to solve it again.
      act(() => featureOf(hook).setMode('auto'))
      await settle()
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
      expect(commits).toHaveBeenCalledExactlyOnceWith('one', geometryOf(first))

      // Once accepted, the colour moving on does not move the geometry,
      // whatever the new frame's analysis would solve.
      hook.rerender({ userExposureEv: 2 })
      await settle()
      analyzeCapture(uprightAnalysis(3))
      expect(answerLatest().matrix).toEqual(first.matrix)
      expect(commits).toHaveBeenCalledOnce()
      expect(featureOf(hook).exportBlock).toBeNull()
    })

    it.each([
      ['crashes', () => act(() => worker().onerror?.())],
      ['fails the analysis', failAnalysis],
    ])(
      'captures again on the next change of input once the worker %s on the frame',
      async (_label, fail) => {
        const hook = renderSession()
        observe(hook)
        await settle()
        fail()
        expect(featureOf(hook).preview.error).toBe('processing')
        expect(featureOf(hook).current).toBe(false)
        // Nothing retries by itself...
        await settle()
        expect(captureTransformSource).toHaveBeenCalledOnce()

        // ...but the next change of input does.
        hook.rerender({ userExposureEv: 1 })
        await settle()
        expect(captureTransformSource).toHaveBeenCalledTimes(2)
        expect(featureOf(hook).preview.error).toBeNull()
        analyzeCapture()
        answer(lastRender())
        expect(featureOf(hook).current).toBe(true)
      },
    )

    it('follows the colour on screen while view aids draw over the frame', async () => {
      const hook = renderSession()
      await captureNeutral(hook)
      act(() => featureOf(hook).setShowLines(true))
      expect(featureOf(hook).showOverlay).toBe(true)
      hook.rerender({ userExposureEv: 1 })
      await settle()
      expect(captureTransformSource).toHaveBeenCalledTimes(2)
      analyzeCapture()
      answer(lastRender())
      expect(featureOf(hook).current).toBe(true)

      act(() => featureOf(hook).setShowLines(false))
      hook.rerender({ userExposureEv: 2 })
      await settle()
      expect(captureTransformSource).toHaveBeenCalledTimes(2)
      expect(featureOf(hook).exportBlock).toBeNull()
    })

    it('captures no WebGPU frame the workflow has not accepted', async () => {
      const hook = renderSession({ frame: null })
      observe(hook)
      await settle()
      expect(featureOf(hook).available).toBe(false)
      expect(captureTransformSource).not.toHaveBeenCalled()

      hook.rerender({})
      expect(featureOf(hook).available).toBe(true)
      await settle()
      expect(captureTransformSource).toHaveBeenCalledOnce()
    })

    it('reports its own capture as busy, whatever the stage is doing', async () => {
      // A decode locks the Transform commands through the shared action
      // policy, not through the feature; the frame they wait for still comes.
      const hook = renderSession({ status: 'decoding' })
      expect(featureOf(hook)).toMatchObject({ available: true, busy: false })
      observe(hook)
      expect(featureOf(hook).busy).toBe(true)
      await settle()
      expect(captureTransformSource).toHaveBeenCalledOnce()
    })

    it('reads nothing back when the panel opens again on the same photo', async () => {
      const hook = renderSession()
      const { stop } = await commitRotation(hook)
      act(() => stop())
      observe(hook)
      await settle()
      expect(captureTransformSource).toHaveBeenCalledOnce()
      expect(featureOf(hook)).toMatchObject({ active: true, exportBlock: null })
    })
  })

  describe('export gate', () => {
    it('commits a Transform only once the preview answers it, and says why export waits until then', async () => {
      const hook = renderSession()
      await captureNeutral(hook)
      rotate(hook, 3)
      expect(setViewMode).toHaveBeenCalledWith('processed')
      const a = lastRender()
      expect(commits).not.toHaveBeenCalled()
      expect(featureOf(hook)).toMatchObject({
        active: false,
        exportBlock: 'pending',
      })
      answer(a)
      expect(commits).toHaveBeenCalledExactlyOnceWith('one', geometryOf(a))
      expect(featureOf(hook)).toMatchObject({ active: true, exportBlock: null })

      // A newer edit keeps the answered geometry while it waits, is refused
      // or fails to render, and export says which.
      rotate(hook, 6)
      expect(featureOf(hook).exportBlock).toBe('pending')
      failRender(lastRender(), 'invalid-transform')
      expect(featureOf(hook).exportBlock).toBe('invalid')
      rotate(hook, 5)
      failRender(lastRender(), 'processing')
      expect(featureOf(hook).exportBlock).toBe('unavailable')
      expect(featureOf(hook).active).toBe(true)
      expect(hook.result.current.geometry).toEqual(geometryOf(a))
      expect(commits).toHaveBeenCalledOnce()

      rotate(hook, 4)
      const c = lastRender()
      answer(c)
      expect(commits).toHaveBeenLastCalledWith('one', geometryOf(c))
      expect(featureOf(hook).exportBlock).toBeNull()

      // A neutral reset clears the geometry straight away.
      act(() => featureOf(hook).reset())
      expect(commits).toHaveBeenLastCalledWith('one', null)
      expect(featureOf(hook)).toMatchObject({
        active: false,
        exportBlock: null,
      })
    })

    it.each<[string, SessionInput]>([
      ['the colour', { userExposureEv: 1 }],
      ['the LUT record', { lut: 2 }],
      ['the strength', { intensity: 0.5 }],
      ['the accepted decoded frame', { frame: 2 }],
    ])(
      'holds export from the moment %s moves on until the new frame answers the same geometry',
      async (_label, change) => {
        const hook = renderSession()
        const { committed } = await commitRotation(hook)
        // The same accepted frame, LUT record and colour keep the answer.
        hook.rerender({})
        await settle()
        expect(captureTransformSource).toHaveBeenCalledOnce()
        expect(featureOf(hook).exportBlock).toBeNull()

        hook.rerender(change)
        expect(featureOf(hook).exportBlock).toBe('pending')
        await settle()
        expect(captureTransformSource).toHaveBeenCalledTimes(2)
        analyzeCapture()
        const fresh = answerLatest()
        expect(fresh.sourceId).toBeGreaterThan(committed.sourceId)
        expect(featureOf(hook).exportBlock).toBeNull()
        // Committing the same geometry again would discard the export.
        expect(commits).toHaveBeenCalledOnce()
        expect(hook.result.current.geometry).toEqual(geometryOf(committed))
      },
    )

    it('never commits a first answer that lands while its frame is read back again', async () => {
      const hook = renderSession()
      await captureNeutral(hook)
      rotate(hook, 3)
      const first = lastRender()
      hook.rerender({ frame: 2 })
      await settle(60)
      // The answer belongs to the frame the HQ decode replaced.
      answer(first)
      expect(commits).not.toHaveBeenCalled()
      expect(featureOf(hook).exportBlock).toBe('pending')

      await settle(90)
      analyzeCapture()
      const onHq = answerLatest()
      expect(onHq.sourceId).toBeGreaterThan(first.sourceId)
      expect(commits).toHaveBeenCalledExactlyOnceWith('one', geometryOf(onHq))
    })

    it('blocks export as unavailable when the next capture fails, and captures again once neutral', async () => {
      const hook = renderSession()
      await commitRotation(hook)
      vi.mocked(captureTransformSource).mockRejectedValueOnce(new Error('lost'))
      hook.rerender({ userExposureEv: 1 })
      await settle()
      expect(featureOf(hook).captureError).toBe(true)
      // The session keeps its geometry, but nothing shows it on the photo.
      expect(hook.result.current.geometry).not.toBeNull()
      expect(featureOf(hook).exportBlock).toBe('unavailable')

      // Neutral no longer needs the new colour, but the failed frame cannot
      // be trusted as the photo either.
      act(() => featureOf(hook).reset())
      expect(commits).toHaveBeenLastCalledWith('one', null)
      await settle()
      expect(captureTransformSource).toHaveBeenCalledTimes(3)
      expect(featureOf(hook).captureError).toBe(false)
      analyzeCapture()
      answer(lastRender())
      expect(featureOf(hook)).toMatchObject({
        current: true,
        exportBlock: null,
      })
    })

    it('keeps asking for a Transform after the panel closes, and keeps its answer through an export release', async () => {
      const hook = renderSession()
      const stop = await captureNeutral(hook)
      rotate(hook, 3)
      act(() => stop())
      // The request, not the panel, owns the export gate, so the frame still
      // follows the colour.
      hook.rerender({ userExposureEv: 1 })
      await settle()
      expect(captureTransformSource).toHaveBeenCalledTimes(2)
      expect(featureOf(hook).exportBlock).toBe('pending')
      analyzeCapture()
      const answered = answerLatest()
      expect(commits).toHaveBeenCalledExactlyOnceWith(
        'one',
        geometryOf(answered),
      )

      // A finished export releases the preview. That is not a failure.
      hook.rerender({ userExposureEv: 1, released: true, frame: 2 })
      expect(featureOf(hook)).toMatchObject({
        available: false,
        active: true,
        exportBlock: null,
      })

      // Restore renders the same geometry on the restored frame.
      hook.rerender({ userExposureEv: 1, frame: 3 })
      await settle()
      analyzeCapture()
      answerLatest()
      expect(featureOf(hook).exportBlock).toBeNull()
      expect(commits).toHaveBeenCalledOnce()
    })

    it('asks the loaded frame again once the colour returns before it is read back', async () => {
      const hook = renderSession()
      const { committed } = await commitRotation(hook)
      hook.rerender({ userExposureEv: 1 })
      expect(featureOf(hook).exportBlock).toBe('pending')
      await settle(60)
      hook.rerender({})
      await settle()
      expect(captureTransformSource).toHaveBeenCalledOnce()
      expect(answerLatest().matrix).toEqual(committed.matrix)
      expect(featureOf(hook)).toMatchObject({ exportBlock: null, busy: false })
      expect(commits).toHaveBeenCalledOnce()
    })

    it('follows the preview between WebGPU and the CPU without committing again', async () => {
      const hook = renderSession()
      const { committed } = await commitRotation(hook)

      // The CPU stage has not finished a frame yet: nothing to answer on.
      hook.rerender({ cpu: true })
      await settle()
      expect(captureTransformSource).toHaveBeenCalledOnce()
      expect(featureOf(hook).exportBlock).toBe('pending')
      const onCpu = cpuFrameOf(1)
      act(() => featureOf(hook).setCpuFrame(onCpu))
      await settle()
      expect(lastCapturedCpuFrame()).toBe(onCpu)
      analyzeCapture()
      expect(answerLatest().matrix).toEqual(committed.matrix)
      expect(featureOf(hook).exportBlock).toBeNull()

      hook.rerender({})
      expect(featureOf(hook).exportBlock).toBe('pending')
      await settle()
      expect(captureTransformSource).toHaveBeenCalledTimes(3)
      expect(lastCapturedCpuFrame()).toBeNull()
      analyzeCapture()
      expect(answerLatest().matrix).toEqual(committed.matrix)
      expect(featureOf(hook).exportBlock).toBeNull()
      expect(commits).toHaveBeenCalledOnce()
    })
  })

  describe('frames of the CPU preview', () => {
    it('waits for a CPU frame, and keeps a neutral analysis across colour frames, an original peek and an HQ decode of its source', async () => {
      const hook = renderSession({ cpu: true })
      observe(hook)
      await settle()
      expect(featureOf(hook).available).toBe(false)
      expect(captureTransformSource).not.toHaveBeenCalled()
      const first = cpuFrameOf(1)
      act(() => featureOf(hook).setCpuFrame(first))
      expect(featureOf(hook).available).toBe(true)
      await settle()
      expect(captureTransformSource).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ pipeline: null, cpuFrame: first }),
      )
      analyzeCapture()
      answer(lastRender())
      const analysed = featureOf(hook).preview.source

      // Peeking at the original hands Transform nothing...
      act(() => featureOf(hook).setCpuFrame(null))
      expect(featureOf(hook).available).toBe(false)
      // ...and the CPU stage keeps rendering its source across a colour edit
      // and an HQ decode, so the frames it brings back are the same photo.
      hook.rerender({ cpu: true, userExposureEv: 1, frame: 2 })
      act(() => featureOf(hook).setCpuFrame(cpuFrameOf(2)))
      await settle()
      expect(captureTransformSource).toHaveBeenCalledOnce()
      expect(analyses()).toBe(1)
      expect(featureOf(hook).preview.source).toBe(analysed)
      expect(featureOf(hook)).toMatchObject({ available: true, current: true })

      // A source the CPU stage loads afresh is a new photo.
      act(() => featureOf(hook).setCpuFrame(cpuFrameOf(3, 'v2:80x60:28800')))
      await settle()
      expect(captureTransformSource).toHaveBeenCalledTimes(2)

      // A new RAW starts without a frame.
      hook.rerender({ cpu: true, session: 'two' })
      expect(featureOf(hook).available).toBe(false)
      expect(worker().messages.at(-1)).toMatchObject({ type: 'clear' })
    })

    it('asks a Transform of the newest CPU frame, and of every newer one again', async () => {
      const hook = renderSession({ cpu: true })
      const stop = observe(hook)
      act(() => featureOf(hook).setCpuFrame(cpuFrameOf(1)))
      await settle()
      analyzeCapture()
      answer(lastRender())

      const next = cpuFrameOf(2)
      act(() => featureOf(hook).setCpuFrame(next))
      rotate(hook, 3)
      await settle()
      expect(captureTransformSource).toHaveBeenCalledTimes(2)
      expect(lastCapturedCpuFrame()).toBe(next)
      analyzeCapture()
      const committed = answerLatest()
      expect(commits).toHaveBeenCalledExactlyOnceWith(
        'one',
        geometryOf(committed),
      )

      // A committed Transform keeps its frame up with the photo after the
      // panel closes: a newer render of the same source is a new frame.
      act(() => stop())
      act(() => featureOf(hook).setCpuFrame(cpuFrameOf(3)))
      expect(featureOf(hook).exportBlock).toBe('pending')
      await settle()
      expect(captureTransformSource).toHaveBeenCalledTimes(3)
      analyzeCapture()
      answerLatest()
      expect(featureOf(hook).exportBlock).toBeNull()
      expect(commits).toHaveBeenCalledOnce()
      expect(hook.result.current.geometry).toEqual(geometryOf(committed))
    })
  })

  describe('source lifetime', () => {
    it('starts a new RAW neutral, and gives it its own commit even for the same geometry', async () => {
      const hook = renderSession()
      const { committed } = await commitRotation(hook)

      hook.rerender({ session: 'two' })
      expect(worker().messages.at(-1)).toMatchObject({ type: 'clear' })
      expect(hook.result.current.geometry).toBeNull()
      expect(featureOf(hook).preview).toMatchObject({
        mode: 'off',
        manual: NEUTRAL_TRANSFORM,
      })
      expect(featureOf(hook).exportBlock).toBeNull()

      await captureNeutral(hook)
      rotate(hook, 3)
      const onSecond = lastRender()
      expect(onSecond.matrix).toEqual(committed.matrix)
      expect(featureOf(hook).exportBlock).toBe('pending')
      answer(onSecond)
      expect(commits).toHaveBeenCalledTimes(2)
      expect(commits).toHaveBeenLastCalledWith('two', geometryOf(onSecond))
    })

    it('discards a capture completed after the RAW was replaced', async () => {
      let complete!: (source: PreviewSource) => void
      vi.mocked(captureTransformSource).mockReturnValueOnce(
        new Promise((resolve) => {
          complete = resolve
        }),
      )
      const hook = renderSession()
      observe(hook)
      await settle()
      hook.rerender({ session: 'two' })
      await act(async () => {
        complete(frame)
        await Promise.resolve()
      })
      // The capture never reached the preview, so no worker analysed it.
      expect(FakeWorker.instances).toHaveLength(0)
      expect(featureOf(hook).preview.source).toBeNull()
    })

    it('resets the Transform on leaving the workspace, and commits nothing for a neutral one', async () => {
      const active = renderSession()
      await commitRotation(active)
      active.unmount()
      expect(commits).toHaveBeenLastCalledWith('one', null)

      commits.mockClear()
      const neutral = renderSession()
      await captureNeutral(neutral)
      neutral.unmount()
      expect(commits).not.toHaveBeenCalled()
    })
  })
})
