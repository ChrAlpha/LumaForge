/// <reference types="node" />

import { existsSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'

import type { RawRenderExposure } from '@lumaforge/luma-color-runtime'
import {
  NEUTRAL_SELECTIVE_COLOR,
  resolveExportColorGraph,
} from '@lumaforge/luma-color-runtime'
import { createLumaRawRuntime } from '@lumaforge/luma-raw-runtime'
import { processedWindowToRgb16Rows } from '@lumaforge/render-engine'
import {
  createBlobOutputResult,
  createWasmJpegRowSink,
  materializeOutputBlob,
  runFullResolutionJpegExport,
} from '@lumaforge/render-engine/export'
import type { TestContext } from 'vitest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { parseCubeLUT, toLUTData } from '~/lib/lut/cube-parser'
import { applyLUTContractSelection } from '~/lib/lut/profile-resolution'

import { createLumaJpegRuntime } from '../../../packages/luma-jpeg-runtime/src/runtime'
import { createBaselineJpegEncoder } from '../../../packages/luma-jpeg-runtime/worker/baseline-encoder'
import type {
  JpegWorkerRequest,
  JpegWorkerResponse,
} from '../../../packages/luma-jpeg-runtime/worker/runtime-core'
import { createJpegRuntimeCore } from '../../../packages/luma-jpeg-runtime/worker/runtime-core'
import type { LumaRawErrorCode } from '../../../packages/luma-raw-runtime/src/errors'
import { normalizeRawRuntimeError } from '../../../packages/luma-raw-runtime/src/errors'
import type {
  LumaRawWorkerRequest,
  LumaRawWorkerResponse,
} from '../../../packages/luma-raw-runtime/src/worker-protocol'
import { createNativeFactory } from '../../../packages/luma-raw-runtime/worker/native-adapter'
import type {
  LumaRawNativeDecodeOptions,
  LumaRawNativeFactory,
} from '../../../packages/luma-raw-runtime/worker/native-types'
import { createRuntimeCore } from '../../../packages/luma-raw-runtime/worker/runtime-core'

type NativeModuleFactory = (options?: {
  locateFile?: (path: string) => string
}) => Promise<unknown>
type JpegWorkerErrorResponse = {
  id: string
  ok: false
  type: JpegWorkerRequest['type']
  error: { message: string }
}
type JpegWorkerMessage = JpegWorkerResponse | JpegWorkerErrorResponse
type PrivateFixture = {
  path: string | null
  ready: boolean
  required: boolean
  reason: string
}
type PrivateFixtureOptions = {
  env?: Record<string, string | undefined>
  exists?: (path: string) => boolean
}

const JPEG_SOI_MARKER = 65_496
const JPEG_EOI_MARKER = 65_497
const JPEG_MARKER_PREFIX = 255
const JPEG_SOS_MARKER = 218
const JPEG_SOF0_MARKER = 192
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const packageDir = join(repoRoot, 'packages', 'luma-raw-runtime')
const defaultNativeProfile = 'desktop'
const nativeJsPath = nativeArtifactPath(defaultNativeProfile, 'luma_raw.js')
const nativeWasmPath = nativeArtifactPath(defaultNativeProfile, 'luma_raw.wasm')
const hasDesktopNativeArtifacts =
  existsSync(nativeJsPath) && existsSync(nativeWasmPath)
const hasLowMemoryNativeArtifacts =
  existsSync(nativeArtifactPath('low-memory', 'luma_raw.js')) &&
  existsSync(nativeArtifactPath('low-memory', 'luma_raw.wasm'))

const requirePrivateFixturesEnv = 'LUMAFORGE_REQUIRE_PRIVATE_FIXTURES'

function isTruthyFlag(value: string | undefined) {
  return value === '1' || value === 'true'
}

// These cases expect one particular local RAF, ARW and V-Log LUT, which the
// repository cannot ship, so each input resolves only from its own variable.
// Once the native artifacts exist, an unset input skips the case as optional
// private coverage unless LUMAFORGE_REQUIRE_PRIVATE_FIXTURES=1, and a named
// file that is missing fails it. Relative paths resolve against the
// repository root.
function resolvePrivateFixture(
  envName: string,
  description: string,
  { env = process.env, exists = existsSync }: PrivateFixtureOptions = {},
): PrivateFixture {
  const value = env[envName]?.trim()
  if (!value) {
    const required = isTruthyFlag(env[requirePrivateFixturesEnv])
    return {
      path: null,
      ready: false,
      required,
      reason: required
        ? `${requirePrivateFixturesEnv} is set, but ${envName} is not: set it to ${description}.`
        : `Optional private coverage: set ${envName} to ${description}.`,
    }
  }

  const path = resolve(repoRoot, value)
  const ready = exists(path)
  return {
    path,
    ready,
    required: true,
    reason: ready
      ? ''
      : `${envName} is set to "${value}", but ${path} does not exist.`,
  }
}

// Vitest's `context.skip` throws; the final throw keeps a skip that returns
// from handing the case a missing path.
function privateFixturePath(
  context: { skip: (note?: string) => void },
  fixture: PrivateFixture,
) {
  if (fixture.ready && fixture.path) return fixture.path
  if (!fixture.required) context.skip(fixture.reason)
  throw new Error(fixture.reason)
}

function resolveRealExportFixtures(options?: PrivateFixtureOptions) {
  return {
    gfxRaf: resolvePrivateFixture(
      'LUMAFORGE_100MP_RAF',
      'a local 100MP Fujifilm RAF (GFX100RF, 16-bit lossless compressed)',
      options,
    ),
    sonyArw: resolvePrivateFixture(
      'LUMAFORGE_SONY_ARW',
      'a local 61MP Sony ARW that decodes to 9566x6374',
      options,
    ),
    vLogLut: resolvePrivateFixture(
      'LUMAFORGE_VLOG_LUT',
      'a local V-Log to Rec.709 .cube LUT, such as V-Log Alchemy ARRI_LogC2Video_Classic709_VLog.cube',
      options,
    ),
  }
}

const realExportFixtures = resolveRealExportFixtures()

function nativeArtifactPath(profile: 'desktop' | 'low-memory', file: string) {
  return join(packageDir, 'dist', 'native', profile, file)
}

async function requireFile(absolutePath: string, label: string) {
  const entry = await stat(absolutePath)
  if (!entry.isFile()) {
    throw new Error(`Expected ${label} to be a file: ${absolutePath}`)
  }
}

async function requireGfxExportInputs(context: TestContext) {
  const rawPath = privateFixturePath(context, realExportFixtures.gfxRaf)
  const lutPath = privateFixturePath(context, realExportFixtures.vLogLut)

  await Promise.all([
    requireFile(nativeJsPath, 'native runtime JS artifact'),
    requireFile(nativeWasmPath, 'native runtime WASM artifact'),
    requireFile(rawPath, 'GFX100RF RAF fixture'),
    requireFile(lutPath, 'V-Log Classic709 LUT fixture'),
  ])
  return { rawPath, lutPath }
}

function markCrossOriginIsolated() {
  Object.defineProperty(globalThis, 'crossOriginIsolated', {
    configurable: true,
    value: true,
  })
}

function installFileUrlFetchFallback() {
  const originalFetch = globalThis.fetch

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input.url

    if (url.startsWith('file:')) {
      const bytes = await readFile(fileURLToPath(url))
      return new Response(new Uint8Array(bytes), {
        status: 200,
        statusText: 'OK',
      })
    }

    return originalFetch(input, init)
  }) as typeof fetch

  return () => {
    globalThis.fetch = originalFetch
  }
}

