import { act, renderHook, waitFor } from '@testing-library/react'
import { StrictMode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { identityMatrix, rotationMatrix } from './geometry/matrix'
import type { UprightAnalysis } from './geometry/types'
import { loadImageInput } from './image-input'
import type { PreviewSource } from './preview-types'
import { useTransformDemo } from './useTransformDemo'
import type {
  TransformWorkerRequest,
  TransformWorkerResponse,
} from './worker-protocol'

vi.mock('./demo-sample', () => ({
  createDemoSample: () => ({
    name: 'sample',
    kind: 'sample',
    originalWidth: 2,
    originalHeight: 2,
    frame: { width: 2, height: 2, data: new Uint8ClampedArray(16) },
  }),
}))
vi.mock('./image-input', () => ({ loadImageInput: vi.fn() }))

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

class DemoWorker {
  static instances: DemoWorker[] = []
  onmessage: ((event: MessageEvent<TransformWorkerResponse>) => void) | null =
    null
  onerror: (() => void) | null = null
  messages: TransformWorkerRequest[] = []
  terminated = false
  constructor() {
    DemoWorker.instances.push(this)
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

function setup() {
  DemoWorker.instances = []
  vi.stubGlobal('Worker', DemoWorker)
  return renderHook(() => useTransformDemo())
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('transform demo request lifecycle', () => {
  it('keeps the selected geometry during color refresh until the mode is selected again', async () => {
    const { result, unmount } = setup()
    const worker = DemoWorker.instances[0]
    const selectedMatrix = rotationMatrix(5)
    const updatedMatrix = rotationMatrix(-3)
    const first = {
      ...analysis,
      solutions: {
        ...analysis.solutions,
        auto: { ...solution, matrix: selectedMatrix },
      },
    }
    act(() =>
      worker.emit({
        type: 'analyzed',
        sourceId: worker.messages[0].sourceId,
        analysis: first,
        elapsedMs: 10,
      }),
    )
    act(() => result.current.setMode('auto'))
    const current: PreviewSource = {
      name: 'same-photo.nef',
      kind: 'raw',
      originalWidth: 2,
      originalHeight: 2,
      frame: { width: 2, height: 2, data: new Uint8ClampedArray(16) },
    }
    await act(() =>
      result.current.loadSource(current, { preserveTransform: true }),
    )
    const request = worker.messages.at(-1)!
    const fresh = {
      ...analysis,
      solutions: {
        ...analysis.solutions,
        auto: { ...solution, matrix: updatedMatrix },
      },
    }
    act(() =>
      worker.emit({
        type: 'analyzed',
        sourceId: request.sourceId,
        analysis: fresh,
        elapsedMs: 10,
      }),
    )
    expect(result.current.solution.matrix).toEqual(selectedMatrix)
    const render = worker.messages.at(-1)!
    expect(render.type === 'render' && render.matrix).toEqual(selectedMatrix)
    act(() => result.current.setMode('auto'))
    expect(result.current.solution.matrix).toEqual(updatedMatrix)
    unmount()
  })

  it('accepts current-photo frames without reopening files and preserves edits on refresh', async () => {
    DemoWorker.instances = []
    vi.stubGlobal('Worker', DemoWorker)
    const { result, unmount } = renderHook(() =>
      useTransformDemo({ autoLoadSample: false }),
    )
    expect(DemoWorker.instances).toHaveLength(0)
    const current: PreviewSource = {
      name: 'current.nef',
      kind: 'raw',
      originalWidth: 6000,
      originalHeight: 4000,
      frame: { width: 2, height: 2, data: new Uint8ClampedArray(16) },
    }
    await act(() => result.current.loadSource(current))
    expect(loadImageInput).not.toHaveBeenCalled()
    act(() => {
      result.current.setMode('vertical')
      result.current.setManual((prev) => ({ ...prev, rotate: 2 }))
    })
    await act(() =>
      result.current.loadSource(
        {
          ...current,
          frame: {
            ...current.frame,
            data: new Uint8ClampedArray(16).fill(100),
          },
        },
        { preserveTransform: true },
      ),
    )
    expect(result.current.mode).toBe('vertical')
    expect(result.current.manual.rotate).toBe(2)
    const worker = DemoWorker.instances[0]
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
    expect(result.current.mode).toBe('off')
    expect(result.current.manual.rotate).toBe(0)
    unmount()
    expect(worker.terminated).toBe(true)
  })

  it('reuses its live worker after clearing the source and ignores old queued responses', async () => {
    const { result, unmount } = setup()
    const worker = DemoWorker.instances[0]
    const firstId = worker.messages[0].sourceId
    act(() =>
      worker.emit({
        type: 'analyzed',
        sourceId: firstId,
        analysis,
        elapsedMs: 10,
      }),
    )
    const oldRender = worker.messages.at(-1)!
    if (oldRender.type !== 'render') throw new Error('expected render')
    act(() => result.current.setMode('auto'))
    act(() => result.current.clearSource())
    const clearedCount = worker.messages.length
    act(() =>
      worker.emit({
        type: 'rendered',
        sourceId: firstId,
        requestId: oldRender.requestId,
        result: {
          frame: { width: 2, height: 2, data: new Uint8ClampedArray(16) },
          displayMatrix: identityMatrix(),
          retainedArea: 1,
        },
      }),
    )
    expect(worker.messages).toHaveLength(clearedCount)
    expect(result.current.result).toBeNull()
    expect(result.current.ready).toBe(false)

    await act(() => result.current.loadSource())
    expect(DemoWorker.instances).toHaveLength(1)
    expect(worker.terminated).toBe(false)
    const next = worker.messages.at(-1)!
    expect(next.type).toBe('analyze')
    expect(next.sourceId).toBeGreaterThan(firstId)
    act(() =>
      worker.emit({
        type: 'analyzed',
        sourceId: next.sourceId,
        analysis,
        elapsedMs: 10,
      }),
    )
    expect(result.current.ready).toBe(true)
    expect(worker.messages.at(-1)?.type).toBe('render')
    unmount()
    expect(worker.terminated).toBe(true)
  })

  it('clears the worker pixel source until a replacement frame is analyzed', async () => {
    const postMessage = vi.fn()
    const workerScope: {
      postMessage: typeof postMessage
      onmessage?: (event: MessageEvent<TransformWorkerRequest>) => void
    } = { postMessage }
    vi.stubGlobal('self', workerScope)
    await import('./transform.worker')
    const send = (data: TransformWorkerRequest) =>
      workerScope.onmessage!({ data } as MessageEvent<TransformWorkerRequest>)
    const frame = { width: 2, height: 2, data: new Uint8ClampedArray(16) }
    send({ type: 'analyze', sourceId: 1, frame })
    expect(postMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: 'analyzed', sourceId: 1 }),
    )
    postMessage.mockClear()
    send({ type: 'clear', sourceId: 2 })
    send({
      type: 'render',
      sourceId: 1,
      requestId: 1,
      matrix: identityMatrix(),
      constrainCrop: true,
    })
    send({
      type: 'render',
      sourceId: 2,
      requestId: 2,
      matrix: identityMatrix(),
      constrainCrop: true,
    })
    expect(postMessage).not.toHaveBeenCalled()
    send({ type: 'analyze', sourceId: 3, frame })
    send({
      type: 'render',
      sourceId: 3,
      requestId: 3,
      matrix: identityMatrix(),
      constrainCrop: true,
    })
    expect(postMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: 'rendered', sourceId: 3, requestId: 3 }),
      expect.objectContaining({ transfer: expect.any(Array) }),
    )
  })

  it('disposes a failed worker without reporting its stale error after clearing', async () => {
    const { result, unmount } = setup()
    const worker = DemoWorker.instances[0]
    act(() => result.current.clearSource())
    act(() => worker.onerror?.())

    expect(worker.terminated).toBe(true)
    expect(result.current.error).toBeNull()
    expect(result.current.source).toBeNull()
    await act(() => result.current.loadSource())
    expect(DemoWorker.instances).toHaveLength(2)
    expect(DemoWorker.instances[1].terminated).toBe(false)
    unmount()
  })

  it('retires a rejected geometry and its failure together on reset', async () => {
    const { result, unmount } = setup()
    await waitFor(() => expect(DemoWorker.instances).toHaveLength(1))
    const worker = DemoWorker.instances[0]
    const sourceId = worker.messages[0].sourceId
    act(() =>
      worker.emit({ type: 'analyzed', sourceId, analysis, elapsedMs: 4 }),
    )
    await waitFor(() => expect(result.current.ready).toBe(true))
    // Settle the neutral render first; otherwise the next one only queues.
    const first = worker.messages.findLast((m) => m.type === 'render')!
    act(() =>
      worker.emit({
        type: 'rendered',
        sourceId,
        requestId: first.requestId,
        result: {
          frame: { width: 2, height: 2, data: new Uint8ClampedArray(16) },
          displayMatrix: identityMatrix(),
          retainedArea: 1,
        },
      }),
    )
    act(() => result.current.setManual({ ...result.current.manual, scale: 51 }))
    const rejected = worker.messages.findLast((m) => m.type === 'render')!
    expect(rejected.requestId).not.toBe(first.requestId)
    act(() =>
      worker.emit({
        type: 'error',
        sourceId,
        requestId: rejected.requestId,
        message: 'invalid-transform',
      }),
    )
    await waitFor(() => expect(result.current.error).toBe('transform'))

    act(() => result.current.reset())

    // The alert named the geometry reset just discarded; it must not outlive
    // it and keep the tool reading as broken.
    expect(result.current.error).toBeNull()
    expect(result.current.manual.scale).toBe(100)
    unmount()
  })

  it('does not strand the render queue when the worker is already gone', async () => {
    const { result, unmount } = setup()
    await waitFor(() => expect(DemoWorker.instances).toHaveLength(1))
    const worker = DemoWorker.instances[0]
    const sourceId = worker.messages[0].sourceId
    act(() =>
      worker.emit({ type: 'analyzed', sourceId, analysis, elapsedMs: 4 }),
    )
    await waitFor(() => expect(result.current.ready).toBe(true))
    act(() => worker.onerror?.())

    // A crashed worker cannot refresh the frame it produced, so nothing may
    // still read as a current render.
    expect(result.current.result).toBeNull()
    expect(result.current.rendering).toBe(false)

    act(() => result.current.setManual({ ...result.current.manual, rotate: 3 }))
    // Without a worker the request cannot be answered, and claiming it is in
    // flight would leave the tool busy forever.
    expect(result.current.rendering).toBe(false)
    unmount()
  })

  it('creates a live worker after StrictMode replays the mount effect', async () => {
    DemoWorker.instances = []
    vi.stubGlobal('Worker', DemoWorker)
    const { result, unmount } = renderHook(() => useTransformDemo(), {
      wrapper: StrictMode,
    })
    await waitFor(() => expect(DemoWorker.instances).toHaveLength(2))
    const [disposed, live] = DemoWorker.instances
    expect(disposed.terminated).toBe(true)
    expect(live.terminated).toBe(false)
    act(() =>
      live.emit({
        type: 'analyzed',
        sourceId: live.messages[0].sourceId,
        analysis,
        elapsedMs: 10,
      }),
    )
    await waitFor(() => expect(result.current.ready).toBe(true))
    expect(live.messages.some((message) => message.type === 'render')).toBe(
      true,
    )
    unmount()
    expect(live.terminated).toBe(true)
  })

  it('coalesces slider work and only displays the newest render', async () => {
    const { result, unmount } = setup()
    await waitFor(() => expect(DemoWorker.instances).toHaveLength(1))
    const worker = DemoWorker.instances[0]
    const id = worker.messages[0].sourceId
    act(() =>
      worker.emit({ type: 'analyzed', sourceId: id, analysis, elapsedMs: 10 }),
    )
    await waitFor(() => expect(worker.messages).toHaveLength(2))
    const first = worker.messages[1]
    if (first.type !== 'render') throw new Error('expected render')
    act(() => result.current.setMode('level'))
    act(() => result.current.setMode('full'))
    expect(worker.messages).toHaveLength(2)
    const rendered = {
      frame: { width: 2, height: 2, data: new Uint8ClampedArray(16) },
      displayMatrix: identityMatrix(),
      retainedArea: 1,
    }
    act(() =>
      worker.emit({
        type: 'rendered',
        sourceId: id,
        requestId: first.requestId,
        result: rendered,
      }),
    )
    expect(result.current.result).toBeNull()
    expect(worker.messages).toHaveLength(3)
    const latest = worker.messages[2]
    if (latest.type !== 'render') throw new Error('expected render')
    act(() =>
      worker.emit({
        type: 'rendered',
        sourceId: id,
        requestId: latest.requestId,
        result: rendered,
      }),
    )
    expect(result.current.result).toEqual(rendered)
    expect(result.current.rendering).toBe(false)
    unmount()
    expect(worker.terminated).toBe(true)
  })

  it('ignores a previous image that finishes decoding after its replacement', async () => {
    const { result, unmount } = setup()
    const oldWorker = DemoWorker.instances[0]
    let finishFirst!: (source: PreviewSource) => void
    vi.mocked(loadImageInput).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishFirst = resolve
        }),
    )
    const next: PreviewSource = {
      name: 'new.jpg',
      kind: 'image',
      originalWidth: 1,
      originalHeight: 1,
      frame: { width: 1, height: 1, data: new Uint8ClampedArray(4) },
    }
    vi.mocked(loadImageInput).mockResolvedValueOnce(next)
    let first!: Promise<void>
    act(() => {
      first = result.current.loadSource(new File(['a'], 'old.jpg'))
    })
    await act(() => result.current.loadSource(new File(['b'], 'new.jpg')))
    await act(async () => {
      finishFirst({ ...next, name: 'old.jpg' })
      await first
    })
    act(() =>
      oldWorker.emit({
        type: 'analyzed',
        sourceId: oldWorker.messages[0].sourceId,
        analysis,
        elapsedMs: 10,
      }),
    )
    expect(result.current.analysis).toBeNull()
    expect(result.current.source?.name).toBe('new.jpg')
    expect(oldWorker.terminated).toBe(false)
    expect(DemoWorker.instances).toHaveLength(1)
    unmount()
  })
})
