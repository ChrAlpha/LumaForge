import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { identityMatrix, rotationMatrix } from '~/lib/transform/geometry/matrix'
import type { UprightAnalysis } from '~/lib/transform/geometry/types'
import type { PreviewFrame } from '~/lib/transform/preview-types'
import type { TransformClientEvents } from '~/lib/transform/transform-client'
import { createTransformClient } from '~/lib/transform/transform-client'
import type {
  TransformRenderRequest,
  TransformWorkerRequest,
  TransformWorkerResponse,
} from '~/lib/transform/worker-protocol'

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

class FakeWorker {
  static instances: FakeWorker[] = []
  onmessage: ((event: MessageEvent<TransformWorkerResponse>) => void) | null =
    null
  onerror: (() => void) | null = null
  messages: TransformWorkerRequest[] = []
  terminated = 0
  constructor() {
    FakeWorker.instances.push(this)
  }
  postMessage(message: TransformWorkerRequest) {
    this.messages.push(message)
  }
  terminate() {
    this.terminated++
  }
  emit(data: TransformWorkerResponse) {
    this.onmessage?.({ data } as MessageEvent<TransformWorkerResponse>)
  }
  renders() {
    return this.messages.filter(
      (message): message is TransformRenderRequest => message.type === 'render',
    )
  }
  lastAnalyze() {
    const request = this.messages.findLast(
      (message) => message.type === 'analyze',
    )
    if (request?.type !== 'analyze') throw new Error('expected analyze')
    return request
  }
}

function frame(fill = 0): PreviewFrame {
  return { width: 2, height: 2, data: new Uint8ClampedArray(16).fill(fill) }
}

function renderedFrame() {
  return {
    frame: frame(),
    displayMatrix: identityMatrix(),
    retainedArea: 1,
  }
}

function answer(
  request: TransformRenderRequest,
  result = renderedFrame(),
): TransformWorkerResponse {
  return {
    type: 'rendered',
    sourceId: request.sourceId,
    requestId: request.requestId,
    result,
  }
}

function events() {
  return {
    analyzed: vi.fn(),
    analysisFailed: vi.fn(),
    rendered: vi.fn(),
    renderFailed: vi.fn(),
    crashed: vi.fn(),
  } satisfies TransformClientEvents
}

function setup() {
  const on = events()
  const client = createTransformClient(on, {
    createWorker: () => new FakeWorker() as unknown as Worker,
  })
  return { client, on }
}

/** A client with one frame loaded and its analysis answered. */
function setupAnalysed() {
  const { client, on } = setup()
  client.load(frame())
  const worker = FakeWorker.instances[0]
  worker.emit({
    type: 'analyzed',
    sourceId: worker.lastAnalyze().sourceId,
    analysis,
    elapsedMs: 3,
  })
  return { client, on, worker }
}

const geometry = (degrees: number) => ({
  matrix: rotationMatrix(degrees),
  constrainCrop: true,
})

