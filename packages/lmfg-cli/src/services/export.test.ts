// @vitest-environment node
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'

import { createLumaJpegRuntimeForNode } from '@lumaforge/luma-jpeg-runtime/node'
import type {
  LumaRawExportCapability,
  LumaRawProcessedWindow,
  LumaRawProcessedWindowRequest,
} from '@lumaforge/luma-raw-runtime'
import type { ExportGeometry } from '@lumaforge/render-engine/export'
import { planExportGeometry } from '@lumaforge/render-engine/export'
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest'

import { LmfgError, toLmfgError } from '../protocol/errors'
import type { LmfgRuntime } from '../runtime/node-runtime'
import { createLmfgRuntime } from '../runtime/node-runtime'
import type { LoadedSource } from '../runtime/source-loader'
import { loadSourceFile } from '../runtime/source-loader'
import { parseRenderParams } from '../schemas/params'
import {
  describeWithFixture,
  FIXTURE_PATH,
} from '../test-support/describe-with-fixture'
import type { ExportRunInput } from './export'
import { runFullResolutionExport } from './export'

vi.mock('@lumaforge/luma-jpeg-runtime/node', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@lumaforge/luma-jpeg-runtime/node')>()
  return {
    ...actual,
    createLumaJpegRuntimeForNode: vi.fn(actual.createLumaJpegRuntimeForNode),
  }
})

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, rm: vi.fn(actual.rm) }
})

const actualRm = (
  await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
).rm

/** Makes every `rm` of a `.tmp` path fail like a locked file would. */
function failTempRemoval(): Error {
  const failure = Object.assign(
    new Error(`EACCES: permission denied, unlink '${dir}/exports/x.tmp'`),
    { code: 'EACCES', syscall: 'unlink' },
  )
  vi.mocked(rm).mockImplementation(async (path, options) => {
    if (String(path).endsWith('.tmp')) throw failure
    return actualRm(path, options)
  })
  return failure
}

const LOCKED_FIXTURE_SHA256 =
  '7a2a9747a0cb1537007233ce7e8b7233c5ee641d683b7b3da29e22387994a0d7'

// The APP1 segment the export injects for the locked fixture, byte for byte.
const EXPORT_APP1_HEX = [
  'ffe10185', // APP1 marker, segment length 389
  '457869660000', // "Exif\0\0"
  '49492a0008000000', // TIFF header: little-endian, 42, IFD0 at 8
  '0600', // IFD0: 6 entries
  '0f0102000600000056000000', // Make ASCII[6] at 86
  '10010200160000005c000000', // Model ASCII[22] at 92
  '120103000100000001000000', // Orientation SHORT = 1
  '310102000a00000072000000', // Software ASCII[10] at 114
  '32010200140000007c000000', // DateTime ASCII[20] at 124
  '698704000100000090000000', // ExifIFDPointer LONG = 144
  '00000000', // next IFD: none
  '4170706c6500', // Make 'Apple'
  '6950686f6e65382c34206261636b2063616d65726100', // Model 'iPhone8,4 back camera'
  '4c756d61466f72676500', // Software 'LumaForge'
  '323031373a30333a32332031323a30333a303600', // DateTime '2017:03:23 12:03:06'
  '0b00', // Exif IFD: 11 entries
  '9a820500010000001a010000', // ExposureTime RATIONAL[1] at 282
  '9d8205000100000022010000', // FNumber RATIONAL[1] at 290
  '2788030001000000a0000000', // ISOSpeedRatings SHORT = 160
  '009007000400000030323331', // ExifVersion UNDEFINED = '0231'
  '03900200140000002a010000', // DateTimeOriginal ASCII[20] at 298
  '04900200140000003e010000', // DateTimeDigitized ASCII[20] at 318
  '0a9205000100000052010000', // FocalLength RATIONAL[1] at 338
  '01a003000100000001000000', // ColorSpace SHORT = 1
  '02a0040001000000c00f0000', // PixelXDimension LONG = 4032
  '03a0040001000000d00b0000', // PixelYDimension LONG = 3024
  '34a40200230000005a010000', // LensModel ASCII[35] at 346
  '00000000', // next IFD: none
  '5f76000040420f00', // ExposureTime 30303/1000000
  '0b00000005000000', // FNumber 11/5
  '323031373a30333a32332031323a30333a303600', // DateTimeOriginal
  '323031373a30333a32332031323a30333a303600', // DateTimeDigitized
  '5300000014000000', // FocalLength 83/20
  '6950686f6e65205345206261636b2063616d65726120342e31356d6d20662f322e3200', // LensModel
].join('')

