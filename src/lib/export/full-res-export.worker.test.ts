import { createHash } from 'node:crypto'

import { resolveExportColorGraph } from '@lumaforge/luma-color-runtime'
import { createLumaJpegRuntime } from '@lumaforge/luma-jpeg-runtime'
import type { LumaRawProcessedWindowRequest } from '@lumaforge/luma-raw-runtime'
import { createLumaRawRuntime } from '@lumaforge/luma-raw-runtime'
import {
  preserveJpegMetadata,
  runFullResolutionJpegExport,
} from '@lumaforge/render-engine/export'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { runProcessedWindowExportLifecycle } from './full-res-export.worker'
import type { FullResExportWorkerResponse } from './full-res-export-client'
import {
  createBlobOutputResult,
  createMemoryFileBackedOutputResult,
  createOpfsOutputWritable,
  materializeOutputBlob,
} from './output-sink'

vi.mock('@lumaforge/luma-raw-runtime', () => ({
  createLumaRawRuntime: vi.fn(),
}))

vi.mock('@lumaforge/luma-jpeg-runtime', () => ({
  createLumaJpegRuntime: vi.fn(),
}))

vi.mock('./output-sink', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./output-sink')>()),
  createOpfsOutputWritable: vi.fn(),
}))

vi.mock('@lumaforge/render-engine/export', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@lumaforge/render-engine/export')>()
  return {
    ...actual,
    runFullResolutionJpegExport: vi.fn(),
  }
})

function createFakeOpfsWritable() {
  return {
    write: vi.fn(async () => undefined),
    close: vi.fn(async () => ({ byteLength: 3, sha256: 'f'.repeat(64) })),
    abort: vi.fn(async () => undefined),
  }
}

beforeEach(() => {
  vi.mocked(createOpfsOutputWritable).mockReset()
  vi.mocked(createOpfsOutputWritable).mockImplementation(
    async () => createFakeOpfsWritable() as never,
  )
})

afterEach(() => {
  vi.restoreAllMocks()
})

function makeJfifOnlyJpeg() {
  return new Blob(
    [
      new Uint8Array([
        255, 216, 255, 224, 0, 16, 74, 70, 73, 70, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0,
        255, 217,
      ]),
    ],
    { type: 'image/jpeg' },
  )
}

function bytesIncludeAscii(bytes: Uint8Array, value: string) {
  const needle = Array.from(value, (character) => character.charCodeAt(0))

  return bytes.some((_byte, index) =>
    needle.every(
      (needleByte, needleIndex) => bytes[index + needleIndex] === needleByte,
    ),
  )
}

function readBlobBytes(blob: Blob) {
  return new Promise<Uint8Array>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      if (reader.result instanceof ArrayBuffer) {
        resolve(new Uint8Array(reader.result))
        return
      }

      reject(new Error('Expected Blob to read as an ArrayBuffer.'))
    }
    reader.onerror = () =>
      reject(reader.error ?? new Error('Failed to read Blob bytes.'))
    reader.readAsArrayBuffer(blob)
  })
}

describe('runProcessedWindowExportLifecycle', () => {
  it('runs begin, export, and end before returning the export result', async () => {
    const order: string[] = []
    const beginProcessedWindowExport = vi.fn(async () => {
      order.push('begin')
    })
    const runExport = vi.fn(async () => {
      order.push('export')
      return new Blob(['jpeg'], { type: 'image/jpeg' })
    })
    const endProcessedWindowExport = vi.fn(async () => {
      order.push('end')
    })

    await expect(
      runProcessedWindowExportLifecycle({
        beginProcessedWindowExport,
        endProcessedWindowExport,
        runExport,
      }),
    ).resolves.toMatchObject({ type: 'image/jpeg' })

    expect(order).toEqual(['begin', 'export', 'end'])
  })

  it('runs end and preserves the original export error when export fails', async () => {
    const exportError = new Error('EXPORT_FAILED')
    const beginProcessedWindowExport = vi.fn(async () => undefined)
    const runExport = vi.fn(async () => {
      throw exportError
    })
    const endProcessedWindowExport = vi.fn(async () => undefined)

    await expect(
      runProcessedWindowExportLifecycle({
        beginProcessedWindowExport,
        endProcessedWindowExport,
        runExport,
      }),
    ).rejects.toBe(exportError)
    expect(endProcessedWindowExport).toHaveBeenCalledTimes(1)
  })

  it('runs end without the aborted export signal after cancellation happens after begin', async () => {
    const controller = new AbortController()
    const beginProcessedWindowExport = vi.fn(async () => undefined)
    const runExport = vi.fn(async () => {
      controller.abort()
      throw new Error('FULL_RES_EXPORT_CANCELLED')
    })
    const endProcessedWindowExport = vi.fn(async () => undefined)

    await expect(
      runProcessedWindowExportLifecycle({
        beginProcessedWindowExport,
        endProcessedWindowExport,
        runExport,
        signal: controller.signal,
      }),
    ).rejects.toThrow('FULL_RES_EXPORT_CANCELLED')
    expect(endProcessedWindowExport).toHaveBeenCalledWith()
  })

  it('runs export without end when begin is unavailable', async () => {
    const runExport = vi.fn(async () => 'exported')
    const endProcessedWindowExport = vi.fn(async () => undefined)

    await expect(
      runProcessedWindowExportLifecycle({
        endProcessedWindowExport,
        runExport,
      }),
    ).resolves.toBe('exported')
    expect(runExport).toHaveBeenCalledTimes(1)
    expect(endProcessedWindowExport).not.toHaveBeenCalled()
  })

  it('does not run export or end when begin throws', async () => {
    const beginError = new Error('BEGIN_FAILED')
    const beginProcessedWindowExport = vi.fn(async () => {
      throw beginError
    })
    const runExport = vi.fn(async () => 'exported')
    const endProcessedWindowExport = vi.fn(async () => undefined)

    await expect(
      runProcessedWindowExportLifecycle({
        beginProcessedWindowExport,
        endProcessedWindowExport,
        runExport,
      }),
    ).rejects.toBe(beginError)
    expect(runExport).not.toHaveBeenCalled()
    expect(endProcessedWindowExport).not.toHaveBeenCalled()
  })

  it('preserves the original export error when end also throws', async () => {
    const exportError = new Error('EXPORT_FAILED')
    const cleanupError = new Error('END_FAILED')
    const beginProcessedWindowExport = vi.fn(async () => undefined)
    const runExport = vi.fn(async () => {
      throw exportError
    })
    const endProcessedWindowExport = vi.fn(async () => {
      throw cleanupError
    })

    await expect(
      runProcessedWindowExportLifecycle({
        beginProcessedWindowExport,
        endProcessedWindowExport,
        runExport,
      }),
    ).rejects.toBe(exportError)
  })

  it('fails before returning success when end throws after a successful export', async () => {
    const cleanupError = new Error('END_FAILED')
    const beginProcessedWindowExport = vi.fn(async () => undefined)
    const runExport = vi.fn(async () => 'exported')
    const endProcessedWindowExport = vi.fn(async () => {
      throw cleanupError
    })

    await expect(
      runProcessedWindowExportLifecycle({
        beginProcessedWindowExport,
        endProcessedWindowExport,
        runExport,
      }),
    ).rejects.toBe(cleanupError)
  })
})