async function loadNativeFactory(
  profile: 'desktop' | 'low-memory' = 'desktop',
): Promise<LumaRawNativeFactory> {
  const profileNativeJsPath = nativeArtifactPath(profile, 'luma_raw.js')
  const profileNativeWasmPath = nativeArtifactPath(profile, 'luma_raw.wasm')
  const moduleImport = (await import(
    /* @vite-ignore */ pathToFileURL(profileNativeJsPath).href
  )) as {
    default: NativeModuleFactory
  }

  const module = await moduleImport.default({
    locateFile(path) {
      if (path.endsWith('.wasm')) {
        return pathToFileURL(profileNativeWasmPath).href
      }

      return path
    },
  })

  return createNativeFactory(
    module as {
      LumaRawProcessor: new () => {
        loadBuffer?: (data: Uint8Array) => unknown
        openWithSettings?: (settings: unknown) => unknown
        openBuffer: (data: Uint8Array, settings: unknown) => unknown
        readMetadata: () => unknown
        extractThumbnail: () => unknown
        probeExportCapability?: () => unknown
        readRawWindow?: (rect: unknown) => unknown
        readProcessedWindow?: (request: unknown) => unknown
        decodePreview: (options?: LumaRawNativeDecodeOptions) => unknown
        decodeHq: (options?: LumaRawNativeDecodeOptions) => unknown
        delete?: () => void
      }
      HEAPU8?: Uint8Array
    },
  )
}