type JpegSegment = { marker: number; offset: number; length: number }

/** Marker segments between SOI and the first SOS. */
function headerSegments(jpeg: Uint8Array): JpegSegment[] {
  const segments: JpegSegment[] = []
  let offset = 2
  while (offset + 4 <= jpeg.byteLength && jpeg[offset] === 0xFF) {
    const marker = jpeg[offset + 1]
    if (marker === 0xDA) break
    const length = ((jpeg[offset + 2] << 8) | jpeg[offset + 3]) + 2
    segments.push({ marker, offset, length })
    offset += length
  }
  return segments
}

type ExifEntry = [tag: number, value: number | string]

/** Reads a little-endian EXIF APP1 segment without the export's own writer. */
function decodeApp1Exif(segment: Uint8Array): {
  ifd0: ExifEntry[]
  exif: ExifEntry[]
} {
  const tiff = new DataView(
    segment.buffer,
    segment.byteOffset + 10,
    segment.byteLength - 10,
  )
  const text = (offset: number, length: number) =>
    Buffer.from(segment.subarray(10 + offset, 10 + offset + length)).toString(
      'latin1',
    )
  const readIfd = (offset: number): ExifEntry[] => {
    const entries: ExifEntry[] = []
    const count = tiff.getUint16(offset, true)
    for (let index = 0; index < count; index += 1) {
      const entry = offset + 2 + index * 12
      const tag = tiff.getUint16(entry, true)
      const type = tiff.getUint16(entry + 2, true)
      const valueCount = tiff.getUint32(entry + 4, true)
      const pointer = tiff.getUint32(entry + 8, true)
      if (type === 2) {
        const at = valueCount > 4 ? pointer : entry + 8
        entries.push([tag, text(at, valueCount).replace(/\0$/, '')])
      } else if (type === 3) {
        entries.push([tag, tiff.getUint16(entry + 8, true)])
      } else if (type === 4) {
        entries.push([tag, pointer])
      } else if (type === 5) {
        const numerator = tiff.getUint32(pointer, true)
        const denominator = tiff.getUint32(pointer + 4, true)
        entries.push([tag, `${numerator}/${denominator}`])
      } else if (type === 7) {
        entries.push([
          tag,
          text(valueCount > 4 ? pointer : entry + 8, valueCount),
        ])
      } else {
        throw new Error(`Unexpected TIFF type ${type} for tag ${tag}`)
      }
    }
    return entries
  }
  expect(Buffer.from(segment.subarray(4, 18)).toString('hex')).toBe(
    '45786966000049492a0008000000',
  )
  const ifd0 = readIfd(tiff.getUint32(4, true))
  const exifPointer = ifd0.find(([tag]) => tag === 0x8769)?.[1]
  return {
    ifd0,
    exif: typeof exifPointer === 'number' ? readIfd(exifPointer) : [],
  }
}

let dir: string
beforeAll(() => {
  // LibRaw resolves the capture time with local-time mktime, so the EXIF
  // dates follow the host timezone; the golden is recorded under UTC.
  vi.stubEnv('TZ', 'UTC')
})
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'lmfg-export-'))
  vi.mocked(rm).mockImplementation(actualRm)
})
afterEach(async () => {
  await actualRm(dir, { recursive: true, force: true })
})
afterAll(() => {
  vi.unstubAllEnvs()
})