beforeEach(() => {
  FakeWorker.instances = []
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe('transform worker client', () => {
  it('starts no worker until a frame is loaded', () => {
    setup()
    expect(FakeWorker.instances).toHaveLength(0)
  })

  it('reports only the analysis of the newest frame, however late it lands', () => {
    const { client, on } = setup()
    expect(client.load(frame(1))).toBe(true)
    const worker = FakeWorker.instances[0]
    const old = worker.lastAnalyze()
    expect(client.load(frame(2))).toBe(true)
    const next = worker.lastAnalyze()
    expect(FakeWorker.instances).toHaveLength(1)
    expect(next.sourceId).toBeGreaterThan(old.sourceId)
    expect(next.frame.data[0]).toBe(2)

    worker.emit({
      type: 'analyzed',
      sourceId: old.sourceId,
      analysis,
      elapsedMs: 1,
    })
    expect(on.analyzed).not.toHaveBeenCalled()

    worker.emit({
      type: 'analyzed',
      sourceId: next.sourceId,
      analysis,
      elapsedMs: 7,
    })
    expect(on.analyzed).toHaveBeenCalledExactlyOnceWith(analysis, 7)
  })

  it('reports a failed analysis of the current frame', () => {
    const { client, on } = setup()
    client.load(frame())
    const worker = FakeWorker.instances[0]
    worker.emit({
      type: 'error',
      sourceId: worker.lastAnalyze().sourceId,
      phase: 'analysis',
      message: 'processing-failed',
    })
    expect(on.analysisFailed).toHaveBeenCalledOnce()
    expect(on.renderFailed).not.toHaveBeenCalled()
  })

  it('keeps one render in flight and posts only the newest pending one', () => {
    const { client, on, worker } = setupAnalysed()
    const a = client.render(geometry(1))
    const b = client.render(geometry(2))
    const c = client.render(geometry(3))
    expect([a.posted, b.posted, c.posted]).toEqual([true, true, true])
    expect(worker.renders()).toEqual([a.request])
    expect(c.request.requestId).toBeGreaterThan(b.request.requestId)

    // A answered a request the newest one replaced: nothing is published,
    // and C, not B, takes its place in flight.
    worker.emit(answer(a.request))
    expect(on.rendered).not.toHaveBeenCalled()
    expect(worker.renders()).toEqual([a.request, c.request])

    const result = renderedFrame()
    worker.emit(answer(c.request, result))
    expect(on.rendered).toHaveBeenCalledExactlyOnceWith(c.request, result)
    expect(worker.renders()).toHaveLength(2)
    // The request handed back is the one posted, geometry included.
    expect(on.rendered.mock.calls[0][0].matrix).toEqual(rotationMatrix(3))
  })

  it('ignores obsolete and out-of-order replies', () => {
    const { client, on, worker } = setupAnalysed()
    const a = client.render(geometry(1))
    worker.emit(answer(a.request))
    expect(on.rendered).toHaveBeenCalledTimes(1)
    const b = client.render(geometry(2))
    worker.emit(answer(b.request))
    expect(on.rendered).toHaveBeenCalledTimes(2)

    worker.emit(answer(a.request))
    worker.emit({
      type: 'error',
      sourceId: a.request.sourceId,
      requestId: a.request.requestId,
      phase: 'render',
      message: 'invalid-transform',
    })
    expect(on.rendered).toHaveBeenCalledTimes(2)
    expect(on.renderFailed).not.toHaveBeenCalled()
    expect(on.analysisFailed).not.toHaveBeenCalled()
  })

  it('names a refused geometry apart from a failed render', () => {
    const { client, on, worker } = setupAnalysed()
    const refused = client.render(geometry(1)).request
    worker.emit({
      type: 'error',
      sourceId: refused.sourceId,
      requestId: refused.requestId,
      phase: 'render',
      message: 'invalid-transform',
    })
    expect(on.renderFailed).toHaveBeenLastCalledWith(refused, 'transform')

    const failed = client.render(geometry(2)).request
    worker.emit({
      type: 'error',
      sourceId: failed.sourceId,
      requestId: failed.requestId,
      phase: 'render',
      message: 'invalid-image',
    })
    expect(on.renderFailed).toHaveBeenLastCalledWith(failed, 'processing')
  })

  it('retires every reply for a frame that was replaced or cleared', () => {
    const { client, on, worker } = setupAnalysed()
    const a = client.render(geometry(1)).request
    client.render(geometry(2))
    client.load(frame(9))
    const refresh = worker.lastAnalyze()
    worker.emit(answer(a))
    expect(on.rendered).not.toHaveBeenCalled()
    // The queued render belonged to the old frame and is never posted.
    expect(worker.renders()).toEqual([a])

    worker.emit({
      type: 'analyzed',
      sourceId: refresh.sourceId,
      analysis,
      elapsedMs: 1,
    })
    const fresh = client.render(geometry(1))
    // Nothing is in flight for the new frame, so it goes out at once.
    expect(worker.renders()).toEqual([a, fresh.request])
    expect(fresh.request.sourceId).toBe(refresh.sourceId)

    client.clear()
    expect(worker.messages.at(-1)).toEqual({
      type: 'clear',
      sourceId: refresh.sourceId + 1,
    })
    worker.emit(answer(fresh.request))
    worker.emit({
      type: 'analyzed',
      sourceId: refresh.sourceId,
      analysis,
      elapsedMs: 1,
    })
    expect(on.rendered).not.toHaveBeenCalled()
    expect(on.analyzed).toHaveBeenCalledTimes(2)
    expect(worker.terminated).toBe(0)
  })

  it('reports a worker crash on the current frame and starts a new worker on the next load', () => {
    const { client, on, worker } = setupAnalysed()
    worker.onerror?.()
    expect(worker.terminated).toBe(1)
    expect(on.crashed).toHaveBeenCalledOnce()

    // Without a worker a render cannot be answered, so it is not posted.
    expect(client.render(geometry(1)).posted).toBe(false)
    expect(worker.renders()).toHaveLength(0)

    client.load(frame())
    expect(FakeWorker.instances).toHaveLength(2)
    expect(FakeWorker.instances[1].lastAnalyze().sourceId).toBeGreaterThan(
      worker.lastAnalyze().sourceId,
    )
    // The dead worker's handlers no longer reach the client.
    worker.onerror?.()
    worker.emit({
      type: 'analyzed',
      sourceId: FakeWorker.instances[1].lastAnalyze().sourceId,
      analysis,
      elapsedMs: 1,
    })
    expect(on.crashed).toHaveBeenCalledOnce()
    expect(on.analyzed).toHaveBeenCalledOnce()
  })

  it('terminates a worker that crashes after its frame was cleared without reporting it', () => {
    const { client, on } = setup()
    client.load(frame())
    const worker = FakeWorker.instances[0]
    client.clear()
    worker.onerror?.()
    expect(worker.terminated).toBe(1)
    expect(on.crashed).not.toHaveBeenCalled()
    client.load(frame())
    expect(FakeWorker.instances).toHaveLength(2)
  })

  it('reports a worker that cannot start', () => {
    const on = events()
    const client = createTransformClient(on, {
      createWorker: () => {
        throw new Error('blocked')
      },
    })
    expect(client.load(frame())).toBe(false)
    expect(client.render(geometry(1)).posted).toBe(false)
    expect(on.crashed).not.toHaveBeenCalled()
  })

  it('publishes nothing after disposal and survives repeated disposal', () => {
    const { client, on, worker } = setupAnalysed()
    const a = client.render(geometry(1)).request
    client.render(geometry(2))
    client.dispose()
    client.dispose()
    expect(worker.terminated).toBe(1)

    worker.emit(answer(a))
    worker.emit({
      type: 'analyzed',
      sourceId: a.sourceId,
      analysis,
      elapsedMs: 1,
    })
    worker.onerror?.()
    expect(on.rendered).not.toHaveBeenCalled()
    expect(on.analyzed).toHaveBeenCalledOnce()
    expect(on.crashed).not.toHaveBeenCalled()
    expect(worker.renders()).toEqual([a])
    expect(client.render(geometry(3)).posted).toBe(false)

    // A disposed client starts over on the next frame it is handed.
    client.load(frame())
    expect(FakeWorker.instances).toHaveLength(2)
    expect(FakeWorker.instances[1].lastAnalyze().sourceId).toBeGreaterThan(
      a.sourceId,
    )
  })

  it('creates the production worker when no factory is given', () => {
    vi.stubGlobal('Worker', FakeWorker)
    const client = createTransformClient(events())
    client.load(frame())
    expect(FakeWorker.instances).toHaveLength(1)
    expect(FakeWorker.instances[0].messages[0].type).toBe('analyze')
    client.dispose()
  })

  it('distinguishes repeated local request IDs across client lifetimes', () => {
    const { client: clientA, on: onA } = setup()
    const { client: clientB, on: onB } = setup()
    // Each client is its own lifetime; its epoch is fixed at creation.
    expect(Number.isInteger(clientA.epoch)).toBe(true)
    expect(clientB.epoch).toBeGreaterThan(clientA.epoch)

    // Both clients number their first frame and render alike.
    clientA.load(frame(1))
    clientB.load(frame(2))
    const [workerA, workerB] = FakeWorker.instances
    const analyzeA = workerA.lastAnalyze()
    const analyzeB = workerB.lastAnalyze()
    expect(analyzeB.sourceId).toBe(analyzeA.sourceId)

    // Analysis: A fails, B completes; each failure phase reaches only its
    // own client.
    workerA.emit({
      type: 'error',
      sourceId: analyzeA.sourceId,
      phase: 'analysis',
      message: 'processing-failed',
    })
    workerB.emit({
      type: 'analyzed',
      sourceId: analyzeB.sourceId,
      analysis,
      elapsedMs: 2,
    })
    expect(onA.analysisFailed).toHaveBeenCalledOnce()
    expect(onA.analyzed).not.toHaveBeenCalled()
    expect(onB.analyzed).toHaveBeenCalledExactlyOnceWith(analysis, 2)
    expect(onB.analysisFailed).not.toHaveBeenCalled()

    // A reloads its frame; the analysis completes this time.
    clientA.load(frame(1))
    const reanalyzeA = workerA.lastAnalyze()
    workerA.emit({
      type: 'analyzed',
      sourceId: reanalyzeA.sourceId,
      analysis,
      elapsedMs: 1,
    })
    expect(onA.analyzed).toHaveBeenCalledOnce()

    // Renders: the same local (sourceId, requestId) once B also reloads, told
    // apart only by the epoch.
    clientB.load(frame(2))
    workerB.emit({
      type: 'analyzed',
      sourceId: workerB.lastAnalyze().sourceId,
      analysis,
      elapsedMs: 2,
    })
    const renderA = clientA.render(geometry(1)).request
    const renderB = clientB.render(geometry(2)).request
    expect([renderB.sourceId, renderB.requestId]).toEqual([
      renderA.sourceId,
      renderA.requestId,
    ])
    expect(clientA.epoch).not.toBe(clientB.epoch)

    // A's render fails as a render, B's completes.
    workerA.emit({
      type: 'error',
      sourceId: renderA.sourceId,
      requestId: renderA.requestId,
      phase: 'render',
      message: 'invalid-transform',
    })
    workerB.emit(answer(renderB))
    expect(onA.renderFailed).toHaveBeenCalledExactlyOnceWith(
      renderA,
      'transform',
    )
    expect(onA.analysisFailed).toHaveBeenCalledOnce()
    expect(onA.rendered).not.toHaveBeenCalled()
    expect(onB.rendered).toHaveBeenCalledOnce()
    expect(onB.renderFailed).not.toHaveBeenCalled()

    // A disposes with a render in flight; every late event from its worker
    // is dropped: completion, both failure phases, analysis, and a crash.
    const lateA = clientA.render(geometry(3)).request
    clientA.dispose()
    workerA.emit(answer(lateA))
    workerA.emit({
      type: 'error',
      sourceId: lateA.sourceId,
      requestId: lateA.requestId,
      phase: 'render',
      message: 'invalid-image',
    })
    workerA.emit({
      type: 'error',
      sourceId: lateA.sourceId,
      phase: 'analysis',
      message: 'processing-failed',
    })
    workerA.emit({
      type: 'analyzed',
      sourceId: lateA.sourceId,
      analysis,
      elapsedMs: 9,
    })
    workerA.onerror?.()
    expect(onA.rendered).not.toHaveBeenCalled()
    expect(onA.renderFailed).toHaveBeenCalledOnce()
    expect(onA.analysisFailed).toHaveBeenCalledOnce()
    expect(onA.analyzed).toHaveBeenCalledOnce()
    expect(onA.crashed).not.toHaveBeenCalled()

    // B's lifetime is untouched and keeps its own numbering.
    const nextB = clientB.render(geometry(4)).request
    expect(nextB.requestId).toBe(renderB.requestId + 1)
    workerB.emit({
      type: 'error',
      sourceId: nextB.sourceId,
      requestId: nextB.requestId,
      phase: 'render',
      message: 'invalid-image',
    })
    expect(onB.renderFailed).toHaveBeenCalledExactlyOnceWith(
      nextB,
      'processing',
    )
    expect(onB.analysisFailed).not.toHaveBeenCalled()

    // A disposed client keeps its epoch when it starts over; a client made
    // after it never reuses one.
    const epochA = clientA.epoch
    clientA.load(frame(1))
    expect(clientA.epoch).toBe(epochA)
    const { client: clientC } = setup()
    expect(clientC.epoch).toBeGreaterThan(clientB.epoch)
    clientA.dispose()
    clientB.dispose()
  })
})