async function createNativeCore(profile: 'desktop' | 'low-memory') {
  const nativeFactory = await loadNativeFactory(profile)
  return createRuntimeCore(nativeFactory)
}

const nativeCorePromises = new Map<
  'desktop' | 'low-memory',
  ReturnType<typeof createNativeCore>
>()

function getNativeCore(profile: 'desktop' | 'low-memory') {
  let corePromise = nativeCorePromises.get(profile)
  if (!corePromise) {
    corePromise = createNativeCore(profile)
    nativeCorePromises.set(profile, corePromise)
  }
  return corePromise
}

function failureResponse(
  request: LumaRawWorkerRequest,
  error: unknown,
  fallbackCode: LumaRawErrorCode,
): LumaRawWorkerResponse {
  const runtimeError = normalizeRawRuntimeError(error, fallbackCode)

  return {
    id: request.id,
    ok: false,
    type: request.type,
    error: {
      code: runtimeError.code,
      message: runtimeError.message,
    },
  } as LumaRawWorkerResponse
}

class RealNativeWorker {
  onmessage: ((event: MessageEvent<LumaRawWorkerResponse>) => void) | null =
    null
  onerror: ((event: ErrorEvent) => void) | null = null
  private terminated = false

  constructor(private readonly profile: 'desktop' | 'low-memory' = 'desktop') {}

  postMessage(request: LumaRawWorkerRequest) {
    queueMicrotask(() => {
      void this.handleRequest(request)
    })
  }

  terminate() {
    this.terminated = true
  }

  private async handleRequest(request: LumaRawWorkerRequest) {
    if (this.terminated) return

    let response: LumaRawWorkerResponse
    try {
      const core = await getNativeCore(this.profile)
      response = await core.handleRequest(request)
    } catch (error) {
      response = failureResponse(request, error, 'RAW_RUNTIME_UNAVAILABLE')
    }

    if (this.terminated) return

    this.onmessage?.({
      data: response,
    } as MessageEvent<LumaRawWorkerResponse>)
  }
}

class CoreBackedJpegWorker {
  onmessage: ((event: MessageEvent<JpegWorkerMessage>) => void) | null = null
  onerror: ((event: ErrorEvent) => void) | null = null
  private readonly core = createJpegRuntimeCore(
    async () => createBaselineJpegEncoder,
  )

  postMessage(request: JpegWorkerRequest) {
    void this.core
      .handleRequest(request)
      .then((response) => {
        queueMicrotask(() => {
          this.onmessage?.({
            data: response,
          } as MessageEvent<JpegWorkerMessage>)
        })
      })
      .catch((error) => {
        queueMicrotask(() => {
          this.onmessage?.({
            data: {
              id: request.id,
              ok: false,
              type: request.type,
              error: {
                message: error instanceof Error ? error.message : String(error),
              },
            },
          } as MessageEvent<JpegWorkerMessage>)
        })
      })
  }

  terminate() {}
}

async function createFileFromPath(absolutePath: string) {
  const bytes = await readFile(absolutePath)
  return new File([new Uint8Array(bytes)], basename(absolutePath), {
    type: 'image/x-raw',
  })
}