describeWithFixture('runFullResolutionExport', () => {
  it('streams the full-resolution JPEG with EXIF to disk and reports progress', async () => {
    expect(new Date(2017, 2, 23, 12, 3, 6).getTime()).toBe(
      Date.UTC(2017, 2, 23, 12, 3, 6),
    )
    const runtime = createLmfgRuntime({ memoryProfile: 'desktop' })
    const progress: number[] = []
    const outputPath = join(dir, 'exports', 'final.jpg')
    try {
      const source = await loadSourceFile(FIXTURE_PATH, '/')
      expect(source.sha256).toBe(LOCKED_FIXTURE_SHA256)
      const result = await runFullResolutionExport({
        runtime,
        source,
        params: parseRenderParams({ exposure_ev: 0.3 }),
        lut: null,
        exposure: null,
        quality: 90,
        outputPath,
        preferredRows: 512,
        onProgress: (p) => {
          progress.push(p.progress)
        },
      })
      expect(result.path).toBe(outputPath)
      expect(result.width).toBe(4032)
      expect(result.height).toBe(3024)
      expect(result.byteLength).toBeGreaterThan(1_000_000)
      expect(result.sha256).toMatch(/^[0-9a-f]{64}$/)
      expect(result.strips).toBe(6)
      expect(progress.at(-1)).toBe(99)
      expect(result.exposure.source).toBe('dng-baseline')
      expect(result.resource.max_rss_bytes).toBeGreaterThan(0)
      expect(await readdir(join(dir, 'exports'))).not.toContain('final.jpg')
      await result.commit()
      const jpeg = await readFile(outputPath)
      expect(jpeg.byteLength).toBe(result.byteLength)
      expect(createHash('sha256').update(jpeg).digest('hex')).toBe(
        result.sha256,
      )
      expect(jpeg[jpeg.byteLength - 2]).toBe(0xFF)
      expect(jpeg[jpeg.byteLength - 1]).toBe(0xD9)
      expect(await readdir(join(dir, 'exports'))).toEqual(['final.jpg'])

      // One EXIF APP1 lands right after the encoder's JFIF APP0.
      const segments = headerSegments(jpeg)
      expect(segments.slice(0, 2)).toEqual([
        { marker: 0xE0, offset: 2, length: 18 },
        { marker: 0xE1, offset: 20, length: 391 },
      ])
      expect(
        segments.filter((segment) => segment.marker === 0xE1),
      ).toHaveLength(1)
      const app1 = jpeg.subarray(20, 20 + 391)
      expect(Buffer.from(app1).toString('hex')).toBe(EXPORT_APP1_HEX)
      expect(createHash('sha256').update(app1).digest('hex')).toBe(
        'fcb3ea3f36b0f1d4da8bd83d974da9013b3546d7a222a3a0231d69aeb6e24c9e',
      )
      expect(decodeApp1Exif(app1)).toEqual({
        ifd0: [
          [0x010F, 'Apple'], // Make
          [0x0110, 'iPhone8,4 back camera'], // Model
          [0x0112, 1], // Orientation
          [0x0131, 'LumaForge'], // Software
          [0x0132, '2017:03:23 12:03:06'], // DateTime
          [0x8769, 144], // ExifIFDPointer
        ],
        exif: [
          [0x829A, '30303/1000000'], // ExposureTime
          [0x829D, '11/5'], // FNumber
          [0x8827, 160], // ISOSpeedRatings
          [0x9000, '0231'], // ExifVersion
          [0x9003, '2017:03:23 12:03:06'], // DateTimeOriginal
          [0x9004, '2017:03:23 12:03:06'], // DateTimeDigitized
          [0x920A, '83/20'], // FocalLength
          [0xA001, 1], // ColorSpace
          [0xA002, 4032], // PixelXDimension
          [0xA003, 3024], // PixelYDimension
          [0xA434, 'iPhone SE back camera 4.15mm f/2.2'], // LensModel
        ],
      })
    } finally {
      runtime.dispose()
    }
  }, 120_000)
})

function makeCapability(
  overrides: Partial<LumaRawExportCapability> = {},
): LumaRawExportCapability {
  return {
    supported: true,
    strategy: 'libraw-processed-window',
    width: 4,
    height: 4,
    rawWidth: 4,
    rawHeight: 4,
    visibleCrop: { x: 0, y: 0, width: 4, height: 4 },
    cfa: { pattern: 'rggb', xPhase: 0, yPhase: 0 },
    blackLevel: 0,
    whiteLevel: 255,
    orientation: { code: 1, supported: true },
    color: {
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
    windows: { librawProcessed: true, rawMosaic: false },
    diagnostics: {
      hasRawImage: true,
      hasColor3Image: false,
      hasColor4Image: false,
      hasXTransTable: false,
    },
    reasons: [],
    ...overrides,
  }
}

function makeProcessedWindow(
  request: LumaRawProcessedWindowRequest,
): LumaRawProcessedWindow {
  const { width, height } = request.outputRect
  return {
    rect: request.outputRect,
    workingSpace: 'linear-prophoto-rgb',
    data: new Uint16Array(width * height * 3).fill(32768),
    width,
    height,
    stride: width * 3,
    normalized: false,
    orientationApplied: true,
    colorApplied: true,
    warnings: [],
  }
}

type FakeSessionOptions = {
  capability?: LumaRawExportCapability
  begin?: () => Promise<unknown>
  read?: (
    request: LumaRawProcessedWindowRequest,
  ) => Promise<LumaRawProcessedWindow>
  end?: () => Promise<{ ended: true }>
}

function makeFakeSession(options: FakeSessionOptions = {}) {
  return {
    probe: null,
    probeExportCapability: vi.fn(
      async () => options.capability ?? makeCapability(),
    ),
    beginProcessedWindowExport: vi.fn(
      options.begin ?? (async () => ({ active: true })),
    ),
    readProcessedWindow: vi.fn(
      options.read ?? (async (request) => makeProcessedWindow(request)),
    ),
    endProcessedWindowExport: vi.fn(
      options.end ?? (async () => ({ ended: true as const })),
    ),
    dispose: vi.fn(),
  }
}

async function listFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true, recursive: true })
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => relative(root, join(entry.parentPath, entry.name)))
    .sort()
}

