// Loading the worker module installs its `self.onmessage` handler.
import './full-res-export.worker'

import { createHash } from 'node:crypto'

import {
  NEUTRAL_SELECTIVE_COLOR,
  resolveExportColorGraph,
} from '@lumaforge/luma-color-runtime'
import { createLumaJpegRuntime } from '@lumaforge/luma-jpeg-runtime'
import type { LumaRawProcessedWindowRequest } from '@lumaforge/luma-raw-runtime'
import { createLumaRawRuntime } from '@lumaforge/luma-raw-runtime'
import {
  createBlobOutputResult,
  materializeOutputBlob,
  preserveJpegMetadata,
  runFullResolutionJpegExport,
} from '@lumaforge/render-engine/export'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type {
  FullResExportWorkerResponse,
  FullResExportWorkerStartMessage,
} from './full-res-export-client'
import { createMemoryFileBackedOutputResult } from './output-result.fixture'
import { createOpfsOutputWritable } from './output-sink'

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

const GRAPH: FullResExportWorkerStartMessage['graph'] = {
  supported: true,
  outputGamut: 'srgb-rec709',
  outputTransfer: 'srgb',
  lutProfile: null,
  steps: [{ kind: 'input-linear-prophoto' }, { kind: 'output-srgb' }],
}
const OPFS_PLAN: FullResExportWorkerStartMessage['executionPlan'] = {
  preferredRows: 64,
  concurrency: 1,
  runtimeMemoryProfile: 'low-memory',
  outputSink: 'opfs-file',
}
const BLOB_PLAN: FullResExportWorkerStartMessage['executionPlan'] = {
  preferredRows: 512,
  concurrency: 2,
  runtimeMemoryProfile: 'desktop',
  outputSink: 'blob-handoff',
}
const OPFS_LOCATION = {
  sink: 'opfs-file',
  tabDirectory: 'tab-1',
  exportId: 'export-1',
} as const

function installRawRuntime({
  probe = { width: 4, height: 4 },
  capability = { supported: true, width: 4, height: 4 },
  readProcessedWindow = vi.fn(),
  order,
}: {
  probe?: unknown
  capability?: unknown
  readProcessedWindow?: unknown
  order?: string[]
} = {}) {
  const session = {
    probe,
    probeExportCapability: vi.fn(async () => capability),
    readProcessedWindow,
    dispose: vi.fn(() => order?.push('session.dispose')),
  }
  const runtime = {
    init: vi.fn(async () => undefined),
    openSession: vi.fn(async () => session),
    dispose: vi.fn(() => order?.push('runtime.dispose')),
  }
  vi.mocked(createLumaRawRuntime).mockReturnValue(runtime as never)
  return { session, runtime }
}

/** Starts one export on the worker and settles with its last response. */
function startExport(fields: Record<string, unknown> = {}, order?: string[]) {
  const terminal = new Promise<FullResExportWorkerResponse>((resolve) => {
    vi.spyOn(self, 'postMessage').mockImplementation((message) => {
      const response = message as FullResExportWorkerResponse
      if (response.kind === 'progress') return
      order?.push(response.kind)
      resolve(response)
    })
  })

  self.onmessage?.({
    data: {
      kind: 'start',
      file: new File(['raw'], 'sample.RAF'),
      filename: 'sample.jpg',
      graph: GRAPH,
      executionPlan: BLOB_PLAN,
      quality: 0.92,
      ...fields,
    },
  } as MessageEvent)

  return terminal
}