describe('full-resolution export worker lifecycle responses', () => {
  it('uses execution plan runtime profile and emits checkpoint metrics', async () => {
    const responses: FullResExportWorkerResponse[] = []
    vi.spyOn(self, 'postMessage').mockImplementation((message) => {
      responses.push(message as FullResExportWorkerResponse)
    })
    const session = {
      probe: {
        width: 4,
        height: 4,
        supportLevel: 'full',
        timings: { total: 1 },
      },
      probeExportCapability: vi.fn(async () => ({
        supported: true,
        width: 4,
        height: 4,
      })),
      readProcessedWindow: vi.fn(),
      beginProcessedWindowExport: vi.fn(async () => undefined),
      endProcessedWindowExport: vi.fn(async () => undefined),
      dispose: vi.fn(),
    }
    const runtime = {
      init: vi.fn(async () => undefined),
      openSession: vi.fn(async () => session),
      dispose: vi.fn(),
    }
    vi.mocked(createLumaRawRuntime).mockReturnValue(runtime as never)
    vi.mocked(runFullResolutionJpegExport).mockImplementation(async (input) => {
      await input.onCheckpoint?.({
        completedRowsForDiagnostics: 64,
        totalRows: 128,
        stripRows: 64,
      })
      return createBlobOutputResult({
        filename: 'sample.jpg',
        blob: makeJfifOnlyJpeg(),
      })
    })

    self.onmessage?.({
      data: {
        kind: 'start',
        requestId: 'request-low-memory',
        file: new File(['raw'], 'sample.RAF'),
        graph: {
          supported: true,
          outputGamut: 'srgb-rec709',
          outputTransfer: 'srgb',
          lutProfile: null,
          steps: [{ kind: 'input-linear-prophoto' }, { kind: 'output-srgb' }],
        },
        executionPlan: {
          profileName: 'desktop-fast',
          preferredRows: 64,
          concurrency: 1,
          runtimeMemoryProfile: 'low-memory',
          outputSink: 'opfs-file',
          checkpointMode: 'safe-retry',
        },
        outputLocation: { sink: 'opfs-file', exportId: 'export-1' },
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
        quality: 0.9,
        collectMetrics: false,
      },
    } as MessageEvent)

    await vi.waitFor(() => {
      expect(responses.some((response) => response.kind === 'success')).toBe(
        true,
      )
    })

    expect(createLumaRawRuntime).toHaveBeenCalledWith({
      memoryProfile: 'low-memory',
      requireCrossOriginIsolation: false,
    })
    expect(runFullResolutionJpegExport).toHaveBeenCalledWith(
      expect.objectContaining({
        preferredRows: 64,
        concurrency: 1,
        quality: 0.9,
        jpegSink: expect.any(Object),
        retryPolicy: 'surface-resource-failure',
        onCheckpoint: expect.any(Function),
      }),
    )
    expect(responses).toContainEqual(
      expect.objectContaining({
        kind: 'metric',
        requestId: 'request-low-memory',
        metric: expect.objectContaining({
          kind: 'checkpoint',
          requestId: 'request-low-memory',
          completedRowsForDiagnostics: 64,
          totalRows: 128,
          stripRows: 64,
        }),
      }),
    )
  })

  it('returns file-backed worker results without materializing them', async () => {
    const terminalResponse = new Promise<FullResExportWorkerResponse>(
      (resolve) => {
        vi.spyOn(self, 'postMessage').mockImplementation((message) => {
          const response = message as FullResExportWorkerResponse
          if (response.kind === 'success' || response.kind === 'error') {
            resolve(response)
          }
        })
      },
    )
    const session = {
      probe: {
        width: 4,
        height: 4,
        supportLevel: 'full',
        timings: { total: 1 },
      },
      probeExportCapability: vi.fn(async () => ({
        supported: true,
        width: 4,
        height: 4,
      })),
      readProcessedWindow: vi.fn(),
      beginProcessedWindowExport: vi.fn(async () => undefined),
      endProcessedWindowExport: vi.fn(async () => undefined),
      dispose: vi.fn(),
    }
    const runtime = {
      init: vi.fn(async () => undefined),
      openSession: vi.fn(async () => session),
      dispose: vi.fn(),
    }
    const output = createMemoryFileBackedOutputResult({
      exportId: 'export-1',
      filename: 'safe-output.jpg',
      mimeType: 'image/jpeg',
      bytes: new Uint8Array([1, 2, 3]),
    })
    const openBlob = vi.spyOn(output, 'openBlob')
    vi.mocked(createLumaRawRuntime).mockReturnValue(runtime as never)
    vi.mocked(runFullResolutionJpegExport).mockResolvedValue(output)

    self.onmessage?.({
      data: {
        kind: 'start',
        requestId: 'request-file-backed',
        file: new File(['raw'], 'sample.RAF'),
        filename: 'safe-output.jpg',
        graph: {
          supported: true,
          outputGamut: 'srgb-rec709',
          outputTransfer: 'srgb',
          lutProfile: null,
          steps: [{ kind: 'input-linear-prophoto' }, { kind: 'output-srgb' }],
        },
        executionPlan: {
          profileName: 'ios-safe',
          preferredRows: 64,
          concurrency: 1,
          runtimeMemoryProfile: 'low-memory',
          outputSink: 'opfs-file',
          checkpointMode: 'safe-retry',
        },
        outputLocation: { sink: 'opfs-file', exportId: 'export-1' },
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
        collectMetrics: false,
      },
    } as MessageEvent)

    const response = await terminalResponse

    expect(openBlob).not.toHaveBeenCalled()
    expect(response).toMatchObject({
      kind: 'success',
      requestId: 'request-file-backed',
      result: {
        kind: 'file-backed',
        storage: 'opfs',
        exportId: 'export-1',
        filename: 'safe-output.jpg',
        byteLength: 3,
        mimeType: 'image/jpeg',
      },
    })
  })

  it('releases the RAW runtime before posting a file-backed success response', async () => {
    const order: string[] = []
    const terminalResponse = new Promise<FullResExportWorkerResponse>(
      (resolve) => {
        vi.spyOn(self, 'postMessage').mockImplementation((message) => {
          const response = message as FullResExportWorkerResponse
          if (response.kind === 'success' || response.kind === 'error') {
            order.push(response.kind)
            resolve(response)
          }
        })
      },
    )
    const session = {
      probe: {
        width: 4,
        height: 4,
        supportLevel: 'full',
        timings: { total: 1 },
      },
      probeExportCapability: vi.fn(async () => ({
        supported: true,
        width: 4,
        height: 4,
      })),
      readProcessedWindow: vi.fn(),
      beginProcessedWindowExport: vi.fn(async () => undefined),
      endProcessedWindowExport: vi.fn(async () => undefined),
      dispose: vi.fn(() => {
        order.push('session.dispose')
      }),
    }
    const runtime = {
      init: vi.fn(async () => undefined),
      openSession: vi.fn(async () => session),
      dispose: vi.fn(() => {
        order.push('runtime.dispose')
      }),
    }
    vi.mocked(createLumaRawRuntime).mockReturnValue(runtime as never)
    vi.mocked(runFullResolutionJpegExport).mockResolvedValue(
      createMemoryFileBackedOutputResult({
        exportId: 'export-1',
        filename: 'safe-output.jpg',
        mimeType: 'image/jpeg',
        bytes: new Uint8Array([1, 2, 3]),
      }),
    )

    self.onmessage?.({
      data: {
        kind: 'start',
        requestId: 'request-file-backed-release',
        file: new File(['raw'], 'sample.RAF'),
        filename: 'safe-output.jpg',
        graph: {
          supported: true,
          outputGamut: 'srgb-rec709',
          outputTransfer: 'srgb',
          lutProfile: null,
          steps: [{ kind: 'input-linear-prophoto' }, { kind: 'output-srgb' }],
        },
        executionPlan: {
          profileName: 'ios-safe',
          preferredRows: 64,
          concurrency: 1,
          runtimeMemoryProfile: 'low-memory',
          outputSink: 'opfs-file',
          checkpointMode: 'safe-retry',
        },
        outputLocation: { sink: 'opfs-file', exportId: 'export-1' },
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
        collectMetrics: false,
      },
    } as MessageEvent)

    await expect(terminalResponse).resolves.toMatchObject({ kind: 'success' })
    expect(order).toEqual(['session.dispose', 'runtime.dispose', 'success'])
    expect(session.dispose).toHaveBeenCalledTimes(1)
    expect(runtime.dispose).toHaveBeenCalledTimes(1)
  })

  it('includes next row hints when worker resource retry fails', async () => {
    const terminalResponse = new Promise<FullResExportWorkerResponse>(
      (resolve) => {
        vi.spyOn(self, 'postMessage').mockImplementation((message) => {
          const response = message as FullResExportWorkerResponse
          if (response.kind === 'success' || response.kind === 'error') {
            resolve(response)
          }
        })
      },
    )
    const session = {
      probeExportCapability: vi.fn(async () => ({
        supported: true,
        width: 1,
        height: 1,
      })),
      readProcessedWindow: vi.fn(),
      beginProcessedWindowExport: vi.fn(async () => undefined),
      endProcessedWindowExport: vi.fn(async () => undefined),
      dispose: vi.fn(),
    }
    const runtime = {
      init: vi.fn(async () => undefined),
      openSession: vi.fn(async () => session),
      dispose: vi.fn(),
    }
    vi.mocked(createLumaRawRuntime).mockReturnValue(runtime as never)
    vi.mocked(runFullResolutionJpegExport).mockRejectedValue(
      Object.assign(new Error('FULL_RES_EXPORT_RESOURCE_FAILURE'), {
        nextRows: 96,
      }),
    )

    self.onmessage?.({
      data: {
        kind: 'start',
        requestId: 'request-resource-failure',
        file: new File(['raw'], 'sample.RAF'),
        graph: {
          supported: true,
          outputGamut: 'srgb-rec709',
          outputTransfer: 'srgb',
          lutProfile: null,
          steps: [{ kind: 'input-linear-prophoto' }, { kind: 'output-srgb' }],
        },
        collectMetrics: false,
      },
    } as MessageEvent)

    await expect(terminalResponse).resolves.toEqual({
      kind: 'error',
      requestId: 'request-resource-failure',
      message: 'FULL_RES_EXPORT_RESOURCE_FAILURE',
      nextRows: 96,
    })
  })

  it('keeps desktop runtime cross-origin isolation requirement by default', async () => {
    const terminalResponse = new Promise<FullResExportWorkerResponse>(
      (resolve) => {
        vi.spyOn(self, 'postMessage').mockImplementation((message) => {
          const response = message as FullResExportWorkerResponse
          if (response.kind === 'success' || response.kind === 'error') {
            resolve(response)
          }
        })
      },
    )
    const session = {
      probe: {
        width: 4,
        height: 4,
        supportLevel: 'full',
        timings: { total: 1 },
      },
      probeExportCapability: vi.fn(async () => ({
        supported: true,
        width: 4,
        height: 4,
      })),
      readProcessedWindow: vi.fn(),
      beginProcessedWindowExport: vi.fn(async () => undefined),
      endProcessedWindowExport: vi.fn(async () => undefined),
      dispose: vi.fn(),
    }
    const runtime = {
      init: vi.fn(async () => undefined),
      openSession: vi.fn(async () => session),
      dispose: vi.fn(),
    }
    vi.mocked(createLumaRawRuntime).mockReturnValue(runtime as never)
    vi.mocked(runFullResolutionJpegExport).mockResolvedValue(
      createBlobOutputResult({
        filename: 'sample.jpg',
        blob: makeJfifOnlyJpeg(),
      }),
    )

    self.onmessage?.({
      data: {
        kind: 'start',
        requestId: 'request-desktop',
        file: new File(['raw'], 'sample.RAF'),
        graph: {
          supported: true,
          outputGamut: 'srgb-rec709',
          outputTransfer: 'srgb',
          lutProfile: null,
          steps: [{ kind: 'input-linear-prophoto' }, { kind: 'output-srgb' }],
        },
        collectMetrics: false,
      },
    } as MessageEvent)

    await expect(terminalResponse).resolves.toMatchObject({ kind: 'success' })
    expect(createLumaRawRuntime).toHaveBeenCalledWith({
      memoryProfile: 'desktop',
      requireCrossOriginIsolation: true,
    })
    expect(runFullResolutionJpegExport).toHaveBeenCalledWith(
      expect.objectContaining({
        retryPolicy: 'in-process',
        onCheckpoint: undefined,
      }),
    )
  })

  it('writes EXIF metadata into the successful JPEG response', async () => {
    const terminalResponse = new Promise<FullResExportWorkerResponse>(
      (resolve) => {
        vi.spyOn(self, 'postMessage').mockImplementation((message) => {
          const response = message as FullResExportWorkerResponse
          if (response.kind === 'success' || response.kind === 'error') {
            resolve(response)
          }
        })
      },
    )
    const session = {
      probe: {
        jobId: 'raw-job-1',
        make: 'Sony',
        model: 'ILCE-7RM5',
        lens: 'FE 50mm F1.4 GM',
        iso: 125,
        aperture: 1.4,
        focalLength: 50,
        shutter: 0.005,
        timestamp: 1_704_067_200,
        width: 9504,
        height: 6336,
        supportLevel: 'experimental',
        timings: { total: 1 },
      },
      probeExportCapability: vi.fn(async () => ({
        supported: true,
        width: 9504,
        height: 6336,
      })),
      readRawWindow: vi.fn(),
      readProcessedWindow: vi.fn(),
      beginProcessedWindowExport: vi.fn(async () => undefined),
      endProcessedWindowExport: vi.fn(async () => undefined),
      dispose: vi.fn(),
    }
    const runtime = {
      init: vi.fn(async () => undefined),
      openSession: vi.fn(async () => session),
      dispose: vi.fn(),
    }
    vi.mocked(createLumaRawRuntime).mockReturnValue(runtime as never)
    vi.mocked(runFullResolutionJpegExport).mockResolvedValue(
      createBlobOutputResult({
        filename: 'sony.jpg',
        blob: makeJfifOnlyJpeg(),
      }),
    )

    self.onmessage?.({
      data: {
        kind: 'start',
        requestId: 'request-with-metadata',
        file: new File(['raw'], 'sony.ARW'),
        graph: {
          supported: true,
          outputGamut: 'srgb-rec709',
          outputTransfer: 'srgb',
          lutProfile: null,
          steps: [{ kind: 'input-linear-prophoto' }, { kind: 'output-srgb' }],
        },
        collectMetrics: false,
      },
    } as MessageEvent)

    const response = await terminalResponse
    expect(response.kind).toBe('success')
    if (response.kind !== 'success') {
      throw new Error('Expected a successful export response.')
    }

    if (response.result.kind !== 'blob') {
      throw new Error('Expected metadata test to return a blob result.')
    }
    const bytes = await readBlobBytes(
      await materializeOutputBlob(response.result),
    )
    expect(bytesIncludeAscii(bytes, 'Exif\0\0')).toBe(true)
    expect(bytesIncludeAscii(bytes, 'Sony')).toBe(true)
    expect(bytesIncludeAscii(bytes, 'ILCE-7RM5')).toBe(true)
    expect(bytesIncludeAscii(bytes, 'FE 50mm F1.4 GM')).toBe(true)
  })

  it('posts one error and no success when end fails after a successful export', async () => {
    const terminalResponse = new Promise<FullResExportWorkerResponse>(
      (resolve) => {
        vi.spyOn(self, 'postMessage').mockImplementation((message) => {
          const response = message as FullResExportWorkerResponse
          if (response.kind === 'success' || response.kind === 'error') {
            resolve(response)
          }
        })
      },
    )
    const session = {
      probeExportCapability: vi.fn(async () => ({
        supported: true,
        width: 1,
        height: 1,
      })),
      readRawWindow: vi.fn(),
      readProcessedWindow: vi.fn(),
      beginProcessedWindowExport: vi.fn(async () => undefined),
      endProcessedWindowExport: vi.fn(async () => {
        throw new Error('END_FAILED')
      }),
      dispose: vi.fn(),
    }
    const runtime = {
      init: vi.fn(async () => undefined),
      openSession: vi.fn(async () => session),
      dispose: vi.fn(),
    }
    vi.mocked(createLumaRawRuntime).mockReturnValue(runtime as never)
    vi.mocked(runFullResolutionJpegExport).mockResolvedValue(
      createBlobOutputResult({
        filename: 'sample.jpg',
        blob: new Blob(['jpeg'], { type: 'image/jpeg' }),
      }),
    )

    self.onmessage?.({
      data: {
        kind: 'start',
        requestId: 'request-1',
        file: new File(['raw'], 'sample.RAF'),
        graph: {
          supported: true,
          outputGamut: 'srgb-rec709',
          outputTransfer: 'srgb',
          lutProfile: null,
          steps: [{ kind: 'input-linear-prophoto' }, { kind: 'output-srgb' }],
        },
        collectMetrics: false,
      },
    } as MessageEvent)

    await expect(terminalResponse).resolves.toEqual({
      kind: 'error',
      requestId: 'request-1',
      message: 'END_FAILED',
    })
    expect(self.postMessage).toHaveBeenCalledTimes(1)
    expect(session.dispose).toHaveBeenCalledTimes(1)
    expect(runtime.dispose).toHaveBeenCalledTimes(1)
  })
})

