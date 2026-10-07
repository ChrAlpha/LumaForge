import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { act, renderHook, waitFor } from '@testing-library/react'
import { StrictMode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { identityMatrix } from '~/lib/transform/geometry/matrix'
import type { UprightAnalysis } from '~/lib/transform/geometry/types'
import type { PreviewSource } from '~/lib/transform/preview-types'
import { ImageInputError } from '~/lib/transform/preview-types'
import { NEUTRAL_TRANSFORM } from '~/lib/transform/transform-types'
import type {
  TransformWorkerRequest,
  TransformWorkerResponse,
} from '~/lib/transform/worker-protocol'

import { loadImageInput } from './image-input'
import { useTransformDemo } from './useTransformDemo'

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

function lastAnalyze(worker: DemoWorker) {
  const request = worker.messages.findLast(
    (message) => message.type === 'analyze',
  )
  if (request?.type !== 'analyze') throw new Error('expected analyze')
  return request
}

function analyze(worker: DemoWorker) {
  act(() =>
    worker.emit({
      type: 'analyzed',
      sourceId: lastAnalyze(worker).sourceId,
      analysis,
      elapsedMs: 10,
    }),
  )
}

function image(name: string): PreviewSource {
  return {
    name,
    kind: 'image',
    originalWidth: 1,
    originalHeight: 1,
    frame: { width: 1, height: 1, data: new Uint8ClampedArray(4) },
  }
}

/** A loader whose decode finishes only when the test says so. */
function deferredDecode() {
  let finish!: (source: PreviewSource) => void
  let fail!: (cause: unknown) => void
  let signal!: AbortSignal
  vi.mocked(loadImageInput).mockImplementationOnce(
    (_file, abort) =>
      new Promise((resolve, reject) => {
        signal = abort!
        finish = resolve
        fail = reject
      }),
  )
  return {
    finish: (source: PreviewSource) => finish(source),
    fail: (cause: unknown) => fail(cause),
    signal: () => signal,
  }
}

beforeEach(() => {
  DemoWorker.instances = []
  vi.stubGlobal('Worker', DemoWorker)
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('transform demo loading', () => {
  it('opens the synthetic sample on mount unless asked not to', () => {
    const { result, unmount } = renderHook(() => useTransformDemo())
    expect(DemoWorker.instances).toHaveLength(1)
    const worker = DemoWorker.instances[0]
    expect(result.current.source?.kind).toBe('sample')
    expect(result.current.loading).toBe(true)
    expect(lastAnalyze(worker).frame).toBe(result.current.source?.frame)
    analyze(worker)
    expect(result.current.ready).toBe(true)
    expect(worker.messages.at(-1)?.type).toBe('render')
    unmount()
    expect(worker.terminated).toBe(true)

    const idle = renderHook(() => useTransformDemo({ autoLoadSample: false }))
    expect(DemoWorker.instances).toHaveLength(1)
    expect(idle.result.current.source).toBeNull()
    expect(idle.result.current.loading).toBe(false)
    idle.unmount()
  })

  it('retires the previous frame and edits while a file decodes', async () => {
    const { result, unmount } = renderHook(() => useTransformDemo())
    const worker = DemoWorker.instances[0]
    analyze(worker)
    act(() => {
      result.current.setMode('auto')
      result.current.setManual({ ...NEUTRAL_TRANSFORM, rotate: 4 })
      result.current.setConstrainCrop(false)
    })
    const decode = deferredDecode()
    let pending!: Promise<void>
    act(() => {
      pending = result.current.loadSource(new File(['a'], 'photo.jpg'))
    })
    expect(result.current.source).toBeNull()
    expect(result.current.analysis).toBeNull()
    expect(result.current.result).toBeNull()
    expect(result.current.ready).toBe(false)
    expect(result.current.loading).toBe(true)
    expect(result.current.mode).toBe('off')
    expect(result.current.manual).toEqual(NEUTRAL_TRANSFORM)
    expect(result.current.constrainCrop).toBe(true)

    await act(async () => {
      decode.finish(image('photo.jpg'))
      await pending
    })
    expect(result.current.source?.name).toBe('photo.jpg')
    expect(result.current.loading).toBe(true)
    expect(lastAnalyze(worker).frame).toBe(result.current.source?.frame)
    analyze(worker)
    expect(result.current.loading).toBe(false)
    expect(result.current.ready).toBe(true)
    expect(DemoWorker.instances).toHaveLength(1)
    unmount()
  })

  it('ignores a previous image that finishes decoding after its replacement', async () => {
    const { result, unmount } = renderHook(() => useTransformDemo())
    const oldWorker = DemoWorker.instances[0]
    const first = deferredDecode()
    vi.mocked(loadImageInput).mockResolvedValueOnce(image('new.jpg'))
    let pending!: Promise<void>
    act(() => {
      pending = result.current.loadSource(new File(['a'], 'old.jpg'))
    })
    await act(() => result.current.loadSource(new File(['b'], 'new.jpg')))
    expect(first.signal().aborted).toBe(true)
    await act(async () => {
      first.finish(image('old.jpg'))
      await pending
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

  it('lets the sample, a clear, or unmounting supersede a pending decode', async () => {
    const { result, unmount } = renderHook(() =>
      useTransformDemo({ autoLoadSample: false }),
    )
    const toSample = deferredDecode()
    let pending!: Promise<void>
    act(() => {
      pending = result.current.loadSource(new File(['a'], 'slow.jpg'))
    })
    await act(() => result.current.loadSource())
    expect(toSample.signal().aborted).toBe(true)
    await act(async () => {
      toSample.finish(image('slow.jpg'))
      await pending
    })
    expect(result.current.source?.kind).toBe('sample')

    const toClear = deferredDecode()
    act(() => {
      pending = result.current.loadSource(new File(['a'], 'slow.jpg'))
    })
    act(() => result.current.clearSource())
    expect(toClear.signal().aborted).toBe(true)
    expect(result.current.loading).toBe(false)
    await act(async () => {
      toClear.fail(new ImageInputError('decode'))
      await pending
    })
    expect(result.current.source).toBeNull()
    expect(result.current.error).toBeNull()

    const toUnmount = deferredDecode()
    act(() => {
      void result.current.loadSource(new File(['a'], 'slow.jpg'))
    })
    unmount()
    expect(toUnmount.signal().aborted).toBe(true)
  })

  it('reports input failures until another source, a clear, or reset retires them', async () => {
    const { result, unmount } = renderHook(() =>
      useTransformDemo({ autoLoadSample: false }),
    )
    vi.mocked(loadImageInput).mockRejectedValueOnce(
      new ImageInputError('too-large'),
    )
    await act(() => result.current.loadSource(new File(['a'], 'huge.jpg')))
    expect(result.current.error).toBe('too-large')
    expect(result.current.loading).toBe(false)
    expect(result.current.source).toBeNull()

    await act(() => result.current.loadSource())
    expect(result.current.error).toBeNull()

    vi.mocked(loadImageInput).mockRejectedValueOnce(new Error('boom'))
    await act(() => result.current.loadSource(new File(['a'], 'broken.jpg')))
    expect(result.current.error).toBe('decode')
    act(() => result.current.reset())
    expect(result.current.error).toBeNull()

    vi.mocked(loadImageInput).mockRejectedValueOnce(
      new ImageInputError('unsupported'),
    )
    await act(() => result.current.loadSource(new File(['a'], 'a.svg')))
    expect(result.current.error).toBe('unsupported')
    act(() => result.current.clearSource())
    expect(result.current.error).toBeNull()
    unmount()
  })

  it('reuses its live worker when the sample reopens after a clear', async () => {
    const { result, unmount } = renderHook(() => useTransformDemo())
    const worker = DemoWorker.instances[0]
    const firstId = worker.messages[0].sourceId
    analyze(worker)
    act(() => result.current.clearSource())
    expect(worker.messages.at(-1)?.type).toBe('clear')
    expect(result.current.ready).toBe(false)

    await act(() => result.current.loadSource())
    expect(DemoWorker.instances).toHaveLength(1)
    expect(worker.terminated).toBe(false)
    const next = lastAnalyze(worker)
    expect(next.sourceId).toBeGreaterThan(firstId)
    analyze(worker)
    expect(result.current.ready).toBe(true)
    expect(worker.messages.at(-1)?.type).toBe('render')
    unmount()
    expect(worker.terminated).toBe(true)
  })

  it('creates a live worker after StrictMode replays the mount effect', async () => {
    const { result, unmount } = renderHook(() => useTransformDemo(), {
      wrapper: StrictMode,
    })
    await waitFor(() => expect(DemoWorker.instances).toHaveLength(2))
    const [disposed, live] = DemoWorker.instances
    expect(disposed.terminated).toBe(true)
    expect(live.terminated).toBe(false)
    analyze(live)
    await waitFor(() => expect(result.current.ready).toBe(true))
    expect(live.messages.some((message) => message.type === 'render')).toBe(
      true,
    )
    unmount()
    expect(live.terminated).toBe(true)
  })
})

describe('transform demo ownership', () => {
  it('drives the production preview instead of its own worker loop', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'src/modules/transform-demo/useTransformDemo.ts'),
      'utf8',
    )
    expect(source).toMatch(
      /from '~\/modules\/raw-processor\/hooks\/useTransformPreview'/,
    )
    expect(source).not.toMatch(/new Worker|worker-protocol|transform-render/)
  })
})
