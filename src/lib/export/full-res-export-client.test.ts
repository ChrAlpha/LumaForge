import { createBlobOutputResult } from '@lumaforge/render-engine/export'

import type {
  FullResExportWorkerRequest,
  FullResExportWorkerResponse,
  RunFullResolutionJpegExportInWorkerInput,
} from './full-res-export-client'
import { runFullResolutionJpegExportInWorker } from './full-res-export-client'

class FakeWorker {
  onmessage:
    | ((event: MessageEvent<FullResExportWorkerResponse>) => void)
    | null = null
  onerror: ((event: ErrorEvent) => void) | null = null
  onmessageerror: ((event: MessageEvent) => void) | null = null
  readonly requests: FullResExportWorkerRequest[] = []
  readonly terminate = vi.fn()

  constructor(private readonly throwOn?: FullResExportWorkerRequest['kind']) {}

  postMessage(message: FullResExportWorkerRequest) {
    if (message.kind === this.throwOn) {
      throw new DOMException(`failed to post ${message.kind} message`)
    }
    this.requests.push(message)
  }

  emit(message: FullResExportWorkerResponse) {
    this.onmessage?.({ data: message } as MessageEvent)
  }
}

const JOB: RunFullResolutionJpegExportInWorkerInput = {
  file: new File(['raw'], 'sample.ARW'),
  filename: 'sample.jpg',
  graph: {
    supported: true,
    outputGamut: 'srgb-rec709',
    outputTransfer: 'srgb',
    lutProfile: null,
    steps: [{ kind: 'input-linear-prophoto' }, { kind: 'output-srgb' }],
  },
  executionPlan: {
    preferredRows: 64,
    concurrency: 1,
    runtimeMemoryProfile: 'low-memory',
    outputSink: 'opfs-file',
  },
  outputLocation: {
    sink: 'opfs-file',
    tabDirectory: 'tab-1',
    exportId: 'export-1',
  },
  quality: 0.92,
}

function run(
  overrides: Partial<RunFullResolutionJpegExportInWorkerInput> = {},
  worker = new FakeWorker(),
) {
  const workerFactory = vi.fn(() => worker as unknown as Worker)
  const promise = runFullResolutionJpegExportInWorker(
    { ...JOB, ...overrides },
    workerFactory,
  )
  return { promise, worker, workerFactory }
}

describe('runFullResolutionJpegExportInWorker', () => {
  it('starts one worker with the job, streams progress, and terminates it once the JPEG arrives', async () => {
    const progress = vi.fn()
    const { promise, worker, workerFactory } = run({ onProgress: progress })

    expect(worker.requests).toEqual([
      {
        kind: 'start',
        file: JOB.file,
        filename: JOB.filename,
        graph: JOB.graph,
        executionPlan: JOB.executionPlan,
        outputLocation: JOB.outputLocation,
        quality: 0.92,
      },
    ])
    worker.emit({
      kind: 'progress',
      progress: { completedStrips: 1, totalStrips: 2, progress: 50 },
    })
    const result = createBlobOutputResult({
      filename: 'sample.jpg',
      blob: new Blob([new Uint8Array([1])], { type: 'image/jpeg' }),
      sha256: 'c'.repeat(64),
    })
    worker.emit({ kind: 'success', result })

    await expect(promise).resolves.toBe(result)
    expect(progress).toHaveBeenCalledWith({
      completedStrips: 1,
      totalStrips: 2,
      progress: 50,
    })
    expect(workerFactory).toHaveBeenCalledTimes(1)
    expect(worker.terminate).toHaveBeenCalledTimes(1)
  })

  it('rehydrates a file-backed reference inside its tab directory, keeping the recorded hash and delivery metadata', async () => {
    const { promise, worker } = run()
    const deliveryMetadata = { make: 'Sony', iso: 200 }
    worker.emit({
      kind: 'success',
      result: {
        kind: 'file-backed',
        storage: 'opfs',
        tabDirectory: 'tab-1',
        exportId: 'export-1',
        filename: 'sample.jpg',
        byteLength: 42,
        mimeType: 'image/jpeg',
        sha256: 'c'.repeat(64),
        deliveryMetadata,
      },
    })

    const output = await promise
    expect(output).toMatchObject({
      kind: 'file-backed',
      exportId: 'export-1',
      byteLength: 42,
      sha256: 'c'.repeat(64),
      deliveryMetadata,
      openBlob: expect.any(Function),
      cleanup: expect.any(Function),
    })
    expect('storage' in output).toBe(false)

    const opened: string[] = []
    const directory = (): FileSystemDirectoryHandle =>
      ({
        async getDirectoryHandle(name: string) {
          opened.push(name)
          return directory()
        },
        async removeEntry() {},
      }) as unknown as FileSystemDirectoryHandle
    Object.defineProperty(window.navigator, 'storage', {
      configurable: true,
      value: { getDirectory: async () => directory() },
    })
    try {
      if (output.kind !== 'file-backed')
        throw new Error('Expected file-backed.')
      await output.cleanup?.()
    } finally {
      delete (window.navigator as { storage?: unknown }).storage
    }
    expect(opened).toEqual([
      '.lumaforge-exports',
      'active',
      'tab-1',
      'export-1',
    ])
  })

  it('rejects with the worker error message and its retry row hint', async () => {
    const { promise, worker } = run()
    worker.emit({
      kind: 'error',
      message: 'FULL_RES_EXPORT_RESOURCE_FAILURE',
      nextRows: 96,
    })

    await expect(promise).rejects.toMatchObject({
      message: 'FULL_RES_EXPORT_RESOURCE_FAILURE',
      nextRows: 96,
    })
    expect(worker.terminate).toHaveBeenCalledTimes(1)
  })

  it.each(['onerror', 'onmessageerror'] as const)(
    'fails the attempt and terminates the worker on %s',
    async (handler) => {
      const { promise, worker } = run()
      worker[handler]?.({} as ErrorEvent & MessageEvent)

      await expect(promise).rejects.toThrow('FULL_RES_EXPORT_WORKER_FAILED')
      expect(worker.terminate).toHaveBeenCalledTimes(1)
    },
  )

  it('asks the worker to stop, then terminates it, when the signal aborts', async () => {
    const controller = new AbortController()
    const { promise, worker } = run({ signal: controller.signal })
    controller.abort()

    await expect(promise).rejects.toThrow('FULL_RES_EXPORT_CANCELLED')
    expect(worker.requests.map((request) => request.kind)).toEqual([
      'start',
      'cancel',
    ])
    expect(worker.terminate).toHaveBeenCalledTimes(1)
  })

  it('starts no worker for a signal that has already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    const { promise, workerFactory } = run({ signal: controller.signal })

    await expect(promise).rejects.toThrow('FULL_RES_EXPORT_CANCELLED')
    expect(workerFactory).not.toHaveBeenCalled()
  })

  it.each(['start', 'cancel'] as const)(
    'rejects with the error and terminates the worker when posting %s throws',
    async (kind) => {
      const controller = new AbortController()
      const { promise, worker } = run(
        { signal: controller.signal },
        new FakeWorker(kind),
      )
      controller.abort()

      await expect(promise).rejects.toThrow(`failed to post ${kind} message`)
      expect(worker.terminate).toHaveBeenCalledTimes(1)
    },
  )
})
