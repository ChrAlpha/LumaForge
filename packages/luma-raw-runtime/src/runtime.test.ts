import { afterEach, describe, expect, it, vi } from 'vitest'

import { createLumaRawRuntime } from './runtime'
import type {
  LumaRawWorkerPayloadByType,
  LumaRawWorkerRequest,
  LumaRawWorkerRequestType,
  LumaRawWorkerResponse,
} from './worker-protocol'

class RecordingWorker {
  onmessage: ((event: MessageEvent<LumaRawWorkerResponse>) => void) | null =
    null
  onerror: ((event: ErrorEvent) => void) | null = null
  readonly requests: LumaRawWorkerRequest[] = []
  readonly transfers: Transferable[][] = []
  readonly terminate = vi.fn()

  constructor(private readonly shouldRespond = true) {}

  readonly postMessage = vi.fn(
    (request: LumaRawWorkerRequest, transfer?: Transferable[]) => {
      this.requests.push(request)
      this.transfers.push([...(transfer ?? [])])

      if (!this.shouldRespond) return

      queueMicrotask(() => {
        if (request.type === 'init') {
          this.onmessage?.({
            data: {
              id: request.id,
              ok: true,
              type: 'init',
              payload: {
                runtime: 'luma',
                version: '0.1.0',
                simd: true,
                pthreads: true,
                crossOriginIsolated: true,
                memoryTier: 'normal',
                memoryProfile: 'desktop',
                workerPoolSize: 2,
              },
            },
          } as MessageEvent<LumaRawWorkerResponse>)
        }

        if (request.type === 'openSession') {
          this.onmessage?.({
            data: {
              id: request.id,
              ok: true,
              type: 'openSession',
              payload: {
                sessionId: 'session-1',
                probe: {
                  jobId: request.id,
                  width: 1,
                  height: 1,
                  supportLevel: 'experimental',
                  timings: {
                    total: 7,
                  },
                },
                timings: {
                  total: 7,
                },
              },
            },
          } as MessageEvent<LumaRawWorkerResponse>)
        }

        if (request.type === 'extractEmbeddedPreviewFromSession') {
          this.onmessage?.({
            data: {
              id: request.id,
              ok: true,
              type: 'extractEmbeddedPreviewFromSession',
              payload: null,
            },
          } as MessageEvent<LumaRawWorkerResponse>)
        }

        if (request.type === 'decodeQuickFromSession') {
          this.onmessage?.({
            data: {
              id: request.id,
              ok: true,
              type: 'decodeQuickFromSession',
              payload: {
                jobId: request.id,
                sessionId: request.payload.sessionId,
                source: 'quick',
                width: 1,
                height: 1,
                data: new Uint16Array([1, 2, 3]),
                layout: 'rgb',
                bitDepth: 16,
                colorSpace: 'linear-prophoto-rgb',
                orientation: 1,
                metadata: {
                  width: 1,
                  height: 1,
                  supportLevel: 'experimental',
                },
                timings: {
                  total: 9,
                },
              },
            },
          } as MessageEvent<LumaRawWorkerResponse>)
        }

        if (request.type === 'decodeBoundedHqFromSession') {
          this.onmessage?.({
            data: {
              id: request.id,
              ok: true,
              type: 'decodeBoundedHqFromSession',
              payload: {
                jobId: request.id,
                sessionId: request.payload.sessionId,
                source: 'bounded-hq',
                width: 2,
                height: 2,
                data: new Uint16Array([4, 5, 6, 7]),
                layout: 'rgb',
                bitDepth: 16,
                colorSpace: 'linear-prophoto-rgb',
                orientation: 1,
                metadata: {
                  width: 2,
                  height: 2,
                  supportLevel: 'official',
                },
                timings: {
                  total: 11,
                },
              },
            },
          } as MessageEvent<LumaRawWorkerResponse>)
        }

        if (request.type === 'closeSession') {
          this.onmessage?.({
            data: {
              id: request.id,
              ok: true,
              type: 'closeSession',
              payload: { closed: true },
            },
          } as MessageEvent<LumaRawWorkerResponse>)
        }

        if (request.type === 'probe') {
          this.onmessage?.({
            data: {
              id: request.id,
              ok: true,
              type: 'probe',
              payload: {
                jobId: request.id,
                width: 1,
                height: 1,
                supportLevel: 'experimental',
                timings: {
                  total: 7,
                },
              },
            },
          } as MessageEvent<LumaRawWorkerResponse>)
        }

        if (request.type === 'extractEmbeddedPreview') {
          this.onmessage?.({
            data: {
              id: request.id,
              ok: true,
              type: 'extractEmbeddedPreview',
              payload: null,
            },
          } as MessageEvent<LumaRawWorkerResponse>)
        }

        if (request.type === 'decodeQuick') {
          this.onmessage?.({
            data: {
              id: request.id,
              ok: true,
              type: 'decodeQuick',
              payload: {
                jobId: request.id,
                source: 'quick',
                width: 1,
                height: 1,
                data: new Uint16Array([1, 2, 3]),
                layout: 'rgb',
                bitDepth: 16,
                colorSpace: 'linear-prophoto-rgb',
                orientation: 1,
                metadata: {
                  width: 1,
                  height: 1,
                  supportLevel: 'experimental',
                },
                timings: {
                  total: 9,
                },
              },
            },
          } as MessageEvent<LumaRawWorkerResponse>)
        }

        if (request.type === 'decodeBoundedHq') {
          this.onmessage?.({
            data: {
              id: request.id,
              ok: true,
              type: 'decodeBoundedHq',
              payload: {
                jobId: request.id,
                source: 'bounded-hq',
                width: 2,
                height: 2,
                data: new Uint16Array([4, 5, 6, 7]),
                layout: 'rgb',
                bitDepth: 16,
                colorSpace: 'linear-prophoto-rgb',
                orientation: 1,
                metadata: {
                  width: 2,
                  height: 2,
                  supportLevel: 'official',
                },
                timings: {
                  total: 11,
                },
              },
            },
          } as MessageEvent<LumaRawWorkerResponse>)
        }
      })
    },
  )
}