function runWithSession(
  session: ReturnType<typeof makeFakeSession>,
  outputPath: string,
  extra: Pick<
    ExportRunInput,
    'geometry' | 'verifyFrame' | 'preferredRows'
  > = {},
) {
  const runtime = {
    memoryProfile: 'desktop',
    raw: async () => ({ openSession: async () => session }),
    jpeg: async () => {
      throw new Error('unused')
    },
    dispose: () => undefined,
  } as unknown as LmfgRuntime
  const source = {
    input: { kind: 'bytes', bytes: new Uint8Array(0) },
  } as unknown as LoadedSource
  return runFullResolutionExport({
    runtime,
    source,
    params: parseRenderParams({}),
    lut: null,
    exposure: { ev: 0, multiplier: 1, source: 'identity' },
    quality: 90,
    outputPath,
    ...extra,
  })
}

describe('runFullResolutionExport processed-window lifecycle', () => {
  it('returns an unpublished JPEG and ends the processed-window export once', async () => {
    const session = makeFakeSession()
    const outputPath = join(dir, 'exports', 'final.jpg')
    const result = await runWithSession(session, outputPath)

    expect(session.beginProcessedWindowExport).toHaveBeenCalledTimes(1)
    expect(session.endProcessedWindowExport).toHaveBeenCalledTimes(1)
    expect(session.dispose).toHaveBeenCalledTimes(1)
    expect(result.width).toBe(4)
    expect(result.height).toBe(4)
    const files = await listFiles(dir)
    expect(files).toHaveLength(1)
    expect(files[0]).toMatch(/^exports\/final\.jpg\.\d+\.[0-9a-f]{8}\.tmp$/)

    await result.commit()
    expect(await listFiles(dir)).toEqual(['exports/final.jpg'])
    const jpeg = await readFile(outputPath)
    expect(createHash('sha256').update(jpeg).digest('hex')).toBe(result.sha256)
  })

  it('rejects with the begin failure without ending or writing anything', async () => {
    const beginError = new Error('BEGIN_FAILED')
    const session = makeFakeSession({ begin: () => Promise.reject(beginError) })

    await expect(
      runWithSession(session, join(dir, 'exports', 'final.jpg')),
    ).rejects.toBe(beginError)
    expect(session.readProcessedWindow).not.toHaveBeenCalled()
    expect(session.endProcessedWindowExport).not.toHaveBeenCalled()
    expect(session.dispose).toHaveBeenCalledTimes(1)
    expect(await listFiles(dir)).toEqual([])
  })

  it('rejects with the render failure and still ends the processed-window export', async () => {
    const renderError = new Error('WINDOW_READ_FAILED')
    const session = makeFakeSession({ read: () => Promise.reject(renderError) })

    await expect(
      runWithSession(session, join(dir, 'exports', 'final.jpg')),
    ).rejects.toBe(renderError)
    expect(session.endProcessedWindowExport).toHaveBeenCalledTimes(1)
    expect(session.dispose).toHaveBeenCalledTimes(1)
    expect(await listFiles(dir)).toEqual([])
  })

  it('rejects with the cleanup failure and discards the encoded JPEG', async () => {
    const cleanupError = new Error('END_FAILED')
    const session = makeFakeSession({ end: () => Promise.reject(cleanupError) })

    await expect(
      runWithSession(session, join(dir, 'exports', 'final.jpg')),
    ).rejects.toBe(cleanupError)
    expect(session.readProcessedWindow).toHaveBeenCalled()
    expect(session.endProcessedWindowExport).toHaveBeenCalledTimes(1)
    expect(session.dispose).toHaveBeenCalledTimes(1)
    expect(await listFiles(dir)).toEqual([])
  })

  it('keeps the render failure and reports the cleanup that also failed', async () => {
    const renderError = new Error('WINDOW_READ_FAILED')
    const session = makeFakeSession({
      read: () => Promise.reject(renderError),
      end: () => Promise.reject(new Error('END_FAILED')),
    })

    const error = await runWithSession(
      session,
      join(dir, 'exports', 'final.jpg'),
    ).catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(LmfgError)
    expect((error as LmfgError).cause).toBe(renderError)
    expect(toLmfgError(error).toEnvelope().error).toMatchObject({
      code: 'internal',
      message: 'WINDOW_READ_FAILED',
      details: {
        cleanup_failures: [
          { step: 'end_processed_window_export', code: 'internal' },
        ],
      },
    })
    expect(session.endProcessedWindowExport).toHaveBeenCalledTimes(1)
    expect(session.dispose).toHaveBeenCalledTimes(1)
    expect(await listFiles(dir)).toEqual([])
  })

  it('keeps the end failure and lists the encoded JPEG it could not discard', async () => {
    const endError = new Error('END_FAILED')
    const session = makeFakeSession({ end: () => Promise.reject(endError) })
    failTempRemoval()

    const error = await runWithSession(
      session,
      join(dir, 'exports', 'final.jpg'),
    ).catch((caught: unknown) => caught)

    expect((error as LmfgError).cause).toBe(endError)
    const envelope = toLmfgError(error).toEnvelope().error
    expect(envelope).toMatchObject({
      code: 'internal',
      message: 'END_FAILED',
      details: {
        cleanup_failures: [
          {
            step: 'remove_temp_file',
            code: 'permission.denied',
            errno: 'EACCES',
          },
        ],
      },
    })
    expect(JSON.stringify(envelope.details)).not.toContain(dir)
    expect(session.dispose).toHaveBeenCalledTimes(1)
    const files = await listFiles(dir)
    expect(files).toHaveLength(1)
    expect(files[0]).toMatch(/^exports\/final\.jpg\.\d+\.[0-9a-f]{8}\.tmp$/)
  })
})

