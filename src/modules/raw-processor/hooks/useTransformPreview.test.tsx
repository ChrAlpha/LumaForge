import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { act, renderHook } from '@testing-library/react'
import type { SetStateAction } from 'react'
import { StrictMode, useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { identityMatrix, rotationMatrix } from '~/lib/transform/geometry/matrix'
import type {
  UprightAnalysis,
  UprightMode,
} from '~/lib/transform/geometry/types'
import type { PreviewSource } from '~/lib/transform/preview-types'
import type { ManualTransform } from '~/lib/transform/transform-types'
import { NEUTRAL_TRANSFORM } from '~/lib/transform/transform-types'
import type {
  TransformWorkerRequest,
  TransformWorkerResponse,
} from '~/lib/transform/worker-protocol'

import type { TransformIntent } from '../model/session'
import { createNeutralTransformIntent } from '../model/session-factory'
import type { TransformPreviewObserver } from './useTransformPreview'
import { useTransformPreview } from './useTransformPreview'

/**
 * The preview under an intent its owner holds, with the owner's controls:
 * the preview itself keeps no intent.
 */
function useOwnedPreview(observer?: TransformPreviewObserver) {
  const [intent, setIntent] = useState<TransformIntent>(
    createNeutralTransformIntent,
  )
  const preview = useTransformPreview(intent, observer)
  return {
    ...preview,
    mode: intent.upright,
    manual: intent.manual,
    constrainCrop: intent.constrainCrop,
    setMode: (upright: UprightMode) => {
      setIntent((previous) => ({ ...previous, upright }))
      preview.solveUpright()
    },
    setManual: (manual: SetStateAction<ManualTransform>) =>
      setIntent((previous) => ({
        ...previous,
        manual: typeof manual === 'function' ? manual(previous.manual) : manual,
      })),
    setConstrainCrop: (constrainCrop: boolean) =>
      setIntent((previous) => ({ ...previous, constrainCrop })),
    reset: () => {
      setIntent(createNeutralTransformIntent())
      preview.retireFailure()
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

function photo(name = 'current.nef', fill = 0): PreviewSource {
  return {
    name,
    kind: 'raw',
    originalWidth: 6000,
    originalHeight: 4000,
    frame: { width: 2, height: 2, data: new Uint8ClampedArray(16).fill(fill) },
  }
}

function lastRender(worker: PreviewWorker): RenderRequest {
  const request = worker.messages.findLast(
    (message) => message.type === 'render',
  )
  if (request?.type !== 'render') throw new Error('expected render')
  return request
}

function lastAnalyze(worker: PreviewWorker) {
  const request = worker.messages.findLast(
    (message) => message.type === 'analyze',
  )
  if (request?.type !== 'analyze') throw new Error('expected analyze')
  return request
}

function analyze(worker: PreviewWorker, result: UprightAnalysis = analysis) {
  act(() =>
    worker.emit({
      type: 'analyzed',
      sourceId: lastAnalyze(worker).sourceId,
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

/** A hook with one current-photo frame loaded and analysed. */
function setupLoaded() {
  const hook = renderHook(() => useOwnedPreview())
  act(() => hook.result.current.loadSource(photo()))
  const worker = PreviewWorker.instances[0]
  analyze(worker)
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

describe('transform preview request lifecycle', () => {
  it('starts no worker until a frame is loaded and reuses it across clears', () => {
    const { result, unmount } = renderHook(() => useOwnedPreview())
    expect(PreviewWorker.instances).toHaveLength(0)
    act(() => result.current.loadSource(photo()))
    act(() => {
      result.current.setMode('vertical')
      result.current.setManual((prev) => ({ ...prev, rotate: 2 }))
    })
    act(() =>
      result.current.loadSource(photo('current.nef', 100), {
        preserveTransform: true,
      }),
    )
    expect(result.current.mode).toBe('vertical')
    expect(result.current.manual.rotate).toBe(2)
    const worker = PreviewWorker.instances[0]
    // The first frame's analysis answers a source that was replaced.
    act(() =>
      worker.emit({
        type: 'analyzed',
        sourceId: worker.messages[0].sourceId,
        analysis,
        elapsedMs: 10,
      }),
    )
    expect(result.current.analysis).toBeNull()
    act(() => result.current.clearSource())
    expect(worker.terminated).toBe(false)
    expect(worker.messages.at(-1)).toMatchObject({ type: 'clear' })
    expect(result.current.source).toBeNull()
    expect(result.current.ready).toBe(false)
    // The intent is its owner's: clearing the frame leaves it where it is.
    expect(result.current.mode).toBe('vertical')
    expect(result.current.manual.rotate).toBe(2)
    unmount()
    expect(worker.terminated).toBe(true)
  })

  it('solves a new photo afresh unless asked to keep its Upright solutions', () => {
    const tilted = rotationMatrix(4)
    const { result, unmount, worker } = setupLoaded()
    act(() => {
      result.current.setMode('auto')
      result.current.setManual({ ...NEUTRAL_TRANSFORM, rotate: 4 })
      result.current.setConstrainCrop(false)
    })
    act(() => result.current.loadSource(photo('next.nef')))
    // The intent stays its owner's; only what was solved on the old photo
    // goes with it.
    expect(result.current.mode).toBe('auto')
    expect(result.current.manual.rotate).toBe(4)
    expect(result.current.constrainCrop).toBe(false)
    expect(result.current.source?.name).toBe('next.nef')
    expect(result.current.loading).toBe(true)
    expect(result.current.matrix).toBeNull()
    expect(result.current.solution.status).toBe('unchanged')
    analyze(worker, {
      ...analysis,
      solutions: {
        ...analysis.solutions,
        auto: { ...solution, matrix: tilted },
      },
    })
    expect(result.current.solution.matrix).toEqual(tilted)
    expect(lastRender(worker).constrainCrop).toBe(false)
    unmount()
  })

  it('ignores the analysis of a source superseded before it landed', () => {
    const { result, unmount } = renderHook(() => useOwnedPreview())
    act(() => result.current.loadSource(photo('old.nef')))
    const worker = PreviewWorker.instances[0]
    const old = lastAnalyze(worker)
    act(() => result.current.loadSource(photo('new.nef')))
    const next = lastAnalyze(worker)
    expect(next.sourceId).toBeGreaterThan(old.sourceId)
    act(() =>
      worker.emit({
        type: 'analyzed',
        sourceId: old.sourceId,
        analysis,
        elapsedMs: 1,
      }),
    )
    expect(result.current.analysis).toBeNull()
    expect(result.current.ready).toBe(false)
    expect(result.current.source?.name).toBe('new.nef')
    expect(PreviewWorker.instances).toHaveLength(1)
    analyze(worker)
    expect(result.current.ready).toBe(true)
    expect(lastRender(worker).sourceId).toBe(next.sourceId)
    unmount()
  })

  it('keeps the selected geometry during color refresh until the mode is selected again', () => {
    const selectedMatrix = rotationMatrix(5)
    const updatedMatrix = rotationMatrix(-3)
    const { result, unmount } = renderHook(() => useOwnedPreview())
    act(() => result.current.loadSource(photo()))
    const worker = PreviewWorker.instances[0]
    analyze(worker, {
      ...analysis,
      solutions: {
        ...analysis.solutions,
        auto: { ...solution, matrix: selectedMatrix },
      },
    })
    act(() => result.current.setMode('auto'))
    act(() =>
      result.current.loadSource(photo('current.nef', 50), {
        preserveTransform: true,
      }),
    )
    analyze(worker, {
      ...analysis,
      solutions: {
        ...analysis.solutions,
        auto: { ...solution, matrix: updatedMatrix },
      },
    })
    expect(result.current.solution.matrix).toEqual(selectedMatrix)
    expect(lastRender(worker).matrix).toEqual(selectedMatrix)
    act(() => result.current.setMode('auto'))
    expect(result.current.solution.matrix).toEqual(updatedMatrix)
    unmount()
  })

  it('reuses its live worker after clearing the source and ignores old queued responses', () => {
    const { result, unmount, worker } = setupLoaded()
    const firstId = worker.messages[0].sourceId
    const oldRender = lastRender(worker)
    act(() => result.current.setMode('auto'))
    act(() => result.current.clearSource())
    const clearedCount = worker.messages.length
    act(() => worker.emit(answer(oldRender)))
    expect(worker.messages).toHaveLength(clearedCount)
    expect(result.current.result).toBeNull()
    expect(result.current.ready).toBe(false)

    act(() => result.current.loadSource(photo()))
    expect(PreviewWorker.instances).toHaveLength(1)
    expect(worker.terminated).toBe(false)
    const next = worker.messages.at(-1)!
    expect(next.type).toBe('analyze')
    expect(next.sourceId).toBeGreaterThan(firstId)
    analyze(worker)
    expect(result.current.ready).toBe(true)
    expect(worker.messages.at(-1)?.type).toBe('render')
    unmount()
    expect(worker.terminated).toBe(true)
  })

  it('disposes a failed worker without reporting its stale error after clearing', () => {
    const { result, unmount } = renderHook(() => useOwnedPreview())
    act(() => result.current.loadSource(photo()))
    const worker = PreviewWorker.instances[0]
    act(() => result.current.clearSource())
    act(() => worker.onerror?.())

    expect(worker.terminated).toBe(true)
    expect(result.current.error).toBeNull()
    expect(result.current.source).toBeNull()
    act(() => result.current.loadSource(photo()))
    expect(PreviewWorker.instances).toHaveLength(2)
    expect(PreviewWorker.instances[1].terminated).toBe(false)
    unmount()
  })

  it('reports a worker crash on the current source and drops its frame', () => {
    const { result, unmount, worker } = setupLoaded()
    act(() => worker.emit(answer(lastRender(worker))))
    expect(result.current.result).not.toBeNull()
    act(() => worker.onerror?.())

    expect(worker.terminated).toBe(true)
    expect(result.current.error).toBe('processing')
    expect(result.current.analysis).toBeNull()
    // A crashed worker cannot refresh the frame it produced, so nothing may
    // still read as a current render.
    expect(result.current.result).toBeNull()
    expect(result.current.acknowledged).toBeNull()
    expect(result.current.loading).toBe(false)
    expect(result.current.rendering).toBe(false)
    unmount()
  })

  it('reports a failed analysis of the current source as a processing error', () => {
    const { result, unmount } = renderHook(() => useOwnedPreview())
    act(() => result.current.loadSource(photo()))
    const worker = PreviewWorker.instances[0]
    act(() =>
      worker.emit({
        type: 'error',
        sourceId: lastAnalyze(worker).sourceId,
        phase: 'analysis',
        message: 'processing',
      }),
    )
    expect(result.current.error).toBe('processing')
    expect(result.current.loading).toBe(false)
    expect(result.current.ready).toBe(false)
    unmount()
  })

  it('retires a rejected geometry and its failure together on reset', () => {
    const { result, unmount, worker } = setupLoaded()
    // Settle the neutral render first; otherwise the next one only queues.
    const first = lastRender(worker)
    act(() => worker.emit(answer(first)))
    act(() => result.current.setManual({ ...result.current.manual, scale: 51 }))
    const rejected = lastRender(worker)
    expect(rejected.requestId).not.toBe(first.requestId)
    act(() =>
      worker.emit({
        type: 'error',
        sourceId: rejected.sourceId,
        requestId: rejected.requestId,
        phase: 'render',
        message: 'invalid-transform',
      }),
    )
    expect(result.current.error).toBe('transform')

    act(() => result.current.reset())

    // The alert named the geometry reset just discarded; it must not outlive
    // it and keep the tool reading as broken.
    expect(result.current.error).toBeNull()
    expect(result.current.manual.scale).toBe(100)
    unmount()
  })

  it('does not strand the render queue when the worker is already gone', () => {
    const { result, unmount, worker } = setupLoaded()
    act(() => worker.onerror?.())
    expect(result.current.result).toBeNull()
    expect(result.current.rendering).toBe(false)

    act(() => result.current.setManual({ ...result.current.manual, rotate: 3 }))
    // Without a worker the request cannot be answered, and claiming it is in
    // flight would leave the tool busy forever.
    expect(result.current.rendering).toBe(false)
    unmount()
  })

  it('keeps a live worker after StrictMode replays the mount effect', () => {
    const { result, unmount } = renderHook(() => useOwnedPreview(), {
      wrapper: StrictMode,
    })
    act(() => result.current.loadSource(photo()))
    expect(PreviewWorker.instances).toHaveLength(1)
    const [live] = PreviewWorker.instances
    expect(live.terminated).toBe(false)
    analyze(live)
    expect(result.current.ready).toBe(true)
    expect(live.messages.some((message) => message.type === 'render')).toBe(
      true,
    )
    unmount()
    expect(live.terminated).toBe(true)
  })

  it('coalesces slider work and only displays the newest render', () => {
    const { result, unmount, worker } = setupLoaded()
    expect(worker.messages).toHaveLength(2)
    const first = lastRender(worker)
    act(() => result.current.setMode('level'))
    act(() => result.current.setMode('full'))
    expect(worker.messages).toHaveLength(2)
    const rendered = renderedFrame()
    act(() => worker.emit(answer(first, rendered)))
    expect(result.current.result).toBeNull()
    expect(worker.messages).toHaveLength(3)
    const latest = lastRender(worker)
    act(() => worker.emit(answer(latest, rendered)))
    expect(result.current.result).toEqual(rendered)
    expect(result.current.rendering).toBe(false)
    unmount()
    expect(worker.terminated).toBe(true)
  })

  it('acknowledges only the geometry the worker rendered for the newest request', () => {
    const { result, unmount, worker } = setupLoaded()
    const sourceId = worker.messages[0].sourceId
    const neutral = lastRender(worker)
    // A request nobody has answered acknowledges nothing.
    expect(result.current.acknowledged).toBeNull()
    act(() => worker.emit(answer(neutral)))
    expect(result.current.acknowledged).toEqual({
      sourceId,
      requestId: neutral.requestId,
      matrix: neutral.matrix,
      constrainCrop: true,
    })

    const frameA = renderedFrame()
    act(() => result.current.setManual({ ...NEUTRAL_TRANSFORM, rotate: 3 }))
    const a = lastRender(worker)
    expect(a.requestId).toBeGreaterThan(neutral.requestId)
    expect(result.current.acknowledged).toBeNull()
    act(() => worker.emit(answer(a, frameA)))
    expect(result.current.acknowledged).toEqual({
      sourceId,
      requestId: a.requestId,
      matrix: a.matrix,
      constrainCrop: true,
    })

    // B is pending: A's frame stays on screen but no longer answers.
    act(() => result.current.setManual({ ...NEUTRAL_TRANSFORM, rotate: 6 }))
    const b = lastRender(worker)
    expect(b.requestId).toBeGreaterThan(a.requestId)
    expect(result.current.acknowledged).toBeNull()
    expect(result.current.result).toBe(frameA)

    // B is refused: the last valid frame survives, still unacknowledged.
    act(() =>
      worker.emit({
        type: 'error',
        sourceId,
        requestId: b.requestId,
        phase: 'render',
        message: 'invalid-transform',
      }),
    )
    expect(result.current.error).toBe('transform')
    expect(result.current.result).toBe(frameA)
    expect(result.current.acknowledged).toBeNull()

    // A late copy of A's answer cannot stand in for B.
    act(() => worker.emit(answer(a)))
    expect(result.current.result).toBe(frameA)
    expect(result.current.acknowledged).toBeNull()
    unmount()
  })

  it('ignores answers to superseded requests, whatever the controls ask when they land', () => {
    const { result, unmount, worker } = setupLoaded()
    const sourceId = worker.messages[0].sourceId
    const neutral = lastRender(worker)
    // Two edits queue behind the neutral render; only the newest is posted.
    act(() => result.current.setManual({ ...NEUTRAL_TRANSFORM, rotate: 3 }))
    act(() => result.current.setManual({ ...NEUTRAL_TRANSFORM, rotate: 4 }))
    act(() => worker.emit(answer(neutral)))
    expect(result.current.result).toBeNull()
    expect(result.current.acknowledged).toBeNull()
    const b = lastRender(worker)
    expect(b.requestId).toBeGreaterThan(neutral.requestId)

    // The controls move on while B is in flight, so B's answer is stale.
    act(() => result.current.setManual({ ...NEUTRAL_TRANSFORM, rotate: 5 }))
    act(() => worker.emit(answer(b)))
    expect(result.current.result).toBeNull()
    expect(result.current.acknowledged).toBeNull()
    const c = lastRender(worker)
    expect(c.requestId).toBeGreaterThan(b.requestId)

    const frameC = renderedFrame()
    act(() => worker.emit(answer(c, frameC)))
    expect(result.current.result).toBe(frameC)
    // The acknowledgement carries the geometry C asked for.
    expect(result.current.acknowledged).toEqual({
      sourceId,
      requestId: c.requestId,
      matrix: c.matrix,
      constrainCrop: true,
    })

    // Out-of-order answers to older requests change nothing.
    act(() => worker.emit(answer(b)))
    act(() => worker.emit(answer(neutral)))
    expect(result.current.result).toBe(frameC)
    expect(result.current.acknowledged?.requestId).toBe(c.requestId)
    unmount()
  })

  it('publishes no late reply after unmount', () => {
    const { result, unmount, worker } = setupLoaded()
    const pending = lastRender(worker)
    const before = result.current
    unmount()
    expect(worker.terminated).toBe(true)
    act(() => worker.emit(answer(pending)))
    act(() => worker.onerror?.())
    expect(result.current).toBe(before)
    expect(result.current.result).toBeNull()
    expect(result.current.error).toBeNull()
  })

  it('drops the acknowledgement when the frame is replaced or the geometry reset', () => {
    const { result, unmount, worker } = setupLoaded()
    act(() => worker.emit(answer(lastRender(worker))))
    act(() => result.current.setManual({ ...NEUTRAL_TRANSFORM, rotate: 3 }))
    const a = lastRender(worker)
    act(() => worker.emit(answer(a)))
    expect(result.current.acknowledged?.requestId).toBe(a.requestId)

    // A colour refresh replaces the frame; A answered the old one.
    act(() =>
      result.current.loadSource(photo('refresh.nef'), {
        preserveTransform: true,
      }),
    )
    expect(result.current.manual.rotate).toBe(3)
    expect(result.current.acknowledged).toBeNull()
    act(() => worker.emit(answer(a)))
    expect(result.current.acknowledged).toBeNull()

    const refresh = worker.messages.at(-1)!
    expect(refresh.type).toBe('analyze')
    analyze(worker)
    const again = lastRender(worker)
    // Same geometry, asked again of the new frame.
    expect(again.sourceId).toBe(refresh.sourceId)
    expect(again.matrix).toEqual(a.matrix)
    expect(result.current.acknowledged).toBeNull()
    act(() => worker.emit(answer(again)))
    expect(result.current.acknowledged).toEqual({
      sourceId: refresh.sourceId,
      requestId: again.requestId,
      matrix: a.matrix,
      constrainCrop: true,
    })

    act(() => result.current.reset())
    expect(result.current.acknowledged).toBeNull()
    act(() => worker.emit(answer(lastRender(worker))))
    expect(result.current.acknowledged?.matrix).toEqual(identityMatrix())

    act(() => result.current.clearSource())
    expect(result.current.acknowledged).toBeNull()
    unmount()
  })
})

describe('transform preview observer', () => {
  it('reports each request, answer and failure to the owner of the intent', () => {
    const observer = {
      requested: vi.fn(),
      rendered: vi.fn(),
      renderFailed: vi.fn(),
      frameFailed: vi.fn(),
    }
    const { result, unmount } = renderHook(() => useOwnedPreview(observer))
    act(() => result.current.loadSource(photo()))
    const worker = PreviewWorker.instances[0]
    analyze(worker)
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

    act(() => result.current.setManual({ ...NEUTRAL_TRANSFORM, rotate: 3 }))
    const refused = lastRender(worker)
    act(() =>
      worker.emit({
        type: 'error',
        sourceId: refused.sourceId,
        requestId: refused.requestId,
        phase: 'render',
        message: 'invalid-transform',
      }),
    )
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
    act(() => result.current.loadSource(photo('next.nef')))
    act(() =>
      worker.emit({
        type: 'error',
        sourceId: lastAnalyze(worker).sourceId,
        phase: 'analysis',
        message: 'processing',
      }),
    )
    expect(observer.frameFailed).toHaveBeenCalledOnce()
    act(() => worker.onerror?.())
    expect(observer.frameFailed).toHaveBeenCalledTimes(2)
    expect(observer.rendered).toHaveBeenCalledOnce()
    unmount()
  })
})

describe('production transform preview ownership', () => {
  it('loads only frames it is handed, never demo files or samples', () => {
    const source = readFileSync(
      resolve(
        process.cwd(),
        'src/modules/raw-processor/hooks/useTransformPreview.ts',
      ),
      'utf8',
    )
    expect(source).not.toMatch(/transform-demo/)
    expect(source).not.toMatch(/image-input|demo-sample/)
  })

  it('leaves the worker transport to the typed client', () => {
    const source = readFileSync(
      resolve(
        process.cwd(),
        'src/modules/raw-processor/hooks/useTransformPreview.ts',
      ),
      'utf8',
    )
    expect(source).toMatch(/from '~\/lib\/transform\/transform-client'/)
    expect(source).not.toMatch(/new Worker|postMessage|onmessage|onerror/)
    expect(source).not.toMatch(/worker-protocol|transform\.worker/)
  })
})
