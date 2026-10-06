import { createBlobOutputResult } from '@lumaforge/render-engine/export'

import type {
  FullResExportWorkerRequest,
  FullResExportWorkerResponse,
} from './full-res-export-client'
import {
  FullResolutionExportWorkerClient,
  runFullResolutionJpegExportInWorker,
} from './full-res-export-client'

class FakeWorker {
  onmessage:
    | ((event: MessageEvent<FullResExportWorkerResponse>) => void)
    | null = null
  onerror: ((event: ErrorEvent) => void) | null = null
  onmessageerror: ((event: MessageEvent) => void) | null = null
  readonly postMessage = vi.fn(
    (message: FullResExportWorkerRequest, _transfer?: Transferable[]) => {
      this.requests.push(message)
    },
  )
  readonly terminate = vi.fn()
  readonly requests: FullResExportWorkerRequest[] = []

  emit(message: FullResExportWorkerResponse) {
    this.onmessage?.({
      data: message,
    } as MessageEvent<FullResExportWorkerResponse>)
  }

  emitError(message: string) {
    this.onerror?.({ message } as ErrorEvent)
  }

  emitMessageError() {
    this.onmessageerror?.({} as MessageEvent)
  }
}

class ThrowingStartWorker extends FakeWorker {
  override readonly postMessage = vi.fn(
    (_message: FullResExportWorkerRequest, _transfer?: Transferable[]) => {
      throw new DOMException('failed to post start message')
    },
  )
}

class ThrowingCancelWorker extends FakeWorker {
  override readonly postMessage = vi.fn(
    (message: FullResExportWorkerRequest, _transfer?: Transferable[]) => {
      this.requests.push(message)
      if (message.kind === 'cancel') {
        throw new DOMException('failed to post cancel message')
      }
    },
  )
}

class ThrowingSecondStartWorker extends FakeWorker {
  override readonly postMessage = vi.fn(
    (message: FullResExportWorkerRequest, _transfer?: Transferable[]) => {
      this.requests.push(message)
      if (message.kind === 'start' && this.requests.length === 2) {
        throw new DOMException('failed to post start message')
      }
    },
  )
}

const supportedGraph = {
  supported: true as const,
  outputGamut: 'srgb-rec709' as const,
  outputTransfer: 'srgb' as const,
  lutProfile: null,
  steps: [
    { kind: 'input-linear-prophoto' as const },
    { kind: 'output-srgb' as const },
  ],
}