const actualJpegNode = await vi.importActual<
  typeof import('@lumaforge/luma-jpeg-runtime/node')
>('@lumaforge/luma-jpeg-runtime/node')

/** Runs every JPEG session of the export on `nativeModule`. */
function runJpegOnNativeModule(nativeModule: unknown): void {
  vi.mocked(createLumaJpegRuntimeForNode).mockImplementation((options) =>
    actualJpegNode.createLumaJpegRuntimeForNode({
      ...options,
      nativeLoader: async () => nativeModule,
    }),
  )
}

afterEach(() => {
  vi.mocked(createLumaJpegRuntimeForNode).mockImplementation(
    actualJpegNode.createLumaJpegRuntimeForNode,
  )
})

type NativeChunk = { bytes: Uint8Array; byteOffset: number; final: boolean }

/**
 * A native JPEG encoder stand-in that streams a chunk on every row write, so
 * an attempt's temp file exists before it finishes. The first chunk opens a
 * JPEG and passes the 64 KiB header scan; finish closes it.
 */
function streamingNativeModule() {
  class LumaJpegEncoder {
    private pending: NativeChunk[] = []
    private offset = 0

    private emit(bytes: Uint8Array) {
      this.pending.push({ bytes, byteOffset: this.offset, final: false })
      this.offset += bytes.byteLength
    }

    writeRows() {
      if (this.offset > 0) {
        this.emit(new Uint8Array(16))
        return
      }
      const head = new Uint8Array(70_000)
      head.set([0xFF, 0xD8, 0xFF, 0xDB, 0x00, 0x02])
      this.emit(head)
    }

    finish() {
      this.emit(new Uint8Array([0xFF, 0xD9]))
      return new Uint8Array(0)
    }

    drainChunks() {
      const chunks = this.pending
      this.pending = []
      return chunks
    }

    abort() {}

    delete() {}
  }
  return { LumaJpegEncoder }
}