function createResolvedVLogClassic709Graph(
  lutPath: string,
  lutContent: string,
) {
  const parsedLut = parseCubeLUT(lutContent, {
    sourceName: basename(lutPath),
  })
  const lut = applyLUTContractSelection(parsedLut, {
    role: 'combined-look-output',
    inputProfile: 'panasonic-vgamut-vlog',
    outputGamut: 'srgb-rec709',
    outputTransfer: 'bt709',
    outputRange: 'full',
  })
  if (!lut) {
    throw new Error('Expected V-Log Classic709 LUT contract selection')
  }

  const rawRenderExposure: RawRenderExposure = {
    ev: 0.75,
    multiplier: Math.pow(2, 0.75),
    source: 'image-statistics',
  }
  const graph = resolveExportColorGraph({
    styleKind: 'custom',
    intensity: 1,
    builtinPreset: null,
    lut: toLUTData(lut),
    rawRenderExposure,
    userExposureEv: 1,
    userContrast: 50,
    userHighlights: -40,
    userShadows: 35,
    userWhites: -20,
    userBlacks: 15,
    selectiveColor: NEUTRAL_SELECTIVE_COLOR,
  })

  if (!graph.supported) {
    throw new Error(graph.message)
  }

  const rawExposureSteps = graph.steps.filter(
    (step) => step.kind === 'raw-render-exposure',
  )
  const userExposureSteps = graph.steps.filter(
    (step) => step.kind === 'user-exposure',
  )
  const userContrastSteps = graph.steps.filter(
    (step) => step.kind === 'user-contrast',
  )
  const userRegionalToneSteps = graph.steps.filter(
    (step) => step.kind === 'user-regional-tone',
  )

  expect(graph.steps.map((step) => step.kind)).toEqual([
    'input-linear-prophoto',
    'raw-render-exposure',
    'user-color-balance',
    'user-exposure',
    'user-contrast',
    'user-regional-tone',
    'user-saturation',
    'user-selective-color',
    'gamut-to-lut-input',
    'encode-lut-transfer',
    'lut3d',
    'lut-output-to-srgb',
    'output-srgb',
  ])
  expect(rawExposureSteps).toEqual([
    {
      kind: 'raw-render-exposure',
      ev: rawRenderExposure.ev,
      multiplier: rawRenderExposure.multiplier,
    },
  ])
  expect(userExposureSteps).toEqual([
    {
      kind: 'user-exposure',
      ev: 1,
      multiplier: 2,
    },
  ])
  expect(userContrastSteps).toEqual([
    {
      kind: 'user-contrast',
      amount: 50,
      factor: Math.pow(2, 50 / 200),
      pivot: 0.18,
      operator: 'linear-prophoto-luminance-scale',
      luminanceCoefficients: [0.2880402, 0.7118741, 0.0000857],
      zeroLuminanceMode: 'return-black',
    },
  ])
  expect(userRegionalToneSteps).toEqual([
    {
      kind: 'user-regional-tone',
      highlights: -40,
      shadows: 35,
      whites: -20,
      blacks: 15,
      operator: 'linear-prophoto-log-luminance-regions',
      pivot: 0.18,
      luminanceCoefficients: [0.2880402, 0.7118741, 0.0000857],
      zeroLuminanceMode: 'return-black',
    },
  ])
  expect(graph.lutProfile).toMatchObject({
    role: 'combined-look-output',
    inputGamut: 'v-gamut',
    inputTransfer: 'v-log',
    outputGamut: 'srgb-rec709',
    outputTransfer: 'bt709',
  })
  expect(graph.steps).toContainEqual(
    expect.objectContaining({
      kind: 'lut-output-to-srgb',
      transfer: 'bt709',
      role: 'combined-look-output',
    }),
  )

  return graph
}

function createRealJpegSink() {
  return createWasmJpegRowSink(() =>
    createLumaJpegRuntime({
      workerFactory: () => new CoreBackedJpegWorker() as unknown as Worker,
    }),
  )
}