describe('full-resolution export worker delivered JPEG metadata', () => {
  const SENSOR = { width: 96, height: 64 } as const
  const JPEG_SOI = [255, 216] as const
  const JPEG_EOI = [255, 217] as const
  const JFIF_APP0 = [
    255, 224, 0, 16, 74, 70, 73, 70, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0,
  ] as const
  const MARKER_APP0 = 224
  const MARKER_APP1 = 225
  const MARKER_SOF0 = 192
  const MARKER_SOS = 218
  const MARKER_EOI = 217
  const TAG_EXIF_IFD_POINTER = 34_665
  const TAG_PIXEL_X_DIMENSION = 40_962
  const TAG_PIXEL_Y_DIMENSION = 40_963
  const TIFF_TYPE_SHORT = 3
  // Make, Model, Orientation, Software, DateTime and the Exif IFD pointer.
  const IFD0_TAGS = [271, 272, 274, 305, 306, 34_665]
  // ExposureTime, FNumber, ISO, ExifVersion, DateTimeOriginal,
  // DateTimeDigitized, FocalLength, ColorSpace, PixelX/YDimension, LensModel.
  const EXIF_IFD_TAGS = [
    33_434, 33_437, 34_855, 36_864, 36_867, 36_868, 37_386, 40_961, 40_962,
    40_963, 42_036,
  ]
  const probe = {
    make: 'Sony',
    model: 'ILCE-7RM5',
    lens: 'FE 50mm F1.4 GM',
    iso: 125,
    aperture: 1.4,
    focalLength: 50,
    shutter: 0.005,
    timestamp: 1_704_067_200,
    width: SENSOR.width,
    height: SENSOR.height,
    supportLevel: 'full',
    timings: { total: 1 },
  }
  const graph = resolveExportColorGraph({
    styleKind: 'none',
    intensity: 1,
    builtinPreset: null,
    lut: null,
  })

  /** Source-normalized to output-normalized turn about the frame centre. */
  function turnAboutCentre(radians: number) {
    const cos = Math.cos(radians)
    const sin = Math.sin(radians)
    return [
      cos,
      -sin,
      0.5 - 0.5 * cos + 0.5 * sin,
      sin,
      cos,
      0.5 - 0.5 * sin - 0.5 * cos,
      0,
      0,
      1,
    ]
  }

  // Delivered sizes are worked out by hand rather than asked of the planner,
  // so the expectation does not share code with what it checks.
  const cases = [
    { name: 'no geometry', geometry: undefined, delivered: SENSOR },
    {
      name: 'neutral geometry',
      geometry: { matrix: [1, 0, 0, 0, 1, 0, 0, 0, 1], constrainCrop: true },
      delivered: SENSOR,
    },
    {
      // Zooming out by two leaves source behind only the centred half.
      name: 'a cropped zoom-out',
      geometry: {
        matrix: [0.5, 0, 0.25, 0, 0.5, 0.25, 0, 0, 1],
        constrainCrop: true,
      },
      delivered: { width: 48, height: 32 },
    },
    {
      // A turn of t about the centre keeps 1 / (cos t + sin t) of each side:
      // 0.848 of 96 x 64.
      name: 'a cropped rotation',
      geometry: { matrix: turnAboutCentre(0.2), constrainCrop: true },
      delivered: { width: 81, height: 54 },
    },
  ]
  const transformedCases = cases.filter(
    ({ delivered }) =>
      delivered.width !== SENSOR.width || delivered.height !== SENSOR.height,
  )

  function makeBaselineJpeg(width: number, height: number) {
    return new Uint8Array([
      ...JPEG_SOI,
      ...JFIF_APP0,
      // SOF0: 8-bit precision, height, width, three components.
      255,
      MARKER_SOF0,
      0,
      17,
      8,
      height >> 8,
      height & 255,
      width >> 8,
      width & 255,
      3,
      1,
      17,
      0,
      2,
      17,
      0,
      3,
      17,
      0,
      ...JPEG_EOI,
    ])
  }

  function readJpegSegments(bytes: Uint8Array) {
    const segments: Array<{ marker: number; offset: number; length: number }> =
      []
    let offset = 2
    while (offset + 4 <= bytes.length && bytes[offset] === 255) {
      const marker = bytes[offset + 1]!
      if (marker === MARKER_SOS || marker === MARKER_EOI) break
      const length = (bytes[offset + 2]! << 8) | bytes[offset + 3]!
      segments.push({ marker, offset, length })
      offset += 2 + length
    }
    return segments
  }

  function readSofDimensions(bytes: Uint8Array) {
    const sof = readJpegSegments(bytes).find(
      ({ marker }) => marker === MARKER_SOF0,
    )
    if (!sof) throw new Error('Expected a baseline SOF segment.')
    return {
      width: (bytes[sof.offset + 7]! << 8) | bytes[sof.offset + 8]!,
      height: (bytes[sof.offset + 5]! << 8) | bytes[sof.offset + 6]!,
    }
  }

  function exifSegments(bytes: Uint8Array) {
    return readJpegSegments(bytes).filter(
      ({ marker, offset }) =>
        marker === MARKER_APP1 &&
        String.fromCharCode(...bytes.subarray(offset + 4, offset + 10)) ===
          'Exif\0\0',
    )
  }

  /** Tag to inline value (or value offset) for one IFD. */
  function readIfd(view: DataView, ifdOffset: number, littleEndian: boolean) {
    const entries = new Map<number, number>()
    const entryCount = view.getUint16(ifdOffset, littleEndian)
    for (let index = 0; index < entryCount; index += 1) {
      const entry = ifdOffset + 2 + index * 12
      entries.set(
        view.getUint16(entry, littleEndian),
        view.getUint16(entry + 2, littleEndian) === TIFF_TYPE_SHORT
          ? view.getUint16(entry + 8, littleEndian)
          : view.getUint32(entry + 8, littleEndian),
      )
    }
    return entries
  }

  function readExif(bytes: Uint8Array) {
    const segments = exifSegments(bytes)
    expect(segments).toHaveLength(1)
    const segment = segments[0]!
    const tiff = new DataView(
      bytes.buffer,
      bytes.byteOffset + segment.offset + 10,
      segment.length - 8,
    )
    const littleEndian = tiff.getUint16(0) === 0x4949
    const ifd0 = readIfd(tiff, tiff.getUint32(4, littleEndian), littleEndian)
    const exifIfdOffset = ifd0.get(TAG_EXIF_IFD_POINTER)
    if (exifIfdOffset === undefined) throw new Error('Expected an Exif IFD.')
    const exifIfd = readIfd(tiff, exifIfdOffset, littleEndian)
    return {
      ifd0Tags: [...ifd0.keys()],
      exifIfdTags: [...exifIfd.keys()],
      pixelDimensions: {
        width: exifIfd.get(TAG_PIXEL_X_DIMENSION),
        height: exifIfd.get(TAG_PIXEL_Y_DIMENSION),
      },
    }
  }

  function withoutExif(bytes: Uint8Array) {
    const [segment] = exifSegments(bytes)
    if (!segment) return bytes
    return new Uint8Array([
      ...bytes.subarray(0, segment.offset),
      ...bytes.subarray(segment.offset + 2 + segment.length),
    ])
  }

  function sha256Hex(bytes: Uint8Array) {
    return createHash('sha256').update(bytes).digest('hex')
  }

  function installSession() {
    const capability = {
      supported: true,
      strategy: 'libraw-processed-window',
      width: SENSOR.width,
      height: SENSOR.height,
      windows: { librawProcessed: true, rawMosaic: false },
      color: {
        workingSpace: 'linear-prophoto-rgb',
        librawOutputColor: 'prophoto',
        gamma: 'linear',
        cameraWhiteBalanceAppliedByRuntime: true,
        cameraMatrixAppliedByRuntime: true,
      },
      reasons: [],
    }
    const session = {
      probe,
      probeExportCapability: vi.fn(async () => capability),
      readProcessedWindow: vi.fn(
        async (request: LumaRawProcessedWindowRequest) => {
          const { width, height } = request.outputRect
          return {
            rect: request.outputRect,
            workingSpace: 'linear-prophoto-rgb',
            data: new Uint16Array(width * height * 3).fill(16384),
            width,
            height,
            stride: width * 3,
            normalized: false,
            orientationApplied: true,
            colorApplied: true,
            warnings: [],
          }
        },
      ),
      beginProcessedWindowExport: vi.fn(async () => undefined),
      endProcessedWindowExport: vi.fn(async () => undefined),
      dispose: vi.fn(),
    }
    vi.mocked(createLumaRawRuntime).mockReturnValue({
      init: vi.fn(async () => undefined),
      openSession: vi.fn(async () => session),
      dispose: vi.fn(),
    } as never)
  }

  /** An encoder that emits a real JPEG header for whatever frame it is given. */
  function installBaselineJpegRuntime() {
    const encoded: Uint8Array[] = []
    vi.mocked(createLumaJpegRuntime).mockImplementation(
      (options) =>
        ({
          createEncoder({ width, height }: { width: number; height: number }) {
            return {
              writeRows: vi.fn(async () => undefined),
              async finish() {
                const bytes = makeBaselineJpeg(width, height)
                encoded.push(bytes)
                if (options?.onChunk) {
                  await options.onChunk({ bytes } as never)
                  return undefined
                }
                return new Blob([bytes], { type: 'image/jpeg' })
              },
              abort: vi.fn(),
            }
          },
          dispose: vi.fn(),
        }) as never,
    )
    return encoded
  }

  function installCapturingOpfsWritable() {
    const chunks: Uint8Array[] = []
    const written = () => new Uint8Array(chunks.flatMap((chunk) => [...chunk]))
    vi.mocked(createOpfsOutputWritable).mockResolvedValueOnce({
      write: vi.fn(async (chunk: ArrayBuffer) => {
        chunks.push(new Uint8Array(chunk))
      }),
      close: vi.fn(
        async (options?: { hash?: (bytes: Uint8Array) => string }) => {
          const bytes = written()
          return {
            byteLength: bytes.length,
            sha256: options?.hash?.(bytes) ?? '',
          }
        },
      ),
      abort: vi.fn(async () => undefined),
    } as never)
    return written
  }

  async function startExport(fields: Record<string, unknown>) {
    const terminal = new Promise<FullResExportWorkerResponse>((resolve) => {
      vi.spyOn(self, 'postMessage').mockImplementation((message) => {
        const response = message as FullResExportWorkerResponse
        if (response.kind === 'success' || response.kind === 'error') {
          resolve(response)
        }
      })
    })

    self.onmessage?.({
      data: {
        kind: 'start',
        requestId: 'request-delivered-metadata',
        file: new File(['raw'], 'sony.ARW'),
        filename: 'sony.jpg',
        graph,
        collectMetrics: false,
        ...fields,
      },
    } as MessageEvent)

    const response = await terminal
    if (response.kind !== 'success') {
      throw new Error(
        `Expected a successful export, got ${JSON.stringify(response)}.`,
      )
    }
    return response.result
  }

  beforeEach(async () => {
    // The real engine plans the frame, so the encoder sees the size the
    // geometry actually delivers.
    const actual = await vi.importActual<
      typeof import('@lumaforge/render-engine/export')
    >('@lumaforge/render-engine/export')
    vi.mocked(runFullResolutionJpegExport).mockReset()
    vi.mocked(runFullResolutionJpegExport).mockImplementation(
      actual.runFullResolutionJpegExport,
    )
    installSession()
  })

  afterEach(() => {
    vi.mocked(runFullResolutionJpegExport).mockReset()
    vi.mocked(createLumaJpegRuntime).mockReset()
  })

  it.each(cases)(
    'describes the encoded frame in blob EXIF under $name',
    async ({ geometry, delivered }) => {
      const encoded = installBaselineJpegRuntime()

      const result = await startExport(geometry ? { geometry } : {})

      if (result.kind !== 'blob') throw new Error('Expected a blob result.')
      const bytes = await readBlobBytes(await materializeOutputBlob(result))
      expect(encoded).toHaveLength(1)
      expect(readSofDimensions(bytes)).toEqual(delivered)
      const exif = readExif(bytes)
      expect(exif.pixelDimensions).toEqual(readSofDimensions(bytes))
      // Geometry changes the dimension values only, never which tags exist.
      expect(exif.ifd0Tags).toEqual(IFD0_TAGS)
      expect(exif.exifIfdTags).toEqual(EXIF_IFD_TAGS)
      // EXIF lands straight after APP0 and is the only change to the encoder's
      // bytes, and the reported hash identifies what is delivered.
      expect(readJpegSegments(bytes).map(({ marker }) => marker)).toEqual([
        MARKER_APP0,
        MARKER_APP1,
        MARKER_SOF0,
      ])
      expect(withoutExif(bytes)).toEqual(encoded[0])
      expect(result.sha256).toBe(sha256Hex(bytes))
    },
  )

  it.each(transformedCases)(
    'hashes file-backed output as delivered at the encoded frame under $name',
    async ({ geometry, delivered }) => {
      installBaselineJpegRuntime()
      const written = installCapturingOpfsWritable()

      const result = await startExport({
        geometry,
        executionPlan: {
          profileName: 'ios-safe',
          preferredRows: 64,
          concurrency: 1,
          runtimeMemoryProfile: 'low-memory',
          outputSink: 'opfs-file',
          checkpointMode: 'safe-retry',
        },
        outputLocation: { sink: 'opfs-file', exportId: 'export-delivered' },
      })

      if (result.kind !== 'file-backed') {
        throw new Error('Expected a file-backed result.')
      }
      // File-backed output stays metadata-free on disk; delivery injects the
      // recorded metadata at the frame the file holds.
      const onDisk = written()
      expect(exifSegments(onDisk)).toHaveLength(0)
      expect(readSofDimensions(onDisk)).toEqual(delivered)
      expect(result.deliveryMetadata).toEqual({
        make: probe.make,
        model: probe.model,
        lens: probe.lens,
        iso: probe.iso,
        aperture: probe.aperture,
        focalLength: probe.focalLength,
        shutter: probe.shutter,
        timestamp: probe.timestamp,
      })
      const deliveredBytes = await readBlobBytes(
        await preserveJpegMetadata({
          jpeg: new Blob([onDisk], { type: 'image/jpeg' }),
          metadata: result.deliveryMetadata,
          width: delivered.width,
          height: delivered.height,
        }),
      )
      expect(readExif(deliveredBytes).pixelDimensions).toEqual(delivered)
      expect(result.sha256).toBe(sha256Hex(deliveredBytes))
    },
  )
})