/** The packaged native JPEG encoder with an abort that fails after it ran. */
async function failingAbortNativeModule(abortError: Error) {
  const { loadNativeModuleForNode } =
    await import('@lumaforge/luma-native-artifacts/load-for-node')
  type Encoder = {
    writeRows: (rows: Uint8Array, rowCount: number) => unknown
    finish: () => Uint8Array
    drainChunks?: () => NativeChunk[]
    abort: () => void
    delete: () => void
  }
  const native = (await loadNativeModuleForNode({ kind: 'jpeg' })) as {
    LumaJpegEncoder: new (
      width: number,
      height: number,
      quality: number,
    ) => Encoder
  }
  const calls = { abort: 0 }
  function LumaJpegEncoder(width: number, height: number, quality: number) {
    const inner = new native.LumaJpegEncoder(width, height, quality)
    return {
      writeRows: (rows: Uint8Array, rowCount: number) =>
        inner.writeRows(rows, rowCount),
      finish: () => inner.finish(),
      ...(inner.drainChunks ? { drainChunks: () => inner.drainChunks!() } : {}),
      abort: () => {
        calls.abort += 1
        inner.abort()
        throw abortError
      },
      delete: () => inner.delete(),
    }
  }
  return { module: { ...native, LumaJpegEncoder }, calls }
}

/** Lets the strips already read reach the JPEG sink. */
async function settleWrites(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 20))
}

/** Fails a window read after the strips already read were written. */
async function failLater(message: string): Promise<never> {
  await settleWrites()
  throw new Error(message)
}

const TEMP_FILE = /^exports\/final\.jpg\.\d+\.[0-9a-f]{8}\.tmp$/

describe('runFullResolutionExport cleanup across engine retries', () => {
  const tall = { width: 8, height: 512 }
  const capability = makeCapability({
    ...tall,
    rawWidth: tall.width,
    rawHeight: tall.height,
    visibleCrop: { x: 0, y: 0, ...tall },
  })
  const removeFailure = {
    step: 'remove_temp_file',
    code: 'permission.denied',
    errno: 'EACCES',
  }

  it('reports the temp file a retried attempt left behind with the delivered export', async () => {
    runJpegOnNativeModule(streamingNativeModule())
    let reads = 0
    const session = makeFakeSession({
      capability,
      read: async (request) => {
        reads += 1
        // The first attempt runs out of memory once two strips reached its
        // temp file.
        if (reads === 3) await failLater('RESOURCE_ALLOCATION_FAILED')
        return makeProcessedWindow(request)
      },
    })
    failTempRemoval()
    const outputPath = join(dir, 'exports', 'final.jpg')

    const result = await runWithSession(session, outputPath, {
      preferredRows: 128,
    })

    // Three reads of the abandoned attempt, then 64-row strips.
    expect(reads).toBe(3 + 8)
    expect(result.cleanupFailures).toEqual([removeFailure])
    expect(JSON.stringify(result.cleanupFailures)).not.toContain(dir)
    const pending = await listFiles(dir)
    expect(pending).toHaveLength(2)
    for (const file of pending) expect(file).toMatch(TEMP_FILE)

    await result.commit()
    const published = await listFiles(dir)
    const orphans = published.filter((file) => file.endsWith('.tmp'))
    expect(published).toEqual(['exports/final.jpg', ...orphans])
    expect(orphans).toHaveLength(1)
    expect(pending).toContain(orphans[0])
    const jpeg = await readFile(outputPath)
    expect(createHash('sha256').update(jpeg).digest('hex')).toBe(result.sha256)
  })

  it('lists the retried attempt beside a later failure', async () => {
    runJpegOnNativeModule(streamingNativeModule())
    let reads = 0
    const renderError = new Error('WINDOW_READ_FAILED')
    const session = makeFakeSession({
      capability,
      read: async (request) => {
        reads += 1
        if (reads === 3) await failLater('RESOURCE_ALLOCATION_FAILED')
        if (reads === 6) {
          await settleWrites()
          throw renderError
        }
        return makeProcessedWindow(request)
      },
    })
    failTempRemoval()

    const error = await runWithSession(
      session,
      join(dir, 'exports', 'final.jpg'),
      { preferredRows: 128 },
    ).catch((caught: unknown) => caught)

    expect((error as LmfgError).cause).toBe(renderError)
    expect(toLmfgError(error).toEnvelope().error).toMatchObject({
      code: 'internal',
      message: 'WINDOW_READ_FAILED',
      details: { cleanup_failures: [removeFailure, removeFailure] },
    })
    const left = await listFiles(dir)
    expect(left).toHaveLength(2)
    for (const file of left) expect(file).toMatch(TEMP_FILE)
  })

  it('reports a native encoder abort that failed in the retried attempt', async () => {
    const { module, calls } = await failingAbortNativeModule(
      new Error('NATIVE_ABORT_FAILED'),
    )
    runJpegOnNativeModule(module)
    let reads = 0
    const session = makeFakeSession({
      capability,
      read: async (request) => {
        reads += 1
        if (reads === 3) throw new Error('RESOURCE_ALLOCATION_FAILED')
        return makeProcessedWindow(request)
      },
    })
    const outputPath = join(dir, 'exports', 'final.jpg')

    const result = await runWithSession(session, outputPath, {
      preferredRows: 128,
    })

    expect(calls.abort).toBe(1)
    expect(result.cleanupFailures).toEqual([
      { step: 'abort_jpeg_encoder', code: 'internal' },
    ])
    await result.commit()
    expect(await listFiles(dir)).toEqual(['exports/final.jpg'])
    const jpeg = await readFile(outputPath)
    expect(sofDimensions(jpeg)).toEqual(tall)
  })
})