async function readBlobBytes(blob: Blob) {
  if (typeof blob.arrayBuffer === 'function') {
    return blob.arrayBuffer()
  }

  return new Promise<ArrayBuffer>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as ArrayBuffer)
    reader.onerror = () => reject(reader.error)
    reader.readAsArrayBuffer(blob)
  })
}

function makeJpegOutput(parts: BlobPart[] = []) {
  return createBlobOutputResult({
    filename: 'test.jpg',
    blob: new Blob(parts, { type: 'image/jpeg' }),
  })
}

function readWord(bytes: Uint8Array, offset: number) {
  return (bytes[offset] << 8) | bytes[offset + 1]
}

async function expectBaselineJpeg(
  blob: Blob,
  dimensions: { width: number; height: number },
) {
  const bytes = new Uint8Array(await readBlobBytes(blob))
  let sof0: { width: number; height: number } | undefined
  let offset = 2

  expect(readWord(bytes, 0)).toBe(JPEG_SOI_MARKER)
  expect(readWord(bytes, bytes.length - 2)).toBe(JPEG_EOI_MARKER)

  while (offset < bytes.length - 2) {
    if (bytes[offset] !== JPEG_MARKER_PREFIX) {
      offset += 1
      continue
    }

    const marker = bytes[offset + 1]
    if (marker === JPEG_SOS_MARKER) {
      break
    }

    const segmentLength = readWord(bytes, offset + 2)
    if (marker === JPEG_SOF0_MARKER) {
      sof0 = {
        height: readWord(bytes, offset + 5),
        width: readWord(bytes, offset + 7),
      }
    }
    offset += 2 + segmentLength
  }

  expect(sof0).toEqual(dimensions)
}