describe('full-resolution export worker lifecycle responses', () => {
  it.each([
    { plan: OPFS_PLAN, location: OPFS_LOCATION, coi: false },
    { plan: BLOB_PLAN, location: undefined, coi: true },
  ])(
    'runs a $plan.runtimeMemoryProfile runtime with the plan and hands a resource failure back',
    async ({ plan, location, coi }) => {
      installRawRuntime()

      await expect(
        startExport({ executionPlan: plan, outputLocation: location }),
      ).resolves.toMatchObject({ kind: 'success' })

      expect(createLumaRawRuntime).toHaveBeenCalledWith({
        memoryProfile: plan.runtimeMemoryProfile,
        requireCrossOriginIsolation: coi,
      })
      expect(runFullResolutionJpegExport).toHaveBeenCalledWith(
        expect.objectContaining({
          preferredRows: plan.preferredRows,
          concurrency: plan.concurrency,
          quality: 0.92,
          retryPolicy: 'surface-resource-failure',
        }),
      )
    },
  )

  it('posts a file-backed result unread, after releasing the RAW session and runtime', async () => {
    const order: string[] = []
    const { session, runtime } = installRawRuntime({ order })
    const output = createMemoryFileBackedOutputResult({
      exportId: 'export-1',
      filename: 'safe-output.jpg',
      mimeType: 'image/jpeg',
      bytes: new Uint8Array([1, 2, 3]),
    })
    const openBlob = vi.spyOn(output, 'openBlob')
    vi.mocked(runFullResolutionJpegExport).mockResolvedValue(output)

    const response = await startExport(
      {
        filename: 'safe-output.jpg',
        executionPlan: OPFS_PLAN,
        outputLocation: OPFS_LOCATION,
      },
      order,
    )

    expect(openBlob).not.toHaveBeenCalled()
    expect(response).toEqual({
      kind: 'success',
      result: {
        kind: 'file-backed',
        storage: 'opfs',
        tabDirectory: 'tab-1',
        exportId: 'export-1',
        filename: 'safe-output.jpg',
        byteLength: 3,
        mimeType: 'image/jpeg',
        deliveryMetadata: null,
      },
    })
    expect(order).toEqual(['session.dispose', 'runtime.dispose', 'success'])
    expect(session.dispose).toHaveBeenCalledTimes(1)
    expect(runtime.dispose).toHaveBeenCalledTimes(1)
  })

  it('includes next row hints when a resource failure ends the attempt', async () => {
    installRawRuntime()
    vi.mocked(runFullResolutionJpegExport).mockRejectedValue(
      Object.assign(new Error('FULL_RES_EXPORT_RESOURCE_FAILURE'), {
        nextRows: 96,
      }),
    )

    await expect(startExport()).resolves.toEqual({
      kind: 'error',
      message: 'FULL_RES_EXPORT_RESOURCE_FAILURE',
      nextRows: 96,
    })
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
    selectiveColor: NEUTRAL_SELECTIVE_COLOR,
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
    installRawRuntime({
      probe,
      capability: {
        supported: true,
        strategy: 'libraw-processed-window',
        width: SENSOR.width,
        height: SENSOR.height,
        windows: { librawProcessed: true },
        color: {
          workingSpace: 'linear-prophoto-rgb',
          librawOutputColor: 'prophoto',
          gamma: 'linear',
          cameraWhiteBalanceAppliedByRuntime: true,
          cameraMatrixAppliedByRuntime: true,
        },
        reasons: [],
      },
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
    })
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

  async function exportResult(fields: Record<string, unknown>) {
    const response = await startExport({
      file: new File(['raw'], 'sony.ARW'),
      filename: 'sony.jpg',
      graph,
      ...fields,
    })
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

      const result = await exportResult(geometry ? { geometry } : {})

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

      const result = await exportResult({
        geometry,
        executionPlan: OPFS_PLAN,
        outputLocation: { ...OPFS_LOCATION, exportId: 'export-delivered' },
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

  it('writes an opfs-file plan to its OPFS location', async () => {
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
      executionPlan: OPFS_PLAN,
      outputLocation: { ...OPFS_LOCATION, exportId: 'export-7' },
    })

    expect(createOpfsOutputWritable).toHaveBeenCalledTimes(1)
    expect(createOpfsOutputWritable).toHaveBeenCalledWith({
      tabDirectory: 'tab-1',
      exportId: 'export-7',
      outputFileName: 'output.jpg',
    })
    expect(writable.close).toHaveBeenCalledTimes(1)
    expect(writable.abort).not.toHaveBeenCalled()
    expect(runFullResolutionJpegExport).toHaveBeenCalledWith(
      expect.objectContaining({
        jpegSink: expect.any(Object),
      }),
    )
    expect(response).toMatchObject({
      kind: 'success',
      result: {
        kind: 'file-backed',
        storage: 'opfs',
        tabDirectory: 'tab-1',
        exportId: 'export-7',
        filename: 'sample.jpg',
        sha256: 'f'.repeat(64),
      },
    })
  })

  it('refuses an opfs-file plan that carries no output location', async () => {
    const { runtime } = installRawRuntime()

    const response = await startExport({ executionPlan: OPFS_PLAN })

    expect(response).toEqual({
      kind: 'error',
      message: 'FULL_RES_EXPORT_OUTPUT_LOCATION_INVALID',
    })
    expect(runtime.init).not.toHaveBeenCalled()
    expect(createOpfsOutputWritable).not.toHaveBeenCalled()
    expect(runFullResolutionJpegExport).not.toHaveBeenCalled()
  })

  it.each([
    {
      name: 'an empty export id',
      location: { sink: 'opfs-file', tabDirectory: 'tab-1', exportId: '' },
    },
    {
      name: 'a missing export id',
      location: { sink: 'opfs-file', tabDirectory: 'tab-1' },
    },
    {
      name: 'a parent-directory export id',
      location: { sink: 'opfs-file', tabDirectory: 'tab-1', exportId: '..' },
    },
    {
      name: 'a nested export id',
      location: {
        sink: 'opfs-file',
        tabDirectory: 'tab-1',
        exportId: 'export-1/output',
      },
    },
    {
      name: 'a missing tab directory',
      location: { sink: 'opfs-file', exportId: 'export-1' },
    },
    {
      name: 'an empty tab directory',
      location: { sink: 'opfs-file', tabDirectory: '', exportId: 'export-1' },
    },
    {
      name: 'a parent-directory tab directory',
      location: { sink: 'opfs-file', tabDirectory: '..', exportId: 'export-1' },
    },
    {
      name: 'a nested tab directory',
      location: {
        sink: 'opfs-file',
        tabDirectory: 'tab-1/export-0',
        exportId: 'export-1',
      },
    },
    {
      name: 'another sink',
      location: {
        sink: 'blob-handoff',
        tabDirectory: 'tab-1',
        exportId: 'export-1',
      },
    },
    { name: 'a bare string', location: 'export-1' },
  ])(
    'refuses an opfs-file plan whose output location has $name',
    async ({ location }) => {
      installRawRuntime()

      const response = await startExport({
        executionPlan: OPFS_PLAN,
        outputLocation: location,
      })

      expect(response).toMatchObject({
        kind: 'error',
        message: 'FULL_RES_EXPORT_OUTPUT_LOCATION_INVALID',
      })
      expect(createOpfsOutputWritable).not.toHaveBeenCalled()
      expect(runFullResolutionJpegExport).not.toHaveBeenCalled()
    },
  )

  it('refuses an OPFS location for a blob-handoff plan', async () => {
    installRawRuntime()

    const response = await startExport({
      executionPlan: BLOB_PLAN,
      outputLocation: OPFS_LOCATION,
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
      executionPlan: OPFS_PLAN,
      outputLocation: OPFS_LOCATION,
    })

    expect(response).toEqual({
      kind: 'error',
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
      executionPlan: OPFS_PLAN,
      outputLocation: OPFS_LOCATION,
    })

    expect(response).toMatchObject({
      kind: 'error',
      message: 'FULL_RES_EXPORT_UNSUPPORTED_SOURCE',
    })
    expect(writable.abort).toHaveBeenCalledTimes(1)
  })

  it('refuses a file-backed result for a plan that reserved no OPFS location', async () => {
    installRawRuntime()
    vi.mocked(runFullResolutionJpegExport).mockResolvedValue(
      createMemoryFileBackedOutputResult({
        exportId: 'export-1',
        filename: 'sample.jpg',
        mimeType: 'image/jpeg',
        bytes: new Uint8Array([1, 2, 3]),
      }),
    )

    const response = await startExport({ executionPlan: BLOB_PLAN })

    expect(response).toMatchObject({
      kind: 'error',
      message: 'FULL_RES_EXPORT_OUTPUT_LOCATION_INVALID',
    })
  })

  it('encodes a blob-handoff plan in memory', async () => {
    installRawRuntime()

    const response = await startExport({ executionPlan: BLOB_PLAN })

    expect(response).toMatchObject({
      kind: 'success',
      result: { kind: 'blob' },
    })
    expect(createOpfsOutputWritable).not.toHaveBeenCalled()
    expect(runFullResolutionJpegExport).toHaveBeenCalledWith(
      expect.objectContaining({
        jpegSink: undefined,
      }),
    )
  })
})
