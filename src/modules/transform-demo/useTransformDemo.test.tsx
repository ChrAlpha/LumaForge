import { act, renderHook, waitFor } from '@testing-library/react'
import { StrictMode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { identityMatrix } from './geometry/matrix'
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