describe('runFullResolutionExport with a failing native encoder abort', () => {
  it('keeps the window read failure and lists the encoder abort that failed', async () => {
    const { module, calls } = await failingAbortNativeModule(
      new Error('NATIVE_ABORT_FAILED'),
    )
    runJpegOnNativeModule(module)
    const renderError = new Error('WINDOW_READ_FAILED')
    let reads = 0
    const session = makeFakeSession({
      capability: makeCapability({
        width: 4,
        height: 128,
        rawWidth: 4,
        rawHeight: 128,
        visibleCrop: { x: 0, y: 0, width: 4, height: 128 },
      }),
      read: async (request) => {
        reads += 1
        if (reads === 2) throw renderError
        return makeProcessedWindow(request)
      },
    })

    const error = await runWithSession(
      session,
      join(dir, 'exports', 'final.jpg'),
      { preferredRows: 64 },
    ).catch((caught: unknown) => caught)

    expect(calls.abort).toBe(1)
    expect((error as LmfgError).cause).toBe(renderError)
    expect(toLmfgError(error).toEnvelope().error).toMatchObject({
      code: 'internal',
      message: 'WINDOW_READ_FAILED',
      details: {
        cleanup_failures: [{ step: 'abort_jpeg_encoder', code: 'internal' }],
      },
    })
    expect(session.endProcessedWindowExport).toHaveBeenCalledTimes(1)
    expect(session.dispose).toHaveBeenCalledTimes(1)
    expect(await listFiles(dir)).toEqual([])
  })
})

describe('runFullResolutionExport source assessment', () => {
  it.each([
    [
      'an unsupported source',
      { supported: false, reasons: ['unsupported-cfa-pattern'] },
      ['source-unsupported'],
    ],
    ['zero dimensions', { width: 0, height: 0 }, ['invalid-dimensions']],
    [
      'the raw-mosaic strategy',
      {
        strategy: 'raw-mosaic-window',
        windows: { librawProcessed: false, rawMosaic: true },
      },
      ['strategy-not-processed-window', 'processed-windows-unavailable'],
    ],
    ['missing color facts', { color: undefined }, ['color-facts-missing']],
    [
      'runtime white balance not applied',
      {
        color: {
          workingSpace: 'linear-prophoto-rgb',
          librawOutputColor: 'prophoto',
          gamma: 'linear',
          cameraWhiteBalanceAppliedByRuntime: false,
          cameraMatrixAppliedByRuntime: true,
        },
      },
      ['white-balance-not-applied-by-runtime'],
    ],
  ] as Array<[string, Partial<LumaRawExportCapability>, string[]]>)(
    'refuses %s before the processed-window export begins',
    async (_name, overrides, refusals) => {
      const capability = makeCapability(overrides)
      const session = makeFakeSession({ capability })

      const error = await runWithSession(
        session,
        join(dir, 'exports', 'final.jpg'),
      ).catch((caught: unknown) => caught)

      expect(error).toBeInstanceOf(LmfgError)
      expect(error).toMatchObject({
        code: 'source.export_unsupported',
        details: {
          reasons: capability.reasons,
          refusals,
          strategy: capability.strategy ?? null,
        },
      })
      expect(session.beginProcessedWindowExport).not.toHaveBeenCalled()
      expect(session.readProcessedWindow).not.toHaveBeenCalled()
      expect(session.endProcessedWindowExport).not.toHaveBeenCalled()
      expect(session.dispose).toHaveBeenCalledTimes(1)
      expect(await listFiles(dir)).toEqual([])
    },
  )
})

/** Frame size the JPEG's SOF0 header declares. */
function sofDimensions(jpeg: Uint8Array): { width: number; height: number } {
  const sof = headerSegments(jpeg).find((segment) => segment.marker === 0xC0)
  if (!sof) throw new Error('no SOF0 segment')
  return {
    height: (jpeg[sof.offset + 5] << 8) | jpeg[sof.offset + 6],
    width: (jpeg[sof.offset + 7] << 8) | jpeg[sof.offset + 8],
  }
}

