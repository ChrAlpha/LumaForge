import { act, renderHook } from '@testing-library/react'
import { StrictMode, useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { identityMatrix, rotationMatrix } from '~/lib/transform/geometry/matrix'
import type {
  UprightAnalysis,
  UprightMode,
} from '~/lib/transform/geometry/types'
import type { PreviewSource } from '~/lib/transform/preview-types'
import { NEUTRAL_TRANSFORM } from '~/lib/transform/transform-types'
import type {
  TransformWorkerRequest,
  TransformWorkerResponse,
} from '~/lib/transform/worker-protocol'

import type { TransformIntent } from '../model/session'
import { createNeutralTransformIntent } from '../model/session-factory'
import type { TransformPreviewObserver } from './useTransformPreview'
import { useTransformPreview } from './useTransformPreview'

const NO_OBSERVER: TransformPreviewObserver = {
  requested: () => {},
  rendered: () => {},
  renderFailed: () => {},
  frameFailed: () => {},
}

/**
 * The preview under an intent its owner holds, with the owner's controls:
 * the preview itself keeps no intent.
 */
function useOwnedPreview(observer: TransformPreviewObserver = NO_OBSERVER) {
  const [intent, setIntent] = useState<TransformIntent>(
    createNeutralTransformIntent,
  )
  const preview = useTransformPreview(intent, observer)
  return {
    ...preview,
    edit: (next: Partial<TransformIntent>) =>
      setIntent((previous) => ({ ...previous, ...next })),
    /** Picks an Upright mode and solves it, as the feature does. */
    setMode: (upright: UprightMode) => {
      setIntent((previous) => ({ ...previous, upright }))
      preview.solveUpright()
    },
  }
}

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
/** An analysis whose Auto solution is `matrix`. */
const solvingAuto = (
  matrix: ReturnType<typeof identityMatrix>,
): UprightAnalysis => ({
  ...analysis,
  solutions: { ...analysis.solutions, auto: { ...solution, matrix } },
})

class PreviewWorker {
  static instances: PreviewWorker[] = []
  onmessage: ((event: MessageEvent<TransformWorkerResponse>) => void) | null =
    null
  onerror: (() => void) | null = null
  messages: TransformWorkerRequest[] = []
  terminated = false
  constructor() {
    PreviewWorker.instances.push(this)
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

function photo(fill = 0): PreviewSource {
  return {
    frame: { width: 2, height: 2, data: new Uint8ClampedArray(16).fill(fill) },
  }
}

function lastOf<T extends TransformWorkerRequest['type']>(
  worker: PreviewWorker,
  type: T,
) {
  const request = worker.messages.findLast((message) => message.type === type)
  if (!request) throw new Error(`expected ${type}`)
  return request as Extract<TransformWorkerRequest, { type: T }>
}
const lastRender = (worker: PreviewWorker) => lastOf(worker, 'render')

function analyze(worker: PreviewWorker, result: UprightAnalysis = analysis) {
  act(() =>
    worker.emit({
      type: 'analyzed',
      sourceId: lastOf(worker, 'analyze').sourceId,
      analysis: result,
      elapsedMs: 1,
    }),
  )
}

function renderedFrame() {
  return {
    frame: { width: 2, height: 2, data: new Uint8ClampedArray(16) },
    displayMatrix: identityMatrix(),
    retainedArea: 1,
  }
}

function answer(
  request: RenderRequest,
  result = renderedFrame(),
): TransformWorkerResponse {
  return {
    type: 'rendered',
    sourceId: request.sourceId,
    requestId: request.requestId,
    result,
  }
}

function refuse(request: RenderRequest): TransformWorkerResponse {
  return {
    type: 'error',
    sourceId: request.sourceId,
    requestId: request.requestId,
    phase: 'render',
    message: 'invalid-transform',
  }
}

/** A hook with one frame loaded and analysed. */
function setupLoaded(
  result: UprightAnalysis = analysis,
  observer: TransformPreviewObserver = NO_OBSERVER,
) {
  const hook = renderHook(() => useOwnedPreview(observer))
  act(() => hook.result.current.loadSource(photo()))
  const worker = PreviewWorker.instances[0]
  analyze(worker, result)
  return { ...hook, worker }
}

beforeEach(() => {
  PreviewWorker.instances = []
  vi.stubGlobal('Worker', PreviewWorker)
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('useTransformPreview', () => {
  it('keeps one worker across cleared frames and terminates it only on unmount', () => {
    const { result, unmount, worker } = setupLoaded()
    expect(result.current.ready).toBe(true)

    act(() => result.current.clearSource())
    expect(worker.messages.at(-1)).toMatchObject({ type: 'clear' })
    expect(result.current.source).toBeNull()
    expect(result.current.ready).toBe(false)

    act(() => result.current.loadSource(photo()))
    analyze(worker)
    expect(PreviewWorker.instances).toHaveLength(1)
    expect(result.current.ready).toBe(true)
    expect(worker.terminated).toBe(false)
    unmount()
    expect(worker.terminated).toBe(true)
  })

  it('names each mount by its own client lifetime, kept across rerenders and a StrictMode replay', () => {
    const first = renderHook(() => useOwnedPreview())
    const epoch = first.result.current.clientEpoch
    first.rerender()
    expect(first.result.current.clientEpoch).toBe(epoch)
    expect(
      renderHook(() => useOwnedPreview()).result.current.clientEpoch,
    ).not.toBe(epoch)

    const strict = renderHook(() => useOwnedPreview(), { wrapper: StrictMode })
    const strictEpoch = strict.result.current.clientEpoch
    act(() => strict.result.current.loadSource(photo()))
    const [live] = PreviewWorker.instances
    expect(live.terminated).toBe(false)
    analyze(live)
    expect(strict.result.current.ready).toBe(true)
    expect(strict.result.current.clientEpoch).toBe(strictEpoch)
    strict.unmount()
    expect(live.terminated).toBe(true)
  })

  it('keeps the solved Upright across a refreshed frame until it is solved again, and solves a new photo afresh', () => {
    const selected = rotationMatrix(5)
    const updated = rotationMatrix(-3)
    const { result, worker } = setupLoaded(solvingAuto(selected))
    act(() => result.current.setMode('auto'))

    act(() => result.current.loadSource(photo(50), { preserveTransform: true }))
    analyze(worker, solvingAuto(updated))
    expect(result.current.solution.matrix).toEqual(selected)
    expect(lastRender(worker).matrix).toEqual(selected)
    act(() => result.current.setMode('auto'))
    expect(result.current.solution.matrix).toEqual(updated)

    act(() => result.current.loadSource(photo()))
    expect(result.current.solution.status).toBe('unchanged')
    analyze(worker, solvingAuto(selected))
    expect(result.current.solution.matrix).toEqual(selected)
  })

  it('shows only the answer to the newest request, however the answers land', () => {
    const { result, worker } = setupLoaded()
    const neutral = lastRender(worker)
    // Two edits queue behind the neutral render as one.
    act(() =>
      result.current.edit({ manual: { ...NEUTRAL_TRANSFORM, rotate: 3 } }),
    )
    act(() =>
      result.current.edit({ manual: { ...NEUTRAL_TRANSFORM, rotate: 4 } }),
    )
    act(() => worker.emit(answer(neutral)))
    expect(result.current.result).toBeNull()
    expect(result.current.rendering).toBe(true)

    const newest = lastRender(worker)
    expect(newest.requestId).toBeGreaterThan(neutral.requestId)
    const shown = renderedFrame()
    act(() => worker.emit(answer(newest, shown)))
    expect(result.current.result).toBe(shown)
    expect(result.current.rendering).toBe(false)

    act(() => worker.emit(answer(neutral)))
    expect(result.current.result).toBe(shown)
  })

  it('drops what a crashed worker rendered, and claims no render it cannot post', () => {
    const { result, worker } = setupLoaded()
    act(() => worker.emit(answer(lastRender(worker))))
    expect(result.current.result).not.toBeNull()

    act(() => worker.onerror?.())
    expect(result.current.error).toBe('processing')
    expect(result.current.analysis).toBeNull()
    expect(result.current.result).toBeNull()
    expect(result.current.loading).toBe(false)
    expect(result.current.rendering).toBe(false)

    act(() =>
      result.current.edit({ manual: { ...NEUTRAL_TRANSFORM, rotate: 3 } }),
    )
    expect(result.current.rendering).toBe(false)
  })

  it('retires the failure of a refused geometry when the owner moves away from it', () => {
    const { result, worker } = setupLoaded()
    // Settle the neutral render first; otherwise the next one only queues.
    act(() => worker.emit(answer(lastRender(worker))))
    act(() =>
      result.current.edit({ manual: { ...NEUTRAL_TRANSFORM, scale: 51 } }),
    )
    act(() => worker.emit(refuse(lastRender(worker))))
    expect(result.current.error).toBe('transform')

    act(() => {
      result.current.edit(createNeutralTransformIntent())
      result.current.retireFailure()
    })
    expect(result.current.error).toBeNull()
  })

  it('reports each request, answer and failure to the owner of the intent', () => {
    const observer = {
      requested: vi.fn(),
      rendered: vi.fn(),
      renderFailed: vi.fn(),
      frameFailed: vi.fn(),
    }
    const { result, worker } = setupLoaded(analysis, observer)
    const neutral = lastRender(worker)
    expect(observer.requested).toHaveBeenLastCalledWith(
      expect.objectContaining({ requestId: neutral.requestId }),
    )
    act(() => worker.emit(answer(neutral)))
    // The size is the loaded frame's, the one the geometry was planned on.
    expect(observer.rendered).toHaveBeenLastCalledWith(
      expect.objectContaining({ requestId: neutral.requestId }),
      { width: 2, height: 2 },
    )

    act(() =>
      result.current.edit({ manual: { ...NEUTRAL_TRANSFORM, rotate: 3 } }),
    )
    const refused = lastRender(worker)
    act(() => worker.emit(refuse(refused)))
    expect(observer.renderFailed).toHaveBeenLastCalledWith(
      expect.objectContaining({ requestId: refused.requestId }),
      'transform',
    )

    // Asking again posts the same geometry as a newer request.
    act(() => result.current.requestRender())
    const again = lastRender(worker)
    expect(again.requestId).toBeGreaterThan(refused.requestId)
    expect(again.matrix).toEqual(refused.matrix)
    expect(observer.frameFailed).not.toHaveBeenCalled()

    // A failed analysis and a dead worker both fail the frame.
    act(() => result.current.loadSource(photo()))
    act(() =>
      worker.emit({
        type: 'error',
        sourceId: lastOf(worker, 'analyze').sourceId,
        phase: 'analysis',
        message: 'processing',
      }),
    )
    expect(observer.frameFailed).toHaveBeenCalledOnce()
    expect(result.current.error).toBe('processing')
    expect(result.current.loading).toBe(false)
    expect(result.current.ready).toBe(false)
    act(() => worker.onerror?.())
    expect(observer.frameFailed).toHaveBeenCalledTimes(2)
    expect(observer.rendered).toHaveBeenCalledOnce()
  })
})