describe('fullResolutionExportWorkerClient', () => {
  it('passes execution plan and checkpoint config to the worker', async () => {
    const worker = new FakeWorker()
    const client = new FullResolutionExportWorkerClient(
      () => worker as unknown as Worker,
    )

    const run = client.run({
      file: new File(['raw'], 'sample.RAF'),
      graph: supportedGraph,
      executionPlan: {
        profileName: 'ios-safe',
        preferredRows: 64,
        concurrency: 1,
        runtimeMemoryProfile: 'low-memory',
        outputSink: 'opfs-file',
        checkpointMode: 'safe-retry',
      },
      checkpoint: {
        exportId: 'export-1',
        graphFingerprint: 'graph-1',
        sourceFingerprint: {
          name: 'sample.RAF',
          size: 3,
          lastModified: 0,
          hashPrefixHex: 'abc',
        },
      },
    })

    const start = worker.requests[0]
    expect(start).toMatchObject({
      kind: 'start',
      executionPlan: {
        profileName: 'ios-safe',
        preferredRows: 64,
        runtimeMemoryProfile: 'low-memory',
      },
      checkpoint: {
        exportId: 'export-1',
        graphFingerprint: 'graph-1',
      },
    })

    if (!start || start.kind !== 'start')
      throw new Error('missing start request')
    worker.emit({
      kind: 'success',
      requestId: start.requestId,
      result: {
        kind: 'blob',
        filename: 'sample.jpg',
        blob: new Blob(['jpeg'], { type: 'image/jpeg' }),
        byteLength: 4,
        mimeType: 'image/jpeg',
      },
    })

    await expect(run).resolves.toMatchObject({ kind: 'blob' })
    client.dispose()
  })

  it('carries the output location to the worker independently of the checkpoint', async () => {
    const worker = new FakeWorker()
    const client = new FullResolutionExportWorkerClient(
      () => worker as unknown as Worker,
    )
    const executionPlan = {
      profileName: 'desktop-fast',
      preferredRows: 512,
      concurrency: 2,
      runtimeMemoryProfile: 'desktop',
      outputSink: 'opfs-file',
      checkpointMode: 'safe-retry',
    } as const

    const run = client.run({
      file: new File(['raw'], 'sample.RAF'),
      graph: supportedGraph,
      executionPlan,
      outputLocation: {
        sink: 'opfs-file',
        tabDirectory: 'tab-1',
        exportId: 'export-9',
      },
    })

    const start = worker.requests[0]
    if (!start || start.kind !== 'start')
      throw new Error('missing start request')
    expect(start).toMatchObject({
      executionPlan,
      outputLocation: {
        sink: 'opfs-file',
        tabDirectory: 'tab-1',
        exportId: 'export-9',
      },
    })
    expect(start.checkpoint).toBeUndefined()

    worker.emit({
      kind: 'success',
      requestId: start.requestId,
      result: {
        kind: 'file-backed',
        storage: 'opfs',
        tabDirectory: 'tab-1',
        exportId: 'export-9',
        filename: 'sample.jpg',
        byteLength: 4,
        mimeType: 'image/jpeg',
      },
    })

    await expect(run).resolves.toMatchObject({
      kind: 'file-backed',
      exportId: 'export-9',
    })
    client.dispose()
  })

  it('streams progress, resolves success, and the one-shot helper disposes its worker', async () => {
    const worker = new FakeWorker()
    const workerFactory = vi.fn(() => worker as unknown as Worker)

    const promise = runFullResolutionJpegExportInWorker(
      {
        file: new File(['raw'], 'sample.ARW'),
        graph: supportedGraph,
        onProgress: (progress) => {
          expect(progress.progress).toBe(50)
        },
      },
      () => new FullResolutionExportWorkerClient(workerFactory),
    )
    const startRequest = worker.requests[0]

    if (!startRequest || startRequest.kind !== 'start') {
      throw new Error('Expected a start request.')
    }

    worker.emit({
      kind: 'progress',
      requestId: startRequest.requestId,
      progress: {
        completedStrips: 1,
        totalStrips: 2,
        progress: 50,
      },
    })
    worker.emit({
      kind: 'success',
      requestId: startRequest.requestId,
      result: createBlobOutputResult({
        filename: 'sample.jpg',
        blob: new Blob([new Uint8Array([1])], { type: 'image/jpeg' }),
      }),
    })

    await expect(promise).resolves.toMatchObject({
      kind: 'blob',
      filename: 'sample.jpg',
      mimeType: 'image/jpeg',
    })
    expect(workerFactory).toHaveBeenCalledTimes(1)
    expect(worker.terminate).toHaveBeenCalledTimes(1)
  })

  it('rehydrates file-backed worker output references on success', async () => {
    const worker = new FakeWorker()
    const client = new FullResolutionExportWorkerClient(
      () => worker as unknown as Worker,
    )

    const run = client.run({
      file: new File(['raw'], 'sample.ARW'),
      graph: supportedGraph,
    })
    const startRequest = worker.requests[0]

    if (!startRequest || startRequest.kind !== 'start') {
      throw new Error('Expected a start request.')
    }

    worker.emit({
      kind: 'success',
      requestId: startRequest.requestId,
      result: {
        kind: 'file-backed',
        storage: 'opfs',
        tabDirectory: 'tab-1',
        exportId: 'export-1',
        filename: 'sample.jpg',
        byteLength: 42,
        mimeType: 'image/jpeg',
      },
    })

    const output = await run
    expect(output).toMatchObject({
      kind: 'file-backed',
      exportId: 'export-1',
      filename: 'sample.jpg',
      byteLength: 42,
      mimeType: 'image/jpeg',
      openBlob: expect.any(Function),
      cleanup: expect.any(Function),
    })
    client.dispose()

    // The rehydrated output addresses the file inside the worker's tab directory.
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

  it('keeps the recorded hash and delivery metadata on rehydrated and blob outputs', async () => {
    const worker = new FakeWorker()
    const client = new FullResolutionExportWorkerClient(
      () => worker as unknown as Worker,
    )
    const digest = 'c'.repeat(64)
    const deliveryMetadata = { make: 'Sony', iso: 200 }

    const fileBackedRun = client.run({
      file: new File(['raw'], 'sample.ARW'),
      graph: supportedGraph,
    })
    const fileBackedStart = worker.requests[0]
    if (!fileBackedStart || fileBackedStart.kind !== 'start') {
      throw new Error('Expected a start request.')
    }
    worker.emit({
      kind: 'success',
      requestId: fileBackedStart.requestId,
      result: {
        kind: 'file-backed',
        storage: 'opfs',
        tabDirectory: 'tab-1',
        exportId: 'export-hash',
        filename: 'sample.jpg',
        byteLength: 42,
        mimeType: 'image/jpeg',
        sha256: digest,
        deliveryMetadata,
      },
    })

    const fileBacked = await fileBackedRun
    expect(fileBacked).toMatchObject({
      kind: 'file-backed',
      exportId: 'export-hash',
      sha256: digest,
      deliveryMetadata,
    })
    expect('storage' in fileBacked).toBe(false)

    const blobRun = client.run({
      file: new File(['raw'], 'sample.ARW'),
      graph: supportedGraph,
    })
    const blobStart = worker.requests[1]
    if (!blobStart || blobStart.kind !== 'start') {
      throw new Error('Expected a second start request.')
    }
    const blobResult = createBlobOutputResult({
      filename: 'sample.jpg',
      blob: new Blob([new Uint8Array([1])], { type: 'image/jpeg' }),
      sha256: digest,
    })
    worker.emit({
      kind: 'success',
      requestId: blobStart.requestId,
      result: blobResult,
    })

    await expect(blobRun).resolves.toBe(blobResult)
    client.dispose()
  })

  it('rejects with the worker error message', async () => {
    const worker = new FakeWorker()
    const client = new FullResolutionExportWorkerClient(
      () => worker as unknown as Worker,
    )

    const promise = client.run({
      file: new File(['raw'], 'sample.ARW'),
      graph: supportedGraph,
    })
    const startRequest = worker.requests[0]

    if (!startRequest || startRequest.kind !== 'start') {
      throw new Error('Expected a start request.')
    }

    worker.emit({
      kind: 'error',
      requestId: startRequest.requestId,
      message: 'FULL_RES_EXPORT_UNSUPPORTED_PIPELINE',
    })

    await expect(promise).rejects.toThrow(
      'FULL_RES_EXPORT_UNSUPPORTED_PIPELINE',
    )
  })

  it('preserves worker retry row hints on error responses', async () => {
    const worker = new FakeWorker()
    const client = new FullResolutionExportWorkerClient(
      () => worker as unknown as Worker,
    )

    const promise = client.run({
      file: new File(['raw'], 'sample.ARW'),
      graph: supportedGraph,
    })
    const startRequest = worker.requests[0]

    if (!startRequest || startRequest.kind !== 'start') {
      throw new Error('Expected a start request.')
    }

    worker.emit({
      kind: 'error',
      requestId: startRequest.requestId,
      message: 'FULL_RES_EXPORT_RESOURCE_FAILURE',
      nextRows: 96,
    })

    await expect(promise).rejects.toMatchObject({
      message: 'FULL_RES_EXPORT_RESOURCE_FAILURE',
      nextRows: 96,
    })
  })

  it('forwards worker metric messages to the caller', async () => {
    const worker = new FakeWorker()
    const client = new FullResolutionExportWorkerClient(
      () => worker as unknown as Worker,
    )
    const metrics: unknown[] = []
    const run = client.run({
      file: new File([new Uint8Array([1])], 'sample.RAF'),
      graph: supportedGraph,
      onMetric(metric) {
        metrics.push(metric)
      },
    })

    const start = worker.requests[0]!
    if (start.kind !== 'start') {
      throw new Error('Expected a start request.')
    }
    const metric = {
      requestId: start.requestId,
      kind: 'summary' as const,
      width: 4,
      height: 4,
      megapixels: 0,
      timestamp: '2026-04-27T00:00:00.000Z',
      stripRows: 4,
      retries: 0,
      concurrency: 1,
      totalMs: 12,
      outputBytes: 128,
    }
    expect(start.collectMetrics).toBe(true)
    worker.emit({
      kind: 'metric',
      requestId: `${start.requestId}-stale`,
      metric: {
        ...metric,
        requestId: `${start.requestId}-stale`,
      },
    })
    worker.emit({
      kind: 'metric',
      requestId: start.requestId,
      metric,
    })
    worker.emit({
      kind: 'success',
      requestId: start.requestId,
      result: createBlobOutputResult({
        filename: 'sample.jpg',
        blob: new Blob([new Uint8Array([1])], { type: 'image/jpeg' }),
      }),
    })

    await expect(run).resolves.toMatchObject({ kind: 'blob' })
    expect(metrics).toEqual([metric])
    client.dispose()
  })

  it('does not opt into worker metrics when no metric callback is provided', async () => {
    const worker = new FakeWorker()
    const client = new FullResolutionExportWorkerClient(
      () => worker as unknown as Worker,
    )

    const run = client.run({
      file: new File([new Uint8Array([1])], 'sample.RAF'),
      graph: supportedGraph,
    })

    const start = worker.requests[0]!
    if (start.kind !== 'start') {
      throw new Error('Expected a start request.')
    }
    expect(start.collectMetrics).toBe(false)
    worker.emit({
      kind: 'success',
      requestId: start.requestId,
      result: createBlobOutputResult({
        filename: 'sample.jpg',
        blob: new Blob([new Uint8Array([1])], { type: 'image/jpeg' }),
      }),
    })

    await expect(run).resolves.toMatchObject({ kind: 'blob' })
    client.dispose()
  })

  it('rejects run() after dispose without spawning a worker', async () => {
    const workerFactory = vi.fn(() => new FakeWorker() as unknown as Worker)
    const client = new FullResolutionExportWorkerClient(workerFactory)

    client.dispose()

    await expect(
      client.run({
        file: new File(['raw'], 'sample.ARW'),
        graph: supportedGraph,
      }),
    ).rejects.toThrow('FULL_RES_EXPORT_WORKER_DISPOSED')
    expect(workerFactory).not.toHaveBeenCalled()
  })

  it.each([Infinity, -Infinity, Number.NaN, 0, -1])(
    'rejects invalid preferred row count %s without spawning a worker',
    async (preferredRows) => {
      const workerFactory = vi.fn(() => new FakeWorker() as unknown as Worker)
      const client = new FullResolutionExportWorkerClient(workerFactory)

      await expect(
        client.run({
          file: new File(['raw'], 'sample.ARW'),
          graph: supportedGraph,
          preferredRows,
        }),
      ).rejects.toThrow('FULL_RES_EXPORT_INVALID_PREFERRED_ROWS')
      expect(workerFactory).not.toHaveBeenCalled()
    },
  )

  it('rejects pending requests, terminates the broken worker, and uses a fresh worker after onerror', async () => {
    const brokenWorker = new FakeWorker()
    const recoveredWorker = new FakeWorker()
    const workerFactory = vi
      .fn()
      .mockReturnValueOnce(brokenWorker as unknown as Worker)
      .mockReturnValueOnce(recoveredWorker as unknown as Worker)
    const client = new FullResolutionExportWorkerClient(workerFactory)

    const brokenPromise = client.run({
      file: new File(['raw'], 'sample.ARW'),
      graph: supportedGraph,
    })
    brokenWorker.emitError('worker failed')

    await expect(brokenPromise).rejects.toThrow('FULL_RES_EXPORT_WORKER_FAILED')
    expect(brokenWorker.terminate).toHaveBeenCalledTimes(1)

    const recoveredPromise = client.run({
      file: new File(['raw'], 'sample.ARW'),
      graph: supportedGraph,
    })
    const startRequest = recoveredWorker.requests[0]

    if (!startRequest || startRequest.kind !== 'start') {
      throw new Error('Expected a start request.')
    }

    recoveredWorker.emit({
      kind: 'success',
      requestId: startRequest.requestId,
      result: createBlobOutputResult({
        filename: 'sample.jpg',
        blob: new Blob([new Uint8Array([1])], { type: 'image/jpeg' }),
      }),
    })

    await expect(recoveredPromise).resolves.toMatchObject({
      kind: 'blob',
    })
    expect(workerFactory).toHaveBeenCalledTimes(2)
  })

  it('rejects pending requests and terminates the worker after onmessageerror', async () => {
    const worker = new FakeWorker()
    const client = new FullResolutionExportWorkerClient(
      () => worker as unknown as Worker,
    )

    const promise = client.run({
      file: new File(['raw'], 'sample.ARW'),
      graph: supportedGraph,
    })
    worker.emitMessageError()

    await expect(promise).rejects.toThrow('FULL_RES_EXPORT_WORKER_FAILED')
    expect(worker.terminate).toHaveBeenCalledTimes(1)
  })

  it('posts cancel and rejects when the abort signal fires', async () => {
    const worker = new FakeWorker()
    const client = new FullResolutionExportWorkerClient(
      () => worker as unknown as Worker,
    )
    const controller = new AbortController()

    const promise = client.run({
      file: new File(['raw'], 'sample.ARW'),
      graph: supportedGraph,
      signal: controller.signal,
    })
    const startRequest = worker.requests[0]
    controller.abort()

    await expect(promise).rejects.toThrow('FULL_RES_EXPORT_CANCELLED')
    expect(startRequest).toMatchObject({ kind: 'start' })
    expect(worker.requests[1]).toMatchObject({
      kind: 'cancel',
      requestId:
        startRequest && startRequest.kind === 'start'
          ? startRequest.requestId
          : undefined,
    })
  })

  it('rejects and tears down the worker when start postMessage throws', async () => {
    const worker = new ThrowingStartWorker()
    const client = new FullResolutionExportWorkerClient(
      () => worker as unknown as Worker,
    )

    await expect(
      client.run({
        file: new File(['raw'], 'sample.ARW'),
        graph: supportedGraph,
      }),
    ).rejects.toThrow('failed to post start message')
    expect(worker.terminate).toHaveBeenCalledTimes(1)
  })

  it('rejects earlier pending requests when a later start postMessage throws', async () => {
    const worker = new ThrowingSecondStartWorker()
    const client = new FullResolutionExportWorkerClient(
      () => worker as unknown as Worker,
    )

    const earlierPromise = client.run({
      file: new File(['raw'], 'first.ARW'),
      graph: supportedGraph,
    })
    const laterPromise = client.run({
      file: new File(['raw'], 'second.ARW'),
      graph: supportedGraph,
    })

    await expect(laterPromise).rejects.toThrow('failed to post start message')
    await expect(earlierPromise).rejects.toThrow('failed to post start message')
    expect(worker.terminate).toHaveBeenCalledTimes(1)
  })

  it('rejects and tears down the worker when cancel postMessage throws', async () => {
    const worker = new ThrowingCancelWorker()
    const client = new FullResolutionExportWorkerClient(
      () => worker as unknown as Worker,
    )
    const controller = new AbortController()

    const promise = client.run({
      file: new File(['raw'], 'sample.ARW'),
      graph: supportedGraph,
      signal: controller.signal,
    })
    controller.abort()

    await expect(promise).rejects.toThrow('failed to post cancel message')
    expect(worker.terminate).toHaveBeenCalledTimes(1)
  })

  it('one-shot helper does not spawn a worker when the signal is already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    const workerFactory = vi.fn(() => new FakeWorker() as unknown as Worker)

    await expect(
      runFullResolutionJpegExportInWorker(
        {
          file: new File(['raw'], 'sample.ARW'),
          graph: supportedGraph,
          signal: controller.signal,
        },
        () => new FullResolutionExportWorkerClient(workerFactory),
      ),
    ).rejects.toThrow('FULL_RES_EXPORT_CANCELLED')
    expect(workerFactory).not.toHaveBeenCalled()
  })
})