describe('full-resolution export worker output sink', () => {
  const graph = {
    supported: true,
    outputGamut: 'srgb-rec709',
    outputTransfer: 'srgb',
    lutProfile: null,
    steps: [{ kind: 'input-linear-prophoto' }, { kind: 'output-srgb' }],
  }
  const opfsPlan = {
    profileName: 'ios-safe',
    preferredRows: 64,
    concurrency: 1,
    runtimeMemoryProfile: 'low-memory',
    outputSink: 'opfs-file',
    checkpointMode: 'safe-retry',
  }
  const blobPlan = {
    profileName: 'desktop-fast',
    preferredRows: 512,
    concurrency: 2,
    runtimeMemoryProfile: 'desktop',
    outputSink: 'blob-handoff',
    checkpointMode: 'safe-retry',
  }
  const checkpoint = {
    exportId: 'export-1',
    graphFingerprint: 'graph-1',
    sourceFingerprint: {
      name: 'sample.RAF',
      size: 3,
      lastModified: 0,
      hashPrefixHex: 'abc',
    },
  }

  beforeEach(() => {
    // Any export that reaches the encoder succeeds, so a sink the worker
    // should have refused shows up as a success.
    vi.mocked(runFullResolutionJpegExport).mockReset()
    vi.mocked(runFullResolutionJpegExport).mockImplementation(async () =>
      createBlobOutputResult({
        filename: 'sample.jpg',
        blob: makeJfifOnlyJpeg(),
      }),
    )
  })

  function installRawRuntime() {
    const session = {
      probe: {
        width: 4,
        height: 4,
        supportLevel: 'full',
        timings: { total: 1 },
      },
      probeExportCapability: vi.fn(async () => ({
        supported: true,
        width: 4,
        height: 4,
      })),
      readProcessedWindow: vi.fn(),
      beginProcessedWindowExport: vi.fn(async () => undefined),
      endProcessedWindowExport: vi.fn(async () => undefined),
      dispose: vi.fn(),
    }
    const runtime = {
      init: vi.fn(async () => undefined),
      openSession: vi.fn(async () => session),
      dispose: vi.fn(),
    }
    vi.mocked(createLumaRawRuntime).mockReturnValue(runtime as never)
    return { session, runtime }
  }

  function installJpegRuntime() {
    const encoder = {
      writeRows: vi.fn(async () => undefined),
      finish: vi.fn(async () => undefined),
      abort: vi.fn(),
    }
    vi.mocked(createLumaJpegRuntime).mockReturnValue({
      createEncoder: vi.fn(() => encoder),
      dispose: vi.fn(),
    } as never)
    return encoder
  }

  function startExport(fields: Record<string, unknown>) {
    const terminal = new Promise<FullResExportWorkerResponse>((resolve) => {
      vi.spyOn(self, 'postMessage').mockImplementation((message) => {
        const response = message as FullResExportWorkerResponse
        if (response.kind === 'success' || response.kind === 'error') {
          resolve(response)
        }
      })
    })

    self.onmessage?.({
      data: {
        kind: 'start',
        requestId: 'request-sink',
        file: new File(['raw'], 'sample.RAF'),
        filename: 'sample.jpg',
        graph,
        collectMetrics: false,
        ...fields,
      },
    } as MessageEvent)

    return terminal
  }

  it('writes an opfs-file plan to its OPFS location even when no recovery checkpoint was journaled', async () => {
    installRawRuntime()
    installJpegRuntime()
    const writable = createFakeOpfsWritable()
    vi.mocked(createOpfsOutputWritable).mockResolvedValueOnce(writable as never)
    vi.mocked(runFullResolutionJpegExport).mockImplementation(async (input) => {
      if (!input.jpegSink) throw new Error('Expected an OPFS JPEG sink.')
      const session = input.jpegSink.createSession({
        width: 4,
        height: 4,
        quality: 0.92,
      })
      return session.close()
    })

    const response = await startExport({
      executionPlan: opfsPlan,
      outputLocation: { sink: 'opfs-file', exportId: 'export-7' },
    })

    expect(createOpfsOutputWritable).toHaveBeenCalledTimes(1)
    expect(createOpfsOutputWritable).toHaveBeenCalledWith({
      exportId: 'export-7',
      outputFileName: 'output.jpg',
    })
    expect(writable.close).toHaveBeenCalledTimes(1)
    expect(writable.abort).not.toHaveBeenCalled()
    expect(runFullResolutionJpegExport).toHaveBeenCalledWith(
      expect.objectContaining({
        jpegSink: expect.any(Object),
        onCheckpoint: undefined,
      }),
    )
    expect(response).toMatchObject({
      kind: 'success',
      result: {
        kind: 'file-backed',
        storage: 'opfs',
        exportId: 'export-7',
        filename: 'sample.jpg',
        sha256: 'f'.repeat(64),
      },
    })
  })

  it('refuses an opfs-file plan that carries only a recovery checkpoint', async () => {
    const { runtime } = installRawRuntime()

    const response = await startExport({
      executionPlan: opfsPlan,
      checkpoint,
    })

    expect(response).toEqual({
      kind: 'error',
      requestId: 'request-sink',
      message: 'FULL_RES_EXPORT_OUTPUT_LOCATION_INVALID',
    })
    expect(runtime.init).not.toHaveBeenCalled()
    expect(createOpfsOutputWritable).not.toHaveBeenCalled()
    expect(runFullResolutionJpegExport).not.toHaveBeenCalled()
  })

  it.each([
    {
      name: 'an empty export id',
      location: { sink: 'opfs-file', exportId: '' },
    },
    { name: 'a missing export id', location: { sink: 'opfs-file' } },
    {
      name: 'a parent-directory export id',
      location: { sink: 'opfs-file', exportId: '..' },
    },
    {
      name: 'a nested export id',
      location: { sink: 'opfs-file', exportId: 'export-1/output' },
    },
    {
      name: 'another sink',
      location: { sink: 'blob-handoff', exportId: 'export-1' },
    },
    { name: 'a bare string', location: 'export-1' },
  ])(
    'refuses an opfs-file plan whose output location has $name',
    async ({ location }) => {
      installRawRuntime()

      const response = await startExport({
        executionPlan: opfsPlan,
        outputLocation: location,
        checkpoint,
      })

      expect(response).toMatchObject({
        kind: 'error',
        message: 'FULL_RES_EXPORT_OUTPUT_LOCATION_INVALID',
      })
      expect(createOpfsOutputWritable).not.toHaveBeenCalled()
      expect(runFullResolutionJpegExport).not.toHaveBeenCalled()
    },
  )

  it.each([
    { name: 'a blob-handoff plan', executionPlan: blobPlan },
    { name: 'no execution plan', executionPlan: undefined },
  ])('refuses an OPFS location for $name', async ({ executionPlan }) => {
    installRawRuntime()

    const response = await startExport({
      executionPlan,
      outputLocation: { sink: 'opfs-file', exportId: 'export-1' },
    })

    expect(response).toMatchObject({
      kind: 'error',
      message: 'FULL_RES_EXPORT_OUTPUT_LOCATION_INVALID',
    })
    expect(createOpfsOutputWritable).not.toHaveBeenCalled()
    expect(runFullResolutionJpegExport).not.toHaveBeenCalled()
  })

  it('reports an OPFS output that cannot open instead of encoding in memory', async () => {
    const { runtime } = installRawRuntime()
    vi.mocked(createOpfsOutputWritable).mockRejectedValueOnce(
      new DOMException('Access denied', 'NotAllowedError'),
    )

    const response = await startExport({
      executionPlan: opfsPlan,
      outputLocation: { sink: 'opfs-file', exportId: 'export-1' },
      checkpoint,
    })

    expect(response).toEqual({
      kind: 'error',
      requestId: 'request-sink',
      message: 'FULL_RES_EXPORT_OPFS_OUTPUT_UNAVAILABLE',
    })
    expect(runtime.init).not.toHaveBeenCalled()
    expect(runFullResolutionJpegExport).not.toHaveBeenCalled()
  })

  it('discards an opened OPFS output that the export never wrote to', async () => {
    installRawRuntime()
    const writable = createFakeOpfsWritable()
    vi.mocked(createOpfsOutputWritable).mockResolvedValueOnce(writable as never)
    vi.mocked(runFullResolutionJpegExport).mockRejectedValue(
      new Error('FULL_RES_EXPORT_UNSUPPORTED_SOURCE'),
    )

    const response = await startExport({
      executionPlan: opfsPlan,
      outputLocation: { sink: 'opfs-file', exportId: 'export-1' },
    })

    expect(response).toMatchObject({
      kind: 'error',
      message: 'FULL_RES_EXPORT_UNSUPPORTED_SOURCE',
    })
    expect(writable.abort).toHaveBeenCalledTimes(1)
  })

  it('refuses a streaming plan because no streaming sink is wired', async () => {
    installRawRuntime()

    const response = await startExport({
      executionPlan: { ...blobPlan, outputSink: 'streaming' },
    })

    expect(response).toMatchObject({
      kind: 'error',
      message: 'FULL_RES_EXPORT_OUTPUT_SINK_UNAVAILABLE',
    })
    expect(runFullResolutionJpegExport).not.toHaveBeenCalled()
  })

  it('encodes a blob-handoff plan in memory while still reporting checkpoint metrics', async () => {
    installRawRuntime()
    vi.mocked(runFullResolutionJpegExport).mockResolvedValue(
      createBlobOutputResult({
        filename: 'sample.jpg',
        blob: makeJfifOnlyJpeg(),
      }),
    )

    const response = await startExport({
      executionPlan: blobPlan,
      checkpoint,
    })

    expect(response).toMatchObject({
      kind: 'success',
      result: { kind: 'blob' },
    })
    expect(createOpfsOutputWritable).not.toHaveBeenCalled()
    expect(runFullResolutionJpegExport).toHaveBeenCalledWith(
      expect.objectContaining({
        jpegSink: undefined,
        onCheckpoint: expect.any(Function),
      }),
    )
  })
})