describe('runFullResolutionExport with a geometry', () => {
  const source = { width: 64, height: 48 }
  const capability = makeCapability({
    ...source,
    rawWidth: source.width,
    rawHeight: source.height,
    visibleCrop: { x: 0, y: 0, ...source },
  })
  // A small rotation with a constrained crop, as the app's Transform commits it.
  const rotated: ExportGeometry = {
    matrix: [0.99, -0.04, 0.02, 0.04, 0.99, -0.01, 0, 0, 1],
    constrainCrop: true,
  }
  // The projective horizon crosses the frame, so the mapping folds.
  const folding: ExportGeometry = {
    matrix: [1, 0, 0, 0, 1, 0, -2, 0, 1],
    constrainCrop: false,
  }

  it('delivers the frame the engine planner plans and reads inside the source', async () => {
    const planned = planExportGeometry(rotated, source)
    // The rotation's constrained crop of the 64x48 frame, as a literal.
    expect({
      width: planned.outputWidth,
      height: planned.outputHeight,
    }).toEqual({ width: 60, height: 45 })
    const session = makeFakeSession({ capability })
    const frames: unknown[] = []
    const outputPath = join(dir, 'exports', 'final.jpg')

    const result = await runWithSession(session, outputPath, {
      geometry: rotated,
      verifyFrame: (frame) => {
        frames.push(frame)
        expect(session.beginProcessedWindowExport).not.toHaveBeenCalled()
      },
    })

    const delivered = {
      width: planned.outputWidth,
      height: planned.outputHeight,
    }
    expect(frames).toEqual([{ source, output: delivered }])
    expect({ width: result.width, height: result.height }).toEqual(delivered)
    expect(result.source).toEqual(source)
    for (const [request] of session.readProcessedWindow.mock.calls) {
      const rect = request.outputRect
      expect(rect.x).toBeGreaterThanOrEqual(0)
      expect(rect.y).toBeGreaterThanOrEqual(0)
      expect(rect.x + rect.width).toBeLessThanOrEqual(source.width)
      expect(rect.y + rect.height).toBeLessThanOrEqual(source.height)
    }
    await result.commit()
    expect(sofDimensions(await readFile(outputPath))).toEqual({
      width: 60,
      height: 45,
    })
  })

  it('reports the decoded frame as delivered without a geometry', async () => {
    const session = makeFakeSession({ capability })
    const frames: unknown[] = []
    const outputPath = join(dir, 'exports', 'final.jpg')
    const result = await runWithSession(session, outputPath, {
      verifyFrame: (frame) => void frames.push(frame),
    })
    expect(frames).toEqual([{ source, output: source }])
    expect(result.source).toEqual(source)
    expect({ width: result.width, height: result.height }).toEqual(source)
    await result.commit()
    expect(sofDimensions(await readFile(outputPath))).toEqual({
      width: 64,
      height: 48,
    })
  })

  it('refuses a folding geometry before the processed-window export begins', async () => {
    const session = makeFakeSession({ capability })
    const verifyFrame = vi.fn()

    await expect(
      runWithSession(session, join(dir, 'exports', 'final.jpg'), {
        geometry: folding,
        verifyFrame,
      }),
    ).rejects.toMatchObject({
      code: 'export.refused',
      details: { stage: 'geometry', source },
    })
    expect(verifyFrame).not.toHaveBeenCalled()
    expect(session.beginProcessedWindowExport).not.toHaveBeenCalled()
    expect(session.readProcessedWindow).not.toHaveBeenCalled()
    expect(session.dispose).toHaveBeenCalledTimes(1)
    expect(await listFiles(dir)).toEqual([])
  })

  it('refuses when the frame check throws, before any window is read', async () => {
    const session = makeFakeSession({ capability })
    const refusal = new Error('FRAME_REFUSED')

    await expect(
      runWithSession(session, join(dir, 'exports', 'final.jpg'), {
        geometry: rotated,
        verifyFrame: () => {
          throw refusal
        },
      }),
    ).rejects.toBe(refusal)
    expect(session.beginProcessedWindowExport).not.toHaveBeenCalled()
    expect(session.readProcessedWindow).not.toHaveBeenCalled()
    expect(session.dispose).toHaveBeenCalledTimes(1)
    expect(await listFiles(dir)).toEqual([])
  })
})