describe('full-resolution export real RAW fixtures', () => {
  let restoreFetch: (() => void) | undefined

  beforeAll(() => {
    if (!hasDesktopNativeArtifacts && !hasLowMemoryNativeArtifacts) return

    markCrossOriginIsolated()
    restoreFetch = installFileUrlFetchFallback()
  })

  afterAll(() => {
    restoreFetch?.()
  })

  it.skipIf(!hasDesktopNativeArtifacts)(
    'exports the GFX100RF RAF through the real processed-window path with the V-Log Classic709 LUT',
    async (context) => {
      const { rawPath, lutPath } = await requireGfxExportInputs(context)
      const graph = createResolvedVLogClassic709Graph(
        lutPath,
        await readFile(lutPath, 'utf8'),
      )
      const runtime = createLumaRawRuntime({
        workerFactory: () => new RealNativeWorker() as unknown as Worker,
      })
      const progress: number[] = []
      let finalWrittenRows = 0

      try {
        await runtime.init()
        const session = await runtime.openSession(
          await createFileFromPath(rawPath),
          { maxOutputPixels: 2_500_000 },
        )

        try {
          const capability = await session.probeExportCapability()
          expect(capability.supported, JSON.stringify(capability)).toBe(true)
          expect(capability.strategy).toBe('libraw-processed-window')
          expect(capability.width).toBeGreaterThan(10_000)
          expect(capability.height).toBeGreaterThan(8_000)

          const blob = await materializeOutputBlob(
            await runFullResolutionJpegExport({
              capability,
              graph,
              preferredRows: 512,
              quality: 0.92,
              readProcessedWindow: session.readProcessedWindow,
              onProgress(entry) {
                progress.push(entry.progress)
              },
              writerFactory: () => {
                let writtenRows = 0

                return {
                  async writeRows(rows, rowCount) {
                    expect(rows).toBeInstanceOf(Uint8Array)
                    expect(rows.length).toBe(capability.width * rowCount * 3)
                    writtenRows += rowCount
                  },
                  async close() {
                    expect(writtenRows).toBe(capability.height)
                    finalWrittenRows = writtenRows
                    return makeJpegOutput([new Uint8Array([1])])
                  },
                  async abort() {
                    return undefined
                  },
                }
              },
            }),
          )

          expect(blob.type).toBe('image/jpeg')
          expect(finalWrittenRows).toBe(capability.height)
          expect(progress.at(-1)).toBe(99)
          expect(progress).not.toContain(100)
        } finally {
          session.dispose()
        }
      } finally {
        runtime.dispose()
      }
    },
    900_000,
  )

  it.skipIf(!hasLowMemoryNativeArtifacts)(
    'reads continuous bottom-edge processed windows for the Sony ARW low-memory export profile',
    async (context) => {
      const rawPath = privateFixturePath(context, realExportFixtures.sonyArw)
      const runtime = createLumaRawRuntime({
        workerFactory: () =>
          new RealNativeWorker('low-memory') as unknown as Worker,
      })

      try {
        await runtime.init()
        const session = await runtime.openSession(
          await createFileFromPath(rawPath),
          { maxOutputPixels: 2_500_000 },
        )

        try {
          const capability = await session.probeExportCapability()
          expect(capability.supported, JSON.stringify(capability)).toBe(true)
          expect(capability.strategy).toBe('libraw-processed-window')
          expect(capability.width).toBe(9566)
          expect(capability.height).toBe(6374)

          const stripRows = 128
          const overlapRows = stripRows * 2
          const bottomY = capability.height - stripRows
          const overlapY = capability.height - overlapRows

          const bottomWindow = await session.readProcessedWindow({
            outputRect: {
              x: 0,
              y: bottomY,
              width: capability.width,
              height: stripRows,
            },
            halo: { left: 2, top: 2, right: 2, bottom: 2 },
          })
          const overlapWindow = await session.readProcessedWindow({
            outputRect: {
              x: 0,
              y: overlapY,
              width: capability.width,
              height: overlapRows,
            },
            halo: { left: 2, top: 2, right: 2, bottom: 2 },
          })

          const bottomRows = processedWindowToRgb16Rows(bottomWindow, {
            x: 0,
            y: bottomY,
            width: capability.width,
            height: stripRows,
          })
          const overlapRowsView = processedWindowToRgb16Rows(overlapWindow, {
            x: 0,
            y: overlapY,
            width: capability.width,
            height: overlapRows,
          })

          let maxDelta = 0
          let totalDelta = 0
          let mismatchedSamples = 0
          let comparedSamples = 0

          for (let row = 0; row < stripRows; row += 1) {
            const bottomRow = bottomRows.row(row)
            const overlapRow = overlapRowsView.row(row + stripRows)
            for (let index = 0; index < bottomRow.length; index += 1) {
              const delta = Math.abs(
                (bottomRow[index] ?? 0) - (overlapRow[index] ?? 0),
              )
              if (delta > 0) {
                mismatchedSamples += 1
                totalDelta += delta
                maxDelta = Math.max(maxDelta, delta)
              }
              comparedSamples += 1
            }
          }

          expect({
            comparedSamples,
            mismatchedSamples,
            maxDelta,
            meanMismatchDelta:
              mismatchedSamples === 0 ? 0 : totalDelta / mismatchedSamples,
          }).toEqual({
            comparedSamples: capability.width * stripRows * 3,
            mismatchedSamples: 0,
            maxDelta: 0,
            meanMismatchDelta: 0,
          })
        } finally {
          session.dispose()
        }
      } finally {
        runtime.dispose()
      }
    },
    180_000,
  )

  it.skipIf(!hasDesktopNativeArtifacts)(
    'encodes a representative GFX100RF RAF export region through the real JPEG row sink',
    async (context) => {
      const { rawPath, lutPath } = await requireGfxExportInputs(context)
      const graph = createResolvedVLogClassic709Graph(
        lutPath,
        await readFile(lutPath, 'utf8'),
      )
      const runtime = createLumaRawRuntime({
        workerFactory: () => new RealNativeWorker() as unknown as Worker,
      })

      try {
        await runtime.init()
        const session = await runtime.openSession(
          await createFileFromPath(rawPath),
          { maxOutputPixels: 2_500_000 },
        )

        try {
          const capability = await session.probeExportCapability()
          expect(capability.supported, JSON.stringify(capability)).toBe(true)

          const jpegWidth = 1024
          const jpegHeight = 512
          const blob = await materializeOutputBlob(
            await runFullResolutionJpegExport({
              capability: {
                ...capability,
                width: jpegWidth,
                height: jpegHeight,
              },
              graph,
              preferredRows: 256,
              quality: 0.92,
              readProcessedWindow: session.readProcessedWindow,
              jpegSink: createRealJpegSink(),
            }),
          )

          expect(blob.type).toBe('image/jpeg')
          expect(blob.size).toBeGreaterThan(0)
          await expectBaselineJpeg(blob, {
            width: jpegWidth,
            height: jpegHeight,
          })
        } finally {
          session.dispose()
        }
      } finally {
        runtime.dispose()
      }
    },
    120_000,
  )
})