class EchoWorker {
  onmessage: ((event: MessageEvent<LumaRawWorkerResponse>) => void) | null =
    null
  onerror: ((event: ErrorEvent) => void) | null = null
  readonly terminate = vi.fn()

  constructor(
    private readonly handleRequest: (
      request: LumaRawWorkerRequest,
    ) =>
      | LumaRawWorkerResponse
      | LumaRawWorkerPayloadByType[LumaRawWorkerRequestType],
  ) {}

  readonly postMessage = vi.fn((request: LumaRawWorkerRequest) => {
    const handled = this.handleRequest(request)
    const response =
      handled &&
      typeof handled === 'object' &&
      'id' in handled &&
      'ok' in handled &&
      'type' in handled
        ? (handled as LumaRawWorkerResponse)
        : ({
            id: request.id,
            ok: true,
            type: request.type,
            payload: handled,
          } as LumaRawWorkerResponse)
    queueMicrotask(() => {
      this.onmessage?.({
        data: response,
      } as MessageEvent<LumaRawWorkerResponse>)
    })
  })
}

function createRuntime(
  worker = new RecordingWorker(),
  memoryProfile: 'desktop' | 'low-memory' = 'desktop',
) {
  return {
    runtime: createLumaRawRuntime({
      requireCrossOriginIsolation: false,
      memoryProfile,
      workerFactory: () => worker as unknown as Worker,
    }),
    worker,
  }
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('createLumaRawRuntime', () => {
  it('initializes through the worker client', async () => {
    const { runtime, worker } = createRuntime()

    await expect(runtime.init()).resolves.toMatchObject({
      runtime: 'luma',
      memoryTier: 'normal',
    })

    expect(worker.postMessage).toHaveBeenCalledWith(
      {
        id: expect.any(String),
        type: 'init',
        payload: {
          requireCrossOriginIsolation: false,
          memoryProfile: 'desktop',
        },
      },
      [],
    )

    runtime.dispose()
  })

  it('does not require cross-origin isolation for low-memory runtime profile', async () => {
    const requests: LumaRawWorkerRequest[] = []
    const worker = new EchoWorker((request) => {
      requests.push(request)

      return {
        runtime: 'luma',
        version: '0.1.0',
        simd: true,
        pthreads: false,
        crossOriginIsolated: false,
        memoryTier: 'low',
        memoryProfile: 'low-memory',
        workerPoolSize: 1,
      }
    })

    const runtime = createLumaRawRuntime({
      memoryProfile: 'low-memory',
      workerFactory: () => worker as unknown as Worker,
    })

    await expect(runtime.init()).resolves.toMatchObject({
      memoryProfile: 'low-memory',
      pthreads: false,
      memoryTier: 'low',
    })
    expect(requests[0]).toMatchObject({
      type: 'init',
      payload: {
        requireCrossOriginIsolation: false,
        memoryProfile: 'low-memory',
      },
    })

    runtime.dispose()
  })

  it('tags direct low-memory session requests before explicit init', async () => {
    const { runtime, worker } = createRuntime(
      new RecordingWorker(),
      'low-memory',
    )

    await runtime.probe(new File(['raw'], 'sample.ARW'))

    expect(worker.requests[0]).toMatchObject({
      type: 'openSession',
      payload: {
        memoryProfile: 'low-memory',
      },
    })

    runtime.dispose()
  })

  it('passes file metadata, transferables, and read timings into probe results', async () => {
    const { runtime, worker } = createRuntime()
    const timingSpy = vi.spyOn(performance, 'now')
    let now = 100
    timingSpy.mockImplementation(() => {
      const value = now
      now += 20
      return value
    })

    const file = new File(['raw'], 'sample.ARW')
    const probe = await runtime.probe(file)

    expect(worker.requests[0]).toMatchObject({
      type: 'openSession',
      payload: {
        fileName: 'sample.ARW',
        fileSize: file.size,
      },
    })
    expect(worker.transfers[0]).toHaveLength(1)
    const probeRequest = worker.requests[0]
    if (probeRequest.type !== 'openSession') {
      throw new Error('Expected openSession request.')
    }
    expect(worker.transfers[0][0]).toBe(probeRequest.payload.fileBuffer)
    expect(probe).toMatchObject({
      jobId: worker.requests[0].id,
      supportLevel: 'experimental',
      timings: {
        total: 27,
        readFile: 20,
      },
    })

    runtime.dispose()
  })

  it('passes through null embedded previews', async () => {
    const { runtime, worker } = createRuntime()

    const preview = await runtime.extractEmbeddedPreview(
      new File(['raw'], 'sample.ARW'),
    )

    expect(preview).toBeNull()
    expect(worker.requests[0]).toMatchObject({
      type: 'openSession',
      payload: {
        fileName: 'sample.ARW',
      },
    })
    expect(worker.requests[1]).toMatchObject({
      type: 'extractEmbeddedPreviewFromSession',
      payload: {
        sessionId: 'session-1',
      },
    })

    runtime.dispose()
  })

  it('returns bounded HQ decode frames through a temporary session', async () => {
    const { runtime, worker } = createRuntime()
    const timingSpy = vi.spyOn(performance, 'now')
    let now = 200
    timingSpy.mockImplementation(() => {
      const value = now
      now += 10
      return value
    })

    const frame = await runtime.decodeBoundedHq(
      new File(['raw'], 'sample.ARW'),
      { maxOutputPixels: 12_000_000 },
    )

    expect(frame).toMatchObject({
      source: 'bounded-hq',
      colorSpace: 'linear-prophoto-rgb',
      timings: {
        total: 28,
        readFile: 10,
      },
    })
    expect(worker.requests[0]).toMatchObject({
      type: 'openSession',
      payload: {
        fileName: 'sample.ARW',
        fileSize: 3,
      },
    })
    expect(worker.requests[1]).toMatchObject({
      type: 'decodeBoundedHqFromSession',
      payload: {
        sessionId: 'session-1',
        maxOutputPixels: 12_000_000,
      },
    })

    runtime.dispose()
  })

  it('opens a session once and runs embedded, quick, and bounded HQ by session id', async () => {
    const requests: string[] = []
    const worker = new EchoWorker((request) => {
      requests.push(request.type)

      if (request.type === 'openSession') {
        return {
          id: request.id,
          ok: true,
          type: 'openSession',
          payload: {
            sessionId: 'session-1',
            probe: {
              jobId: request.id,
              width: 6240,
              height: 4168,
              supportLevel: 'experimental',
              timings: { total: 10 },
            },
            timings: {
              readFile: 5,
              transferToWorker: 1,
              copyToWasm: 20,
              librawOpen: 30,
              total: 56,
            },
            heap: { before: 268435456, after: 268435456 },
          },
        }
      }

      if (request.type === 'extractEmbeddedPreviewFromSession') {
        return {
          id: request.id,
          ok: true,
          type: request.type,
          payload: {
            jobId: request.id,
            sessionId: 'session-1',
            source: 'embedded',
            width: 1616,
            height: 1080,
            data: new Uint8Array([1, 2, 3]),
            mimeType: 'image/jpeg',
            colorSpace: 'display-srgb-preview',
            orientation: 1,
            timings: { thumbnail: 7, total: 7 },
            heap: { before: 268435456, after: 268435456 },
          },
        }
      }

      if (
        request.type === 'decodeQuickFromSession' ||
        request.type === 'decodeBoundedHqFromSession'
      ) {
        return {
          id: request.id,
          ok: true,
          type: request.type,
          payload: {
            jobId: request.id,
            sessionId: 'session-1',
            source:
              request.type === 'decodeBoundedHqFromSession'
                ? 'bounded-hq'
                : 'quick',
            width: 1000,
            height: 667,
            data: new Uint16Array(1000 * 667 * 3),
            layout: 'rgb',
            bitDepth: 16,
            colorSpace: 'linear-prophoto-rgb',
            orientation: 1,
            metadata: {
              width: 1000,
              height: 667,
              supportLevel: 'experimental',
            },
            timings: { unpack: 100, total: 100 },
            heap: { before: 268435456, after: 268435456 },
          },
        }
      }

      return {
        id: request.id,
        ok: true,
        type: 'closeSession',
        payload: { closed: true },
      }
    })

    const runtime = createLumaRawRuntime({
      requireCrossOriginIsolation: false,
      workerFactory: () => worker as unknown as Worker,
    })

    const session = await runtime.openSession(new File(['raw'], 'sample.ARW'))
    await session.extractEmbeddedPreview()
    await session.decodeQuick()
    await session.decodeBoundedHq({ maxOutputPixels: 12_000_000 })
    session.dispose()

    expect(requests).toEqual([
      'openSession',
      'extractEmbeddedPreviewFromSession',
      'decodeQuickFromSession',
      'decodeBoundedHqFromSession',
      'closeSession',
    ])
  })

  it('sends bounded HQ session requests with an explicit pixel cap', async () => {
    const requests: Array<{ type: string; payload: unknown }> = []
    const worker = new EchoWorker((request) => {
      requests.push({ type: request.type, payload: request.payload })

      if (request.type === 'openSession') {
        return {
          id: request.id,
          ok: true,
          type: 'openSession',
          payload: {
            sessionId: 'raw-session-1',
            probe: {
              jobId: request.id,
              width: 6240,
              height: 4168,
              supportLevel: 'experimental',
              timings: { total: 10 },
            },
            timings: { total: 10 },
          },
        }
      }

      if (request.type === 'decodeBoundedHqFromSession') {
        return {
          id: request.id,
          ok: true,
          type: 'decodeBoundedHqFromSession',
          payload: {
            jobId: request.id,
            sessionId: 'raw-session-1',
            source: 'bounded-hq',
            width: 4000,
            height: 3000,
            data: new Uint16Array(4000 * 3000 * 3),
            layout: 'rgb',
            bitDepth: 16,
            colorSpace: 'linear-prophoto-rgb',
            orientation: 1,
            metadata: {
              width: 4000,
              height: 3000,
              supportLevel: 'experimental',
            },
            timings: { unpack: 100, total: 100 },
          },
        }
      }

      if (request.type === 'closeSession') {
        return {
          id: request.id,
          ok: true,
          type: 'closeSession',
          payload: { closed: true },
        }
      }

      throw new Error(`Unexpected request ${request.type}`)
    })

    const runtime = createLumaRawRuntime({
      requireCrossOriginIsolation: false,
      workerFactory: () => worker as unknown as Worker,
    })

    const session = await runtime.openSession(new File(['raw'], 'sample.RAF'))
    const frame = await session.decodeBoundedHq({ maxOutputPixels: 12_000_000 })

    expect(frame.source).toBe('bounded-hq')
    expect(requests.map((request) => request.type)).toContain(
      'decodeBoundedHqFromSession',
    )
    expect(requests.at(-1)?.payload).toMatchObject({
      sessionId: 'raw-session-1',
      maxOutputPixels: 12_000_000,
    })

    session.dispose()
  })

  it('forwards export capability and raw-window requests through the session', async () => {
    const processedWindowRequest = {
      outputRect: { x: 0, y: 0, width: 2, height: 1 },
      halo: { left: 1, top: 1, right: 1, bottom: 1 },
    }
    const seenProcessedWindowRequests: unknown[] = []
    const seenLifecycleRequests: string[] = []
    const worker = new EchoWorker((request) => {
      if (request.type === 'init') {
        return {
          runtime: 'luma',
          version: '0.1.0',
          simd: true,
          pthreads: true,
          crossOriginIsolated: true,
          memoryTier: 'normal',
          memoryProfile: 'desktop',
          workerPoolSize: 1,
        }
      }
      if (request.type === 'openSession') {
        return {
          sessionId: 's1',
          probe: {
            jobId: request.id,
            supportLevel: 'experimental',
            width: 4,
            height: 4,
            timings: { total: 1 },
          },
          timings: { total: 1 },
        }
      }
      if (request.type === 'probeExportCapabilityFromSession') {
        return {
          supported: true,
          width: 4,
          height: 4,
          rawWidth: 4,
          rawHeight: 4,
          visibleCrop: { x: 0, y: 0, width: 4, height: 4 },
          cfa: { pattern: 'rggb', xPhase: 0, yPhase: 0 },
          blackLevel: 0,
          whiteLevel: 65535,
          orientation: { code: 1, supported: true },
          color: {
            whiteBalance: [2, 1, 1.5, 1],
            cameraToWorkingRgb: [1, 0, 0, 0, 1, 0, 0, 0, 1],
            workingSpace: 'linear-prophoto-rgb',
            librawOutputColor: 'prophoto',
            gamma: 'linear',
            cameraWhiteBalanceAppliedByRuntime: true,
            cameraMatrixAppliedByRuntime: true,
          },
          sensor: {
            layout: 'bayer',
            colorCount: 3,
            cfa: { pattern: 'rggb', xPhase: 0, yPhase: 0 },
            phaseIsWindowLocal: false,
          },
          windows: { librawProcessed: false, rawMosaic: true },
          diagnostics: {
            hasRawImage: true,
            hasColor3Image: false,
            hasColor4Image: false,
            hasXTransTable: false,
          },
          reasons: [],
        }
      }
      if (request.type === 'readRawWindowFromSession') {
        return {
          rect: request.payload.rect,
          cfa: { pattern: 'rggb', xPhase: 0, yPhase: 0 },
          data: new Uint16Array(4),
          blackLevel: 0,
          whiteLevel: 65535,
        }
      }
      if (request.type === 'readProcessedWindowFromSession') {
        seenProcessedWindowRequests.push(request.payload)
        return {
          rect: request.payload.request.outputRect,
          workingSpace: 'linear-prophoto-rgb',
          data: new Uint16Array([1, 2, 3, 4, 5, 6]),
          width: 2,
          height: 1,
          stride: 6,
          normalized: false,
          orientationApplied: true,
          colorApplied: true,
          warnings: [],
        }
      }
      if (request.type === 'beginProcessedWindowExportFromSession') {
        seenLifecycleRequests.push(request.type)
        return { active: true }
      }
      if (request.type === 'endProcessedWindowExportFromSession') {
        seenLifecycleRequests.push(request.type)
        return { ended: true }
      }
      if (request.type === 'closeSession') return { closed: true }
      throw new Error(`Unexpected request: ${request.type}`)
    })
    const runtime = createLumaRawRuntime({
      requireCrossOriginIsolation: false,
      workerFactory: () => worker as unknown as Worker,
    })

    const session = await runtime.openSession(new File(['raw'], 'a.dng'))
    await expect(session.probeExportCapability()).resolves.toMatchObject({
      supported: true,
      width: 4,
      height: 4,
      visibleCrop: { x: 0, y: 0, width: 4, height: 4 },
      orientation: { code: 1, supported: true },
      color: {
        whiteBalance: expect.any(Array),
        cameraToWorkingRgb: expect.any(Array),
        workingSpace: 'linear-prophoto-rgb',
      },
    })
    await expect(
      session.readRawWindow({ x: 0, y: 0, width: 2, height: 2 }),
    ).resolves.toMatchObject({
      rect: { x: 0, y: 0, width: 2, height: 2 },
    })
    const controller = new AbortController()
    await expect(
      session.readProcessedWindow(processedWindowRequest, controller.signal),
    ).resolves.toMatchObject({
      rect: processedWindowRequest.outputRect,
      workingSpace: 'linear-prophoto-rgb',
    })
    expect(seenProcessedWindowRequests).toEqual([
      {
        memoryProfile: 'desktop',
        sessionId: 's1',
        request: processedWindowRequest,
      },
    ])
    const lifecycleController = new AbortController()
    expect(session.beginProcessedWindowExport).toBeTypeOf('function')
    expect(session.endProcessedWindowExport).toBeTypeOf('function')
    await expect(
      session.beginProcessedWindowExport!(lifecycleController.signal),
    ).resolves.toEqual({ active: true })
    await expect(
      session.endProcessedWindowExport!(lifecycleController.signal),
    ).resolves.toEqual({ ended: true })
    expect(seenLifecycleRequests).toEqual([
      'beginProcessedWindowExportFromSession',
      'endProcessedWindowExportFromSession',
    ])
  })

  it('applies a calibration profile through the session, transferring the matrix and tone curve buffers', async () => {
    const transfers: Array<{ type: string; transfer: Transferable[] }> = []
    const echoWorker = new EchoWorker((request) => {
      if (request.type === 'openSession') {
        return {
          sessionId: 'cal-session-1',
          probe: {
            jobId: request.id,
            width: 6240,
            height: 4168,
            supportLevel: 'experimental' as const,
            timings: { total: 1 },
          },
          timings: { total: 1 },
        }
      }
      if (request.type === 'applyCalibrationToSession') {
        return { applied: true } as const
      }
      if (request.type === 'closeSession') {
        return { closed: true } as const
      }
      throw new Error(`Unexpected request: ${request.type}`)
    })
    const worker = {
      get onmessage() {
        return echoWorker.onmessage
      },
      set onmessage(value: typeof echoWorker.onmessage) {
        echoWorker.onmessage = value
      },
      get onerror() {
        return echoWorker.onerror
      },
      set onerror(value: typeof echoWorker.onerror) {
        echoWorker.onerror = value
      },
      terminate: echoWorker.terminate,
      postMessage: vi.fn(
        (request: LumaRawWorkerRequest, transfer?: Transferable[]) => {
          transfers.push({ type: request.type, transfer: transfer ?? [] })
          echoWorker.postMessage(request)
        },
      ),
    }
    const runtime = createLumaRawRuntime({
      requireCrossOriginIsolation: false,
      workerFactory: () => worker as unknown as Worker,
    })

    const session = await runtime.openSession(new File(['raw'], 'sample.ARW'))

    const xyzToCamera = new Float32Array([
      0.7, 0.2, 0.1, 0.3, 0.85, -0.15, -0.05, 0.1, 0.95,
    ])
    const toneCurveLut = new Float32Array(4096)
    for (let index = 0; index < toneCurveLut.length; index += 1) {
      toneCurveLut[index] = index / (toneCurveLut.length - 1)
    }

    await expect(
      session.applyCalibration({
        profileId: 'adobe-standard',
        profileName: 'Adobe Standard',
        xyzToCamera,
        toneCurveLut,
      }),
    ).resolves.toEqual({ applied: true })

    const applyCall = transfers.find(
      (entry) => entry.type === 'applyCalibrationToSession',
    )
    expect(applyCall).toBeDefined()
    expect(applyCall?.transfer).toEqual([
      xyzToCamera.buffer,
      toneCurveLut.buffer,
    ])

    session.dispose()
  })

  it('applies a calibration profile without a tone-curve LUT', async () => {
    const transfers: Array<{ type: string; transfer: Transferable[] }> = []
    const echoWorker = new EchoWorker((request) => {
      if (request.type === 'openSession') {
        return {
          sessionId: 'cal-session-2',
          probe: {
            jobId: request.id,
            width: 6240,
            height: 4168,
            supportLevel: 'experimental' as const,
            timings: { total: 1 },
          },
          timings: { total: 1 },
        }
      }
      if (request.type === 'applyCalibrationToSession') {
        return { applied: true } as const
      }
      if (request.type === 'closeSession') {
        return { closed: true } as const
      }
      throw new Error(`Unexpected request: ${request.type}`)
    })
    const worker = {
      get onmessage() {
        return echoWorker.onmessage
      },
      set onmessage(value: typeof echoWorker.onmessage) {
        echoWorker.onmessage = value
      },
      get onerror() {
        return echoWorker.onerror
      },
      set onerror(value: typeof echoWorker.onerror) {
        echoWorker.onerror = value
      },
      terminate: echoWorker.terminate,
      postMessage: vi.fn(
        (request: LumaRawWorkerRequest, transfer?: Transferable[]) => {
          transfers.push({ type: request.type, transfer: transfer ?? [] })
          echoWorker.postMessage(request)
        },
      ),
    }
    const runtime = createLumaRawRuntime({
      requireCrossOriginIsolation: false,
      workerFactory: () => worker as unknown as Worker,
    })

    const session = await runtime.openSession(new File(['raw'], 'sample.ARW'))
    const xyzToCamera = new Float32Array(9)

    await session.applyCalibration({
      profileId: 'matrix-only',
      profileName: 'Matrix Only',
      xyzToCamera,
    })

    const applyCall = transfers.find(
      (entry) => entry.type === 'applyCalibrationToSession',
    )
    expect(applyCall?.transfer).toEqual([xyzToCamera.buffer])

    session.dispose()
  })

  it('does not recreate a worker when disposing a session after runtime disposal', async () => {
    const worker = new RecordingWorker()
    const workerFactory = vi.fn(() => worker as unknown as Worker)
    const runtime = createLumaRawRuntime({
      requireCrossOriginIsolation: false,
      workerFactory,
    })

    const session = await runtime.openSession(new File(['raw'], 'sample.ARW'))

    expect(workerFactory).toHaveBeenCalledTimes(1)
    runtime.dispose()
    session.dispose()

    expect(workerFactory).toHaveBeenCalledTimes(1)
    expect(worker.requests.map((request) => request.type)).toEqual([
      'openSession',
    ])
  })

  it('rejects before file reading starts when aborted', async () => {
    const { runtime, worker } = createRuntime()
    const readFile = vi.fn(() => Promise.resolve(new ArrayBuffer(4)))
    const file = {
      name: 'sample.ARW',
      size: 4,
      arrayBuffer: readFile,
    } as unknown as File
    const controller = new AbortController()

    controller.abort()

    await expect(
      runtime.decodeQuick(file, controller.signal),
    ).rejects.toMatchObject({
      code: 'RAW_JOB_CANCELLED',
    })
    expect(readFile).not.toHaveBeenCalled()
    expect(worker.postMessage).not.toHaveBeenCalled()

    runtime.dispose()
  })

  it('uses file arrayBuffer for signalled reads when available', async () => {
    const { runtime, worker } = createRuntime()
    const readFile = vi.fn(() => Promise.resolve(new ArrayBuffer(4)))
    const file = {
      name: 'sample.ARW',
      size: 4,
      arrayBuffer: readFile,
    } as unknown as File
    const controller = new AbortController()

    await runtime.decodeQuick(file, controller.signal)

    expect(readFile).toHaveBeenCalledTimes(1)
    expect(worker.requests[0]?.type).toBe('openSession')

    runtime.dispose()
  })

  it('rejects while reading through FileReader fallback and never posts the worker request', async () => {
    const { runtime, worker } = createRuntime()
    const file = {
      name: 'sample.ARW',
      size: 4,
    } as unknown as File
    const controller = new AbortController()
    const fileReaderState = {
      readCalls: 0,
      aborted: 0,
    }
    class AbortableFileReader {
      onload: ((event: ProgressEvent<FileReader>) => void) | null = null
      onerror: ((event: ProgressEvent<FileReader>) => void) | null = null
      onabort: ((event: ProgressEvent<FileReader>) => void) | null = null
      result: string | ArrayBuffer | null = null
      error: DOMException | null = null
      readAsArrayBuffer(_blob: Blob) {
        fileReaderState.readCalls += 1
      }
      abort() {
        fileReaderState.aborted += 1
      }
      addEventListener() {}
      removeEventListener() {}
      dispatchEvent() {
        return true
      }
    }
    vi.stubGlobal('FileReader', AbortableFileReader)

    const promise = runtime.decodeQuick(file, controller.signal)
    expect(fileReaderState.readCalls).toBe(1)

    controller.abort()

    await expect(promise).rejects.toMatchObject({
      code: 'RAW_JOB_CANCELLED',
    })
    expect(fileReaderState.aborted).toBe(1)
    expect(worker.postMessage).not.toHaveBeenCalled()

    runtime.dispose()
  })

  it('disposes the worker and rejects pending requests', async () => {
    const { runtime, worker } = createRuntime(new RecordingWorker(false))
    const readFile = vi.fn(() => Promise.resolve(new ArrayBuffer(4)))
    const file = {
      name: 'sample.ARW',
      size: 4,
      arrayBuffer: readFile,
    } as unknown as File

    const promise = runtime.decodeQuick(file)

    await Promise.resolve()
    await Promise.resolve()

    expect(readFile).toHaveBeenCalledTimes(1)
    expect(worker.requests).toHaveLength(1)

    runtime.dispose()

    await expect(promise).rejects.toMatchObject({
      code: 'RAW_RUNTIME_UNAVAILABLE',
    })
    expect(worker.terminate).toHaveBeenCalledTimes(1)
  })
})
