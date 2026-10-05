import { createLumaJpegRuntime } from '@lumaforge/luma-jpeg-runtime'
import { createLumaRawRuntime } from '@lumaforge/luma-raw-runtime'
import { runFullResolutionJpegExport } from '@lumaforge/render-engine/export'
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