describe('full-resolution export real fixture inputs', () => {
  const inputs = {
    gfxRaf: 'LUMAFORGE_100MP_RAF',
    sonyArw: 'LUMAFORGE_SONY_ARW',
    vLogLut: 'LUMAFORGE_VLOG_LUT',
  } as const
  const unnamed = () => {
    throw new Error('no local path was named')
  }
  const skipContext = () => {
    const notes: (string | undefined)[] = []
    return {
      notes,
      skip: (note?: string) => {
        notes.push(note)
      },
    }
  }

  it('has no default file for any real-export input', () => {
    const fixtures = resolveRealExportFixtures({ env: {}, exists: unnamed })

    expect(Object.keys(fixtures).sort()).toEqual(Object.keys(inputs).sort())
    for (const [key, envName] of Object.entries(inputs)) {
      const fixture = fixtures[key as keyof typeof inputs]
      expect(fixture).toMatchObject({
        path: null,
        ready: false,
        required: false,
      })
      expect(fixture.reason).toContain(envName)

      const context = skipContext()
      expect(() => privateFixturePath(context, fixture)).toThrow(fixture.reason)
      expect(context.notes).toEqual([fixture.reason])
    }
  })

  it('fails unset inputs in the required-private mode', () => {
    const fixtures = resolveRealExportFixtures({
      env: { LUMAFORGE_REQUIRE_PRIVATE_FIXTURES: '1' },
      exists: unnamed,
    })

    for (const [key, envName] of Object.entries(inputs)) {
      const fixture = fixtures[key as keyof typeof inputs]
      expect(fixture).toMatchObject({
        path: null,
        ready: false,
        required: true,
      })
      expect(fixture.reason).toContain('LUMAFORGE_REQUIRE_PRIVATE_FIXTURES')
      expect(fixture.reason).toContain(envName)

      const context = skipContext()
      expect(() => privateFixturePath(context, fixture)).toThrow(fixture.reason)
      expect(context.notes).toEqual([])
    }
  })

  it('fails a named input that does not exist instead of skipping', () => {
    const env = Object.fromEntries(
      Object.values(inputs).map((envName) => [
        envName,
        `/nonexistent/${envName}`,
      ]),
    )
    const fixtures = resolveRealExportFixtures({ env, exists: () => false })

    for (const [key, envName] of Object.entries(inputs)) {
      const fixture = fixtures[key as keyof typeof inputs]
      expect(fixture).toMatchObject({
        path: `/nonexistent/${envName}`,
        ready: false,
        required: true,
      })
      expect(fixture.reason).toContain(envName)

      const context = skipContext()
      expect(() => privateFixturePath(context, fixture)).toThrow(fixture.reason)
      expect(context.notes).toEqual([])
    }
  })

  it('runs named inputs, resolving relative paths against the repository root', () => {
    const existing = fileURLToPath(import.meta.url)
    const env = Object.fromEntries(
      Object.values(inputs).map((envName) => [
        envName,
        ' src/lib/export/full-res-export.real.test.ts ',
      ]),
    )
    const fixtures = resolveRealExportFixtures({ env })

    for (const key of Object.keys(inputs)) {
      const fixture = fixtures[key as keyof typeof inputs]
      expect(fixture).toMatchObject({ path: existing, ready: true })
      expect(privateFixturePath(skipContext(), fixture)).toBe(existing)
    }
  })
})
