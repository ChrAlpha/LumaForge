import type {
  ExportColorGraphStep,
  SupportedExportColorGraphDescriptor,
} from '@lumaforge/luma-color-runtime'
import {
  CHROMA_CLAMP_HIGH,
  CHROMA_CLAMP_LOW,
  createRowBandProcessor,
  LUT_CONSTANTS_VERSION,
  makeNeutralBand,
  mat3Identity,
  resolveColorBalanceParams,
  SKIN_HUE_CENTER_DEG,
  SKIN_HUE_SIGMA_DEG,
  SKIN_PROTECT_STRENGTH,
  USER_SATURATION_MAX_FACTOR,
  USER_VIBRANCE_MAX_FACTOR,
  VIBRANCE_CHROMA_REF,
} from '@lumaforge/luma-color-runtime'
import type {
  LumaRawExportCapability,
  LumaRawProcessedWindow,
  LumaRawProcessedWindowRequest,
} from '@lumaforge/luma-raw-runtime'
import { processedWindowToLinearProPhotoTile } from '@lumaforge/render-engine'
import type { FullResExportResourceFailure } from '@lumaforge/render-engine/export'
import {
  createWasmJpegRowSink,
  EXPORT_GEOMETRY_MATTE,
  INVALID_EXPORT_GEOMETRY,
  planExportGeometry,
  runFullResolutionJpegExport,
} from '@lumaforge/render-engine/export'

import type { FileBackedOutputResult } from './output-sink'
import { createBlobOutputResult, materializeOutputBlob } from './output-sink'

function makeCapability(
  overrides: Partial<LumaRawExportCapability> = {},
): LumaRawExportCapability {
  return {
    supported: overrides.supported ?? true,
    strategy: overrides.strategy ?? 'libraw-processed-window',
    width: overrides.width ?? 4,
    height: overrides.height ?? 4,
    rawWidth: overrides.rawWidth ?? 4,
    rawHeight: overrides.rawHeight ?? 4,
    visibleCrop:
      'visibleCrop' in overrides
        ? overrides.visibleCrop
        : { x: 0, y: 0, width: 4, height: 4 },
    cfa: overrides.cfa ?? { pattern: 'rggb', xPhase: 0, yPhase: 0 },
    blackLevel: overrides.blackLevel ?? 0,
    whiteLevel: overrides.whiteLevel ?? 255,
    orientation:
      'orientation' in overrides
        ? overrides.orientation
        : { code: 1, supported: true },
    color:
      'color' in overrides
        ? overrides.color
        : {
            workingSpace: 'linear-prophoto-rgb',
            librawOutputColor: 'prophoto',
            gamma: 'linear',
            cameraWhiteBalanceAppliedByRuntime: true,
            cameraMatrixAppliedByRuntime: true,
          },
    sensor: overrides.sensor ?? {
      layout: 'bayer',
      colorCount: 3,
      cfa: { pattern: 'rggb', xPhase: 0, yPhase: 0 },
      phaseIsWindowLocal: false,
    },
    levels: overrides.levels,
    windows: overrides.windows ?? { librawProcessed: true, rawMosaic: false },
    diagnostics: overrides.diagnostics ?? {
      hasRawImage: true,
      hasColor3Image: false,
      hasColor4Image: false,
      hasXTransTable: false,
    },
    reasons: overrides.reasons ?? [],
  }
}

function makeProcessedWindow(
  request: LumaRawProcessedWindowRequest,
  value = 32768,
): LumaRawProcessedWindow {
  return {
    rect: request.outputRect,
    workingSpace: 'linear-prophoto-rgb',
    data: new Uint16Array(
      request.outputRect.width * request.outputRect.height * 3,
    ).fill(value),
    width: request.outputRect.width,
    height: request.outputRect.height,
    stride: request.outputRect.width * 3,
    normalized: false,
    orientationApplied: true,
    colorApplied: true,
    warnings: [],
  }
}

function makePatternedProcessedWindow(
  request: LumaRawProcessedWindowRequest,
): LumaRawProcessedWindow {
  const window = makeProcessedWindow(request, 0)

  for (let row = 0; row < window.height; row += 1) {
    for (let column = 0; column < window.width; column += 1) {
      const index = (row * window.width + column) * 3
      const absoluteRow = request.outputRect.y + row
      const absoluteColumn = request.outputRect.x + column
      window.data[index] =
        10000 + ((absoluteRow * 97 + absoluteColumn * 1009) % 40000)
      window.data[index + 1] =
        12000 + ((absoluteRow * 193 + absoluteColumn * 701) % 38000)
      window.data[index + 2] =
        14000 + ((absoluteRow * 389 + absoluteColumn * 431) % 36000)
    }
  }

  return window
}

function clamp01(value: number) {
  return Math.min(1, Math.max(0, value))
}

function linearToSrgb(value: number) {
  const clamped = Math.max(0, value)
  return clamped <= 0.0031308
    ? clamped * 12.92
    : 1.055 * Math.pow(clamped, 1 / 2.4) - 0.055
}

function concatByteRows(rows: Uint8Array[]) {
  const output = new Uint8Array(
    rows.reduce((total, row) => total + row.length, 0),
  )
  let offset = 0

  for (const row of rows) {
    output.set(row, offset)
    offset += row.length
  }

  return output
}

function makeJpegOutput(parts: BlobPart[] = []) {
  return createBlobOutputResult({
    filename: 'test.jpg',
    blob: new Blob(parts, { type: 'image/jpeg' }),
  })
}

async function runFullResolutionJpegExportBlob(
  input: Parameters<typeof runFullResolutionJpegExport>[0],
) {
  return materializeOutputBlob(await runFullResolutionJpegExport(input))
}

function makeRgbRampLut() {
  const lut = new Float32Array(2 * 2 * 2 * 3)

  for (let blue = 0; blue < 2; blue += 1) {
    for (let green = 0; green < 2; green += 1) {
      for (let red = 0; red < 2; red += 1) {
        const index = ((blue * 2 + green) * 2 + red) * 3
        lut[index] = red
        lut[index + 1] = green
        lut[index + 2] = blue
      }
    }
  }

  return lut
}

const IDENTITY_RAW_RENDER_EXPOSURE_STEP = {
  kind: 'raw-render-exposure' as const,
  ev: 0,
  multiplier: 1,
}

const neutralColorBalance = resolveColorBalanceParams()

function neutralToneSteps(): ExportColorGraphStep[] {
  return [
    {
      kind: 'user-color-balance',
      temperature: neutralColorBalance.userTemperature,
      tint: neutralColorBalance.userTint,
      gain: neutralColorBalance.gain,
      operator: neutralColorBalance.operator,
      luminanceCoefficients: neutralColorBalance.luminanceCoefficients,
    },
    { kind: 'user-exposure', ev: 0, multiplier: 1 },
    {
      kind: 'user-contrast',
      amount: 0,
      factor: 1,
      pivot: 0.18,
      operator: 'linear-prophoto-luminance-scale',
      luminanceCoefficients: [0.2880402, 0.7118741, 0.0000857],
      zeroLuminanceMode: 'return-black',
    },
    {
      kind: 'user-regional-tone',
      highlights: 0,
      shadows: 0,
      whites: 0,
      blacks: 0,
      operator: 'linear-prophoto-log-luminance-regions',
      pivot: 0.18,
      luminanceCoefficients: [0.2880402, 0.7118741, 0.0000857],
      zeroLuminanceMode: 'return-black',
    },
    {
      kind: 'user-saturation',
      operator: 'oklab-chroma-with-skin-protection',
      saturation: 0,
      vibrance: 0,
      satMaxFactor: USER_SATURATION_MAX_FACTOR,
      vibMaxFactor: USER_VIBRANCE_MAX_FACTOR,
      chromaRef: VIBRANCE_CHROMA_REF,
      skinHueCenterDeg: SKIN_HUE_CENTER_DEG,
      skinHueSigmaDeg: SKIN_HUE_SIGMA_DEG,
      skinProtectStrength: SKIN_PROTECT_STRENGTH,
    },
    {
      kind: 'user-selective-color',
      bands: {
        red: makeNeutralBand(),
        orange: makeNeutralBand(),
        yellow: makeNeutralBand(),
        green: makeNeutralBand(),
        aqua: makeNeutralBand(),
        blue: makeNeutralBand(),
        purple: makeNeutralBand(),
        magenta: makeNeutralBand(),
      },
      chromaClampLow: CHROMA_CLAMP_LOW,
      chromaClampHigh: CHROMA_CLAMP_HIGH,
      workingSpace: 'oklab-via-prophoto-d65',
      operator: 'oklch-per-band-shift',
      constantsVersion: LUT_CONSTANTS_VERSION,
    },
  ]
}

describe('runFullResolutionJpegExport', () => {
  it('throws FULL_RES_EXPORT_UNSUPPORTED_SOURCE before opening writer or reading windows', async () => {
    const readProcessedWindow = vi.fn()
    const createSession = vi.fn(() => ({
      writeRows: vi.fn(),
      close: vi.fn(),
      abort: vi.fn(),
    }))
    const jpegSink = {
      createSession,
    }

    await expect(
      runFullResolutionJpegExport({
        capability: makeCapability({ supported: false }),
        graph: {
          supported: true,
          outputGamut: 'srgb-rec709',
          outputTransfer: 'srgb',
          lutProfile: null,
          steps: [
            { kind: 'input-linear-prophoto' },
            IDENTITY_RAW_RENDER_EXPOSURE_STEP,
            ...neutralToneSteps(),
            { kind: 'output-srgb' },
          ],
        },
        readProcessedWindow,
        jpegSink,
      }),
    ).rejects.toThrow('FULL_RES_EXPORT_UNSUPPORTED_SOURCE')

    expect(readProcessedWindow).not.toHaveBeenCalled()
    expect(createSession).not.toHaveBeenCalled()
  })

  it.each([
    ['missing color facts', { color: undefined }],
    [
      'raw-mosaic strategy',
      {
        strategy: 'raw-mosaic-window',
        windows: { librawProcessed: false, rawMosaic: true },
      },
    ],
    [
      'missing processed windows',
      {
        windows: { librawProcessed: false, rawMosaic: true },
      },
    ],
    [
      'unsupported working space',
      {
        color: {
          whiteBalance: [1, 1, 1, 1],
          cameraToWorkingRgb: [1, 0, 0, 0, 1, 0, 0, 0, 1],
          workingSpace: 'display-srgb-preview',
        },
      },
    ],
    [
      'runtime camera white balance not applied',
      {
        color: {
          workingSpace: 'linear-prophoto-rgb',
          librawOutputColor: 'prophoto',
          gamma: 'linear',
          cameraWhiteBalanceAppliedByRuntime: false,
          cameraMatrixAppliedByRuntime: true,
        },
      },
    ],
    [
      'runtime camera matrix not applied',
      {
        color: {
          workingSpace: 'linear-prophoto-rgb',
          librawOutputColor: 'prophoto',
          gamma: 'linear',
          cameraWhiteBalanceAppliedByRuntime: true,
          cameraMatrixAppliedByRuntime: false,
        },
      },
    ],
  ] as Array<[string, Partial<LumaRawExportCapability>]>)(
    'fails closed before scheduling for %s',
    async (_name, overrides) => {
      const readProcessedWindow = vi.fn()
      const createSession = vi.fn(() => ({
        writeRows: vi.fn(),
        close: vi.fn(),
        abort: vi.fn(),
      }))

      await expect(
        runFullResolutionJpegExport({
          capability: makeCapability(overrides),
          graph: {
            supported: true,
            outputGamut: 'srgb-rec709',
            outputTransfer: 'srgb',
            lutProfile: null,
            steps: [
              { kind: 'input-linear-prophoto' },
              IDENTITY_RAW_RENDER_EXPOSURE_STEP,
              ...neutralToneSteps(),
              { kind: 'output-srgb' },
            ],
          },
          readProcessedWindow,
          jpegSink: {
            createSession,
          },
        }),
      ).rejects.toThrow('FULL_RES_EXPORT_UNSUPPORTED_SOURCE')

      expect(readProcessedWindow).not.toHaveBeenCalled()
      expect(createSession).not.toHaveBeenCalled()
    },
  )

  it('reports strip progress and returns the JPEG blob', async () => {
    const progress: number[] = []
    const writtenRows: Array<{ rowCount: number; bytes: Uint8Array }> = []
    const readProcessedWindow = vi.fn(
      (request: LumaRawProcessedWindowRequest) =>
        Promise.resolve(makeProcessedWindow(request)),
    )
    const writer = {
      writeRows: vi.fn(async (bytes: Uint8Array, rowCount: number) => {
        writtenRows.push({ rowCount, bytes: new Uint8Array(bytes) })
      }),
      close: vi.fn(async () => makeJpegOutput([new Uint8Array([1, 2, 3])])),
      abort: vi.fn(async () => undefined),
    }

    const blob = await runFullResolutionJpegExportBlob({
      capability: makeCapability(),
      graph: {
        supported: true,
        outputGamut: 'srgb-rec709',
        outputTransfer: 'srgb',
        lutProfile: null,
        steps: [
          { kind: 'input-linear-prophoto' },
          IDENTITY_RAW_RENDER_EXPOSURE_STEP,
          ...neutralToneSteps(),
          { kind: 'output-srgb' },
        ],
      },
      preferredRows: 2,
      readProcessedWindow,
      writerFactory: () => writer,
      onProgress(entry) {
        progress.push(entry.progress)
      },
    })

    expect(blob.type).toBe('image/jpeg')
    expect(readProcessedWindow).toHaveBeenCalledTimes(1)
    expect(writtenRows.map((entry) => entry.rowCount)).toEqual([2, 2])
    expect(writtenRows.map((entry) => entry.bytes)).toEqual([
      new Uint8Array(4 * 2 * 3).fill(188),
      new Uint8Array(4 * 2 * 3).fill(188),
    ])
    expect(progress.at(-1)).toBe(99)
    expect(progress).not.toContain(100)
  })

  it('keeps completion progress below 100 while the writer output is closing', async () => {
    const progress: number[] = []
    const writer = {
      writeRows: vi.fn(async () => undefined),
      close: vi.fn(async () => {
        expect(progress).not.toContain(100)
        return makeJpegOutput([new Uint8Array([1, 2, 3])])
      }),
      abort: vi.fn(async () => undefined),
    }

    await runFullResolutionJpegExport({
      capability: makeCapability(),
      graph: {
        supported: true,
        outputGamut: 'srgb-rec709',
        outputTransfer: 'srgb',
        lutProfile: null,
        steps: [
          { kind: 'input-linear-prophoto' },
          IDENTITY_RAW_RENDER_EXPOSURE_STEP,
          ...neutralToneSteps(),
          { kind: 'output-srgb' },
        ],
      },
      preferredRows: 2,
      readProcessedWindow: async (request) => makeProcessedWindow(request),
      writerFactory: () => writer,
      onProgress(entry) {
        progress.push(entry.progress)
      },
    })

    expect(writer.close).toHaveBeenCalledTimes(1)
    expect(progress.at(-1)).toBe(99)
    expect(progress).not.toContain(100)
  })

  it('writes row bands that match the same LUT graph applied to the full strip', async () => {
    const outputRect = { x: 0, y: 0, width: 3, height: 130 }
    const graph: SupportedExportColorGraphDescriptor = {
      supported: true,
      outputGamut: 'srgb-rec709',
      outputTransfer: 'srgb',
      lutProfile: null,
      steps: [
        { kind: 'input-linear-prophoto' },
        { kind: 'raw-render-exposure', ev: 0.1375, multiplier: 1.1 },
        ...neutralToneSteps(),
        {
          kind: 'gamut-to-lut-input',
          matrix: mat3Identity(),
          gamut: 'prophoto-rgb',
        },
        { kind: 'encode-lut-transfer', transfer: 'linear', range: 'full' },
        {
          kind: 'lut3d',
          size: 2,
          data: makeRgbRampLut(),
          domainMin: [0.12, 0.12, 0.12],
          domainMax: [0.95, 0.95, 0.95],
        },
        {
          kind: 'lut-output-to-srgb',
          matrix: mat3Identity(),
          transfer: 'linear',
          range: 'full',
          role: 'scene-creative',
          intensity: 0.65,
        },
        { kind: 'output-srgb' },
      ],
    }
    const expectedWindow = makePatternedProcessedWindow({
      outputRect,
      halo: { left: 2, top: 2, right: 2, bottom: 2 },
    })
    const expectedTile = processedWindowToLinearProPhotoTile(
      expectedWindow,
      outputRect,
    )
    const expectedRows = createRowBandProcessor({
      width: outputRect.width,
      rowBandRows: outputRect.height,
      graph,
    }).processFloatRows(expectedTile.data, outputRect.height)
    const writtenRows: Array<{ bytes: Uint8Array; rowCount: number }> = []
    const writer = {
      writeRows: vi.fn(async (bytes: Uint8Array, rowCount: number) => {
        writtenRows.push({ bytes: new Uint8Array(bytes), rowCount })
      }),
      close: vi.fn(async () => makeJpegOutput([new Uint8Array([1])])),
      abort: vi.fn(async () => undefined),
    }

    await runFullResolutionJpegExport({
      capability: makeCapability({
        width: outputRect.width,
        height: outputRect.height,
        rawWidth: outputRect.width,
        rawHeight: outputRect.height,
        visibleCrop: outputRect,
      }),
      graph,
      preferredRows: outputRect.height,
      readProcessedWindow: async (request) =>
        makePatternedProcessedWindow(request),
      writerFactory: () => writer,
    })

    expect(writtenRows.map((entry) => entry.rowCount)).toEqual([64, 64, 2])
    expect(writtenRows.map((entry) => entry.bytes.length)).toEqual([
      64 * outputRect.width * 3,
      64 * outputRect.width * 3,
      2 * outputRect.width * 3,
    ])
    expect(concatByteRows(writtenRows.map((entry) => entry.bytes))).toEqual(
      new Uint8Array(expectedRows),
    )
  })

  it('does not allocate a full-strip Float32 tile while writing row bands', async () => {
    const outputRect = { x: 0, y: 0, width: 3, height: 130 }
    const fullStripSampleCount = outputRect.width * outputRect.height * 3
    const rowBandSampleCount = outputRect.width * 64 * 3
    const allocations: number[] = []
    const OriginalFloat32Array = globalThis.Float32Array
    const Float32ArraySpy = new Proxy(OriginalFloat32Array, {
      construct(target, args, newTarget) {
        if (typeof args[0] === 'number') {
          allocations.push(args[0])
        }

        return Reflect.construct(target, args, newTarget)
      },
    })
    const writtenRows: Array<{ bytes: Uint8Array; rowCount: number }> = []
    const writer = {
      writeRows: vi.fn(async (bytes: Uint8Array, rowCount: number) => {
        writtenRows.push({ bytes: new Uint8Array(bytes), rowCount })
      }),
      close: vi.fn(async () => makeJpegOutput([new Uint8Array([1])])),
      abort: vi.fn(async () => undefined),
    }

    Object.defineProperty(globalThis, 'Float32Array', {
      configurable: true,
      writable: true,
      value: Float32ArraySpy,
    })

    try {
      await runFullResolutionJpegExport({
        capability: makeCapability({
          width: outputRect.width,
          height: outputRect.height,
          rawWidth: outputRect.width,
          rawHeight: outputRect.height,
          visibleCrop: outputRect,
        }),
        graph: {
          supported: true,
          outputGamut: 'srgb-rec709',
          outputTransfer: 'srgb',
          lutProfile: null,
          steps: [
            { kind: 'input-linear-prophoto' },
            IDENTITY_RAW_RENDER_EXPOSURE_STEP,
            ...neutralToneSteps(),
            { kind: 'output-srgb' },
          ],
        },
        preferredRows: outputRect.height,
        readProcessedWindow: async (request) =>
          makePatternedProcessedWindow(request),
        writerFactory: () => writer,
      })
    } finally {
      Object.defineProperty(globalThis, 'Float32Array', {
        configurable: true,
        writable: true,
        value: OriginalFloat32Array,
      })
    }

    expect(writtenRows.map((entry) => entry.rowCount)).toEqual([64, 64, 2])
    expect(allocations).toContain(rowBandSampleCount)
    expect(allocations).not.toContain(fullStripSampleCount)
  })

  it('keeps retained custom-writer row views stable across reusable row bands', async () => {
    const outputRect = { x: 0, y: 0, width: 3, height: 130 }
    const retainedRows: Uint8Array[] = []
    const snapshots: Uint8Array[] = []
    const rowCounts: number[] = []
    const writer = {
      writeRows: vi.fn(async (bytes: Uint8Array, rowCount: number) => {
        retainedRows.push(bytes)
        snapshots.push(new Uint8Array(bytes))
        rowCounts.push(rowCount)
      }),
      close: vi.fn(async () => makeJpegOutput([new Uint8Array([1])])),
      abort: vi.fn(async () => undefined),
    }

    await runFullResolutionJpegExport({
      capability: makeCapability({
        width: outputRect.width,
        height: outputRect.height,
        rawWidth: outputRect.width,
        rawHeight: outputRect.height,
        visibleCrop: outputRect,
      }),
      graph: {
        supported: true,
        outputGamut: 'srgb-rec709',
        outputTransfer: 'srgb',
        lutProfile: null,
        steps: [
          { kind: 'input-linear-prophoto' },
          IDENTITY_RAW_RENDER_EXPOSURE_STEP,
          ...neutralToneSteps(),
          { kind: 'output-srgb' },
        ],
      },
      preferredRows: outputRect.height,
      readProcessedWindow: async (request) =>
        makePatternedProcessedWindow(request),
      writerFactory: () => writer,
    })

    expect(rowCounts).toEqual([64, 64, 2])
    expect(retainedRows).toHaveLength(3)
    expect(new Set(retainedRows.map((row) => row.buffer)).size).toBe(
      retainedRows.length,
    )
    retainedRows.forEach((row, index) => {
      expect(row).toEqual(snapshots[index])
    })
  })

  it('attributes row-band graph processing to color metrics and writes to JPEG metrics', async () => {
    const metrics: unknown[] = []
    const writer = {
      writeRows: vi.fn(async () => undefined),
      close: vi.fn(async () => makeJpegOutput([new Uint8Array([1])])),
      abort: vi.fn(async () => undefined),
    }
    let now = 0
    const nowSpy = vi
      .spyOn(globalThis.performance, 'now')
      .mockImplementation(() => {
        now += 1
        return now
      })

    try {
      await runFullResolutionJpegExport({
        capability: makeCapability(),
        graph: {
          supported: true,
          outputGamut: 'srgb-rec709',
          outputTransfer: 'srgb',
          lutProfile: null,
          steps: [
            { kind: 'input-linear-prophoto' },
            IDENTITY_RAW_RENDER_EXPOSURE_STEP,
            ...neutralToneSteps(),
            { kind: 'output-srgb' },
          ],
        },
        preferredRows: 2,
        readProcessedWindow: async (request) => makeProcessedWindow(request),
        writerFactory: () => writer,
        onMetric(metric) {
          metrics.push(metric)
        },
      })
    } finally {
      nowSpy.mockRestore()
    }

    const stripMetric = metrics.find(
      (metric) => (metric as { kind: string }).kind === 'strip',
    ) as { colorMs: number; jpegWriteMs: number }

    expect(writer.writeRows).toHaveBeenCalledTimes(2)
    expect(stripMetric.colorMs).toBeGreaterThan(1)
    expect(stripMetric.jpegWriteMs).toBeGreaterThan(0)
    expect(stripMetric.colorMs).toBeGreaterThan(stripMetric.jpegWriteMs)
  })

  it('decodes BT.709 LUT output before final sRGB JPEG encoding', async () => {
    const bt709EncodedGray = 0.4090077
    const lut = new Float32Array(2 * 2 * 2 * 3)
    lut.fill(bt709EncodedGray)
    const writtenRows: Array<{ bytes: Uint8Array; rowCount: number }> = []
    const writer = {
      writeRows: vi.fn(async (bytes: Uint8Array, rowCount: number) => {
        writtenRows.push({ bytes: new Uint8Array(bytes), rowCount })
      }),
      close: vi.fn(async () => makeJpegOutput()),
      abort: vi.fn(async () => undefined),
    }

    await runFullResolutionJpegExport({
      capability: makeCapability({
        width: 2,
        height: 1,
        rawWidth: 2,
        rawHeight: 1,
        visibleCrop: { x: 0, y: 0, width: 2, height: 1 },
      }),
      graph: {
        supported: true,
        outputGamut: 'srgb-rec709',
        outputTransfer: 'srgb',
        lutProfile: null,
        steps: [
          { kind: 'input-linear-prophoto' },
          IDENTITY_RAW_RENDER_EXPOSURE_STEP,
          ...neutralToneSteps(),
          {
            kind: 'gamut-to-lut-input',
            matrix: mat3Identity(),
            gamut: 'v-gamut',
          },
          { kind: 'encode-lut-transfer', transfer: 'v-log', range: 'full' },
          {
            kind: 'lut3d',
            size: 2,
            data: lut,
            domainMin: [0, 0, 0],
            domainMax: [1, 1, 1],
          },
          {
            kind: 'lut-output-to-srgb',
            matrix: mat3Identity(),
            transfer: 'bt709',
            range: 'full',
            role: 'combined-look-output',
            intensity: 1,
          },
          { kind: 'output-srgb' },
        ],
      },
      readProcessedWindow: vi.fn((request: LumaRawProcessedWindowRequest) =>
        Promise.resolve(makeProcessedWindow(request, 32768)),
      ),
      writerFactory: () => writer,
    })

    const bt709Linear = Math.pow((bt709EncodedGray + 0.099) / 1.099, 1 / 0.45)
    const expected = Math.round(linearToSrgb(bt709Linear) * 255)
    const encodedByte = Math.round(bt709EncodedGray * 255)

    expect(writtenRows).toHaveLength(1)
    expect(writtenRows[0]?.rowCount).toBe(1)
    expect(writtenRows[0]?.bytes).toHaveLength(6)
    expect(writtenRows[0]?.bytes.slice(0, 3)).toEqual(
      new Uint8Array([expected, expected, expected]),
    )
    expect(writtenRows[0]?.bytes.slice(3, 6)).toEqual(
      new Uint8Array([expected, expected, expected]),
    )
    expect(writtenRows[0]?.bytes[0]).not.toBe(encodedByte)
  })

  it('applies raw render exposure before final sRGB encoding', async () => {
    const writtenRows: Array<{ bytes: Uint8Array }> = []
    const writer = {
      writeRows: vi.fn(async (bytes: Uint8Array) => {
        writtenRows.push({ bytes: new Uint8Array(bytes) })
      }),
      close: vi.fn(async () => makeJpegOutput()),
      abort: vi.fn(async () => undefined),
    }

    await runFullResolutionJpegExport({
      capability: makeCapability(),
      graph: {
        supported: true,
        outputGamut: 'srgb-rec709',
        outputTransfer: 'srgb',
        lutProfile: null,
        steps: [
          { kind: 'input-linear-prophoto' },
          { kind: 'raw-render-exposure', ev: 1, multiplier: 2 },
          ...neutralToneSteps(),
          { kind: 'output-srgb' },
        ],
      },
      readProcessedWindow: vi.fn((request: LumaRawProcessedWindowRequest) =>
        Promise.resolve(makeProcessedWindow(request, 16384)),
      ),
      writerFactory: () => writer,
    })

    const expected = Math.round(linearToSrgb(0.5) * 255)
    const unexposed = Math.round(linearToSrgb(0.25) * 255)

    expect(writtenRows[0]?.bytes[0]).toBe(expected)
    expect(writtenRows[0]?.bytes[0]).not.toBe(unexposed)
  })

  it('applies raw render exposure before scene LUT input and base mixing', async () => {
    const intensity = 0.5
    const lut = new Float32Array(2 * 2 * 2 * 3)
    for (let blue = 0; blue < 2; blue += 1) {
      for (let green = 0; green < 2; green += 1) {
        for (let red = 0; red < 2; red += 1) {
          const index = ((blue * 2 + green) * 2 + red) * 3
          lut[index] = red
          lut[index + 1] = red
          lut[index + 2] = red
        }
      }
    }

    const writtenRows: Array<{ bytes: Uint8Array }> = []
    const writer = {
      writeRows: vi.fn(async (bytes: Uint8Array) => {
        writtenRows.push({ bytes: new Uint8Array(bytes) })
      }),
      close: vi.fn(async () => makeJpegOutput()),
      abort: vi.fn(async () => undefined),
    }

    await runFullResolutionJpegExport({
      capability: makeCapability(),
      graph: {
        supported: true,
        outputGamut: 'srgb-rec709',
        outputTransfer: 'srgb',
        lutProfile: null,
        steps: [
          { kind: 'input-linear-prophoto' },
          { kind: 'raw-render-exposure', ev: 1, multiplier: 2 },
          ...neutralToneSteps(),
          {
            kind: 'gamut-to-lut-input',
            matrix: mat3Identity(),
            gamut: 'prophoto-rgb',
          },
          { kind: 'encode-lut-transfer', transfer: 'linear', range: 'full' },
          {
            kind: 'lut3d',
            size: 2,
            data: lut,
            domainMin: [0, 0, 0],
            domainMax: [0.5, 0.5, 0.5],
          },
          {
            kind: 'lut-output-to-srgb',
            matrix: mat3Identity(),
            transfer: 'linear',
            range: 'full',
            role: 'scene-creative',
            intensity,
          },
          { kind: 'output-srgb' },
        ],
      },
      readProcessedWindow: vi.fn((request: LumaRawProcessedWindowRequest) =>
        Promise.resolve(makeProcessedWindow(request, 16384)),
      ),
      writerFactory: () => writer,
    })

    const unexposedBaseLinear = 16384 / 65535
    const exposedBaseLinear = unexposedBaseLinear * 2
    const expectedLinear =
      exposedBaseLinear + (1 - exposedBaseLinear) * intensity
    const ignoresExposureForLutInput =
      exposedBaseLinear + (0.5 - exposedBaseLinear) * intensity
    const ignoresExposureForBaseMix =
      unexposedBaseLinear + (1 - unexposedBaseLinear) * intensity
    const expected = Math.round(clamp01(linearToSrgb(expectedLinear)) * 255)

    expect(writtenRows[0]?.bytes[0]).toBe(expected)
    expect(writtenRows[0]?.bytes[0]).not.toBe(
      Math.round(clamp01(linearToSrgb(ignoresExposureForLutInput)) * 255),
    )
    expect(writtenRows[0]?.bytes[0]).not.toBe(
      Math.round(clamp01(linearToSrgb(ignoresExposureForBaseMix)) * 255),
    )
  })

  it.each([Infinity, -Infinity, Number.NaN, 0, -1])(
    'fails closed for invalid preferred row count %s before reading processed windows',
    async (preferredRows) => {
      const readProcessedWindow = vi.fn()
      const writer = {
        writeRows: vi.fn(),
        close: vi.fn(),
        abort: vi.fn(async () => undefined),
      }

      await expect(
        runFullResolutionJpegExport({
          capability: makeCapability(),
          graph: {
            supported: true,
            outputGamut: 'srgb-rec709',
            outputTransfer: 'srgb',
            lutProfile: null,
            steps: [
              { kind: 'input-linear-prophoto' },
              IDENTITY_RAW_RENDER_EXPOSURE_STEP,
              ...neutralToneSteps(),
              { kind: 'output-srgb' },
            ],
          },
          preferredRows,
          readProcessedWindow,
          writerFactory: () => writer,
        }),
      ).rejects.toThrow('FULL_RES_EXPORT_INVALID_PREFERRED_ROWS')

      expect(readProcessedWindow).not.toHaveBeenCalled()
      expect(writer.writeRows).not.toHaveBeenCalled()
      expect(writer.abort).not.toHaveBeenCalled()
    },
  )

  it.each([Infinity, -Infinity, Number.NaN, 0, -1])(
    'fails closed for invalid concurrency %s before reading processed windows',
    async (concurrency) => {
      const readProcessedWindow = vi.fn()
      const writer = {
        writeRows: vi.fn(),
        close: vi.fn(),
        abort: vi.fn(async () => undefined),
      }

      await expect(
        runFullResolutionJpegExport({
          capability: makeCapability(),
          graph: {
            supported: true,
            outputGamut: 'srgb-rec709',
            outputTransfer: 'srgb',
            lutProfile: null,
            steps: [
              { kind: 'input-linear-prophoto' },
              IDENTITY_RAW_RENDER_EXPOSURE_STEP,
              ...neutralToneSteps(),
              { kind: 'output-srgb' },
            ],
          },
          concurrency,
          readProcessedWindow,
          writerFactory: () => writer,
        }),
      ).rejects.toThrow('FULL_RES_EXPORT_INVALID_CONCURRENCY')

      expect(readProcessedWindow).not.toHaveBeenCalled()
      expect(writer.writeRows).not.toHaveBeenCalled()
      expect(writer.abort).not.toHaveBeenCalled()
    },
  )

  it('normalizes fractional preferred rows before scheduling processed windows', async () => {
    const writtenRows: number[] = []
    const readProcessedWindow = vi.fn(
      (request: LumaRawProcessedWindowRequest) =>
        Promise.resolve(makeProcessedWindow(request)),
    )
    const writer = {
      writeRows: vi.fn(async (_bytes: Uint8Array, rowCount: number) => {
        writtenRows.push(rowCount)
      }),
      close: vi.fn(async () => makeJpegOutput()),
      abort: vi.fn(async () => undefined),
    }

    await runFullResolutionJpegExport({
      capability: makeCapability({
        height: 130,
        rawHeight: 130,
        visibleCrop: { x: 0, y: 0, width: 4, height: 130 },
      }),
      graph: {
        supported: true,
        outputGamut: 'srgb-rec709',
        outputTransfer: 'srgb',
        lutProfile: null,
        steps: [
          { kind: 'input-linear-prophoto' },
          IDENTITY_RAW_RENDER_EXPOSURE_STEP,
          ...neutralToneSteps(),
          { kind: 'output-srgb' },
        ],
      },
      preferredRows: 64.5,
      readProcessedWindow,
      writerFactory: () => writer,
    })

    expect(
      readProcessedWindow.mock.calls.map(
        ([request]) => request.outputRect.height,
      ),
    ).toEqual([64, 64, 2])
    expect(writtenRows).toEqual([64, 64, 2])
  })

  it('maps full export strips to processed windows and writes requested output rows', async () => {
    const writtenRows: number[] = []
    const readProcessedWindow = vi.fn(
      (request: LumaRawProcessedWindowRequest) =>
        Promise.resolve(makeProcessedWindow(request)),
    )
    const writer = {
      writeRows: vi.fn(async (_bytes: Uint8Array, rowCount: number) => {
        writtenRows.push(rowCount)
      }),
      close: vi.fn(async () => makeJpegOutput()),
      abort: vi.fn(async () => undefined),
    }

    await runFullResolutionJpegExport({
      capability: makeCapability({
        width: 4,
        height: 4,
        rawWidth: 20,
        rawHeight: 30,
        visibleCrop: { x: 5, y: 7, width: 4, height: 4 },
      }),
      graph: {
        supported: true,
        outputGamut: 'srgb-rec709',
        outputTransfer: 'srgb',
        lutProfile: null,
        steps: [
          { kind: 'input-linear-prophoto' },
          IDENTITY_RAW_RENDER_EXPOSURE_STEP,
          ...neutralToneSteps(),
          { kind: 'output-srgb' },
        ],
      },
      preferredRows: 2,
      readProcessedWindow,
      writerFactory: () => writer,
    })

    expect(readProcessedWindow.mock.calls.map(([request]) => request)).toEqual([
      {
        outputRect: { x: 0, y: 0, width: 4, height: 4 },
        halo: { left: 2, top: 2, right: 2, bottom: 2 },
      },
    ])
    expect(writtenRows).toEqual([2, 2])
  })

  it('rejects processed windows whose rect does not match the requested output strip', async () => {
    const readProcessedWindow = vi.fn(
      (request: LumaRawProcessedWindowRequest) =>
        Promise.resolve(
          makeProcessedWindow({
            ...request,
            outputRect: { ...request.outputRect, y: request.outputRect.y + 1 },
          }),
        ),
    )
    const writer = {
      writeRows: vi.fn(),
      close: vi.fn(),
      abort: vi.fn(async () => undefined),
    }

    await expect(
      runFullResolutionJpegExport({
        capability: makeCapability(),
        graph: {
          supported: true,
          outputGamut: 'srgb-rec709',
          outputTransfer: 'srgb',
          lutProfile: null,
          steps: [
            { kind: 'input-linear-prophoto' },
            IDENTITY_RAW_RENDER_EXPOSURE_STEP,
            ...neutralToneSteps(),
            { kind: 'output-srgb' },
          ],
        },
        preferredRows: 2,
        readProcessedWindow,
        writerFactory: () => writer,
      }),
    ).rejects.toThrow('FULL_RES_EXPORT_INVALID_PROCESSED_WINDOW')

    expect(writer.writeRows).not.toHaveBeenCalled()
  })

  it('keeps JPEG writes ordered when concurrency is greater than one', async () => {
    const writtenFirstBytes: number[] = []
    const readOrder: number[] = []
    let releaseFirst!: () => void
    const firstRead = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const writer = {
      writeRows: vi.fn(async (bytes: Uint8Array) => {
        writtenFirstBytes.push(bytes[0] ?? -1)
      }),
      close: vi.fn(async () => makeJpegOutput([new Uint8Array([1])])),
      abort: vi.fn(async () => undefined),
    }

    const exportPromise = runFullResolutionJpegExport({
      capability: makeCapability({
        height: 128,
        rawHeight: 128,
        visibleCrop: { x: 0, y: 0, width: 4, height: 128 },
      }),
      graph: {
        supported: true,
        outputGamut: 'srgb-rec709',
        outputTransfer: 'srgb',
        lutProfile: null,
        steps: [
          { kind: 'input-linear-prophoto' },
          IDENTITY_RAW_RENDER_EXPOSURE_STEP,
          ...neutralToneSteps(),
          { kind: 'output-srgb' },
        ],
      },
      preferredRows: 64,
      concurrency: 2,
      async readProcessedWindow(request) {
        readOrder.push(request.outputRect.y)
        if (request.outputRect.y === 0) {
          await firstRead
          return makeProcessedWindow(request, 0)
        }

        return makeProcessedWindow(request, 65535)
      },
      writerFactory: () => writer,
    })

    await Promise.resolve()
    expect(readOrder).toEqual([0, 64])
    expect(writer.writeRows).not.toHaveBeenCalled()

    releaseFirst()
    await exportPromise

    expect(writtenFirstBytes).toEqual([0, 255])
  })

  it('retries RESOURCE_ALLOCATION_FAILED with smaller strips and preserves JPEG dimensions', async () => {
    const writtenRows: Array<{ rowCount: number; bytes: Uint8Array }> = []
    let failedOnce = false
    const readProcessedWindow = vi.fn(
      (request: LumaRawProcessedWindowRequest) => {
        if (!failedOnce) {
          failedOnce = true
          return Promise.reject(new Error('RESOURCE_ALLOCATION_FAILED'))
        }

        return Promise.resolve(makeProcessedWindow(request))
      },
    )
    const writer = {
      writeRows: vi.fn(async (bytes: Uint8Array, rowCount: number) => {
        writtenRows.push({ rowCount, bytes: new Uint8Array(bytes) })
      }),
      close: vi.fn(async () => makeJpegOutput([new Uint8Array([1, 2, 3])])),
      abort: vi.fn(async () => undefined),
    }

    const blob = await runFullResolutionJpegExportBlob({
      capability: makeCapability({
        height: 256,
        rawHeight: 256,
        visibleCrop: { x: 0, y: 0, width: 4, height: 256 },
      }),
      graph: {
        supported: true,
        outputGamut: 'srgb-rec709',
        outputTransfer: 'srgb',
        lutProfile: null,
        steps: [
          { kind: 'input-linear-prophoto' },
          IDENTITY_RAW_RENDER_EXPOSURE_STEP,
          ...neutralToneSteps(),
          { kind: 'output-srgb' },
        ],
      },
      preferredRows: 256,
      readProcessedWindow,
      writerFactory: () => writer,
    })

    expect(blob.type).toBe('image/jpeg')
    expect(writer.abort).toHaveBeenCalledTimes(1)
    expect(readProcessedWindow).toHaveBeenCalledTimes(3)
    expect(
      readProcessedWindow.mock.calls.map(
        ([request]) => request.outputRect.height,
      ),
    ).toEqual([256, 128, 128])
    expect(writtenRows.map((entry) => entry.rowCount)).toEqual([64, 64, 64, 64])
    expect(
      writtenRows.reduce((total, entry) => total + entry.rowCount, 0),
    ).toBe(256)
    expect(
      writtenRows.map((entry) => entry.bytes.length / (entry.rowCount * 3)),
    ).toEqual([4, 4, 4, 4])
  })

  it('returns file-backed writer output without materializing it', async () => {
    const openBlob = vi.fn(async () => new Blob(['jpeg']))
    const output: FileBackedOutputResult = {
      kind: 'file-backed',
      exportId: 'export-1',
      filename: 'frame.jpg',
      byteLength: 4,
      mimeType: 'image/jpeg',
      openBlob,
    }
    const writer = {
      writeRows: vi.fn(async () => undefined),
      close: vi.fn(async () => output),
      abort: vi.fn(async () => undefined),
    }

    await expect(
      runFullResolutionJpegExport({
        capability: makeCapability(),
        graph: {
          supported: true,
          outputGamut: 'srgb-rec709',
          outputTransfer: 'srgb',
          lutProfile: null,
          steps: [
            { kind: 'input-linear-prophoto' },
            IDENTITY_RAW_RENDER_EXPOSURE_STEP,
            ...neutralToneSteps(),
            { kind: 'output-srgb' },
          ],
        },
        preferredRows: 4,
        readProcessedWindow: async (request) => makeProcessedWindow(request),
        writerFactory: () => writer,
      }),
    ).resolves.toBe(output)
    expect(openBlob).not.toHaveBeenCalled()
  })

  it('cancels stale in-flight strip preparation before resource fallback retry', async () => {
    const events: string[] = []
    let staleReadResolved = false
    const firstWriter = {
      writeRows: vi.fn(async () => undefined),
      close: vi.fn(),
      abort: vi.fn(async () => undefined),
    }
    const secondWriter = {
      writeRows: vi.fn(async () => undefined),
      close: vi.fn(async () => makeJpegOutput([new Uint8Array([1])])),
      abort: vi.fn(async () => undefined),
    }
    const attemptWriters = [firstWriter, secondWriter]
    const readProcessedWindow = vi.fn(
      (
        request: LumaRawProcessedWindowRequest,
        signal?: AbortSignal,
      ): Promise<LumaRawProcessedWindow> => {
        if (request.outputRect.height === 256 && request.outputRect.y === 0) {
          events.push('stale-read-start')

          return new Promise<LumaRawProcessedWindow>((_resolve, reject) => {
            signal?.addEventListener(
              'abort',
              () => {
                events.push('stale-read-aborted')
                reject(new Error('STALE_ATTEMPT_ABORTED'))
              },
              { once: true },
            )

            if (signal?.aborted) {
              events.push('stale-read-aborted')
              reject(new Error('STALE_ATTEMPT_ABORTED'))
            }
          }).then((window) => {
            staleReadResolved = true
            return window
          })
        }

        if (request.outputRect.height === 256 && request.outputRect.y === 256) {
          events.push('resource-error')
          return Promise.reject(new Error('RESOURCE_ALLOCATION_FAILED'))
        }

        events.push(`retry-${request.outputRect.y}`)
        return Promise.resolve(makeProcessedWindow(request))
      },
    )

    const blob = await runFullResolutionJpegExportBlob({
      capability: makeCapability({
        height: 512,
        rawHeight: 512,
        visibleCrop: { x: 0, y: 0, width: 4, height: 512 },
      }),
      graph: {
        supported: true,
        outputGamut: 'srgb-rec709',
        outputTransfer: 'srgb',
        lutProfile: null,
        steps: [
          { kind: 'input-linear-prophoto' },
          IDENTITY_RAW_RENDER_EXPOSURE_STEP,
          ...neutralToneSteps(),
          { kind: 'output-srgb' },
        ],
      },
      preferredRows: 256,
      concurrency: 2,
      readProcessedWindow,
      writerFactory: () => {
        const writer = attemptWriters.shift()
        if (!writer) {
          throw new Error('unexpected writer request')
        }
        return writer
      },
    })

    expect(blob.type).toBe('image/jpeg')
    expect(staleReadResolved).toBe(false)
    expect(events.slice(0, 3)).toEqual([
      'stale-read-start',
      'resource-error',
      'stale-read-aborted',
    ])
    expect(events.indexOf('stale-read-aborted')).toBeLessThan(
      events.indexOf('retry-0'),
    )
    expect(firstWriter.writeRows).not.toHaveBeenCalled()
    expect(firstWriter.abort).toHaveBeenCalledTimes(1)
    expect(secondWriter.writeRows).toHaveBeenCalledTimes(8)
    expect(secondWriter.close).toHaveBeenCalledTimes(1)
    expect(secondWriter.abort).not.toHaveBeenCalled()
  })

  it('surfaces resource failures for caller-managed fresh-worker retry', async () => {
    const writer = {
      writeRows: vi.fn(async () => undefined),
      close: vi.fn(),
      abort: vi.fn(async () => undefined),
    }

    await expect(
      runFullResolutionJpegExport({
        capability: makeCapability({
          height: 512,
          rawHeight: 512,
          visibleCrop: { x: 0, y: 0, width: 4, height: 512 },
        }),
        graph: {
          supported: true,
          outputGamut: 'srgb-rec709',
          outputTransfer: 'srgb',
          lutProfile: null,
          steps: [
            { kind: 'input-linear-prophoto' },
            IDENTITY_RAW_RENDER_EXPOSURE_STEP,
            ...neutralToneSteps(),
            { kind: 'output-srgb' },
          ],
        },
        preferredRows: 256,
        concurrency: 2,
        retryPolicy: 'surface-resource-failure',
        readProcessedWindow: vi
          .fn()
          .mockRejectedValue(new Error('RESOURCE_ALLOCATION_FAILED')),
        writerFactory: () => writer,
      }),
    ).rejects.toMatchObject({
      name: 'FullResExportResourceFailure',
      message: 'FULL_RES_EXPORT_RESOURCE_FAILURE',
      nextRows: 128,
    } satisfies Partial<FullResExportResourceFailure>)

    expect(writer.abort).toHaveBeenCalledTimes(1)
  })

  it('emits a checkpoint after each committed strip', async () => {
    const checkpoints: unknown[] = []
    const writer = {
      writeRows: vi.fn(async () => undefined),
      close: vi.fn(async () => makeJpegOutput([new Uint8Array([1])])),
      abort: vi.fn(async () => undefined),
    }

    await runFullResolutionJpegExport({
      capability: makeCapability({
        height: 130,
        rawHeight: 130,
        visibleCrop: { x: 0, y: 0, width: 4, height: 130 },
      }),
      graph: {
        supported: true,
        outputGamut: 'srgb-rec709',
        outputTransfer: 'srgb',
        lutProfile: null,
        steps: [
          { kind: 'input-linear-prophoto' },
          IDENTITY_RAW_RENDER_EXPOSURE_STEP,
          ...neutralToneSteps(),
          { kind: 'output-srgb' },
        ],
      },
      preferredRows: 64,
      concurrency: 1,
      readProcessedWindow: vi.fn((request: LumaRawProcessedWindowRequest) =>
        Promise.resolve(makeProcessedWindow(request)),
      ),
      writerFactory: () => writer,
      onCheckpoint(entry) {
        checkpoints.push(entry)
      },
    })

    expect(checkpoints).toEqual([
      { completedRowsForDiagnostics: 64, totalRows: 130, stripRows: 64 },
      { completedRowsForDiagnostics: 128, totalRows: 130, stripRows: 64 },
      { completedRowsForDiagnostics: 130, totalRows: 130, stripRows: 64 },
    ])
  })

  it('retries with a fresh writer after a resource failure and emits performance metrics only for the successful attempt', async () => {
    const metrics: unknown[] = []
    const firstWriter = {
      writeRows: vi.fn(async () => undefined),
      close: vi.fn(),
      abort: vi.fn(async () => undefined),
    }
    const secondWriter = {
      writeRows: vi.fn(async () => undefined),
      close: vi.fn(async () => makeJpegOutput([new Uint8Array([1])])),
      abort: vi.fn(async () => undefined),
    }
    const attemptWriters = [firstWriter, secondWriter]
    let callCount = 0
    const readProcessedWindow = vi.fn(
      (request: LumaRawProcessedWindowRequest) => {
        callCount += 1
        if (callCount === 2) {
          return Promise.reject(new Error('RESOURCE_ALLOCATION_FAILED'))
        }

        return Promise.resolve(makeProcessedWindow(request))
      },
    )

    const blob = await runFullResolutionJpegExportBlob({
      capability: makeCapability({
        height: 512,
        rawHeight: 512,
        visibleCrop: { x: 0, y: 0, width: 4, height: 512 },
      }),
      graph: {
        supported: true,
        outputGamut: 'srgb-rec709',
        outputTransfer: 'srgb',
        lutProfile: null,
        steps: [
          { kind: 'input-linear-prophoto' },
          IDENTITY_RAW_RENDER_EXPOSURE_STEP,
          ...neutralToneSteps(),
          { kind: 'output-srgb' },
        ],
      },
      preferredRows: 256,
      concurrency: 3,
      readProcessedWindow,
      writerFactory: () => {
        const writer = attemptWriters.shift()
        if (!writer) {
          throw new Error('unexpected writer request')
        }
        return writer
      },
      onMetric(metric) {
        metrics.push(metric)
      },
    })

    expect(blob.type).toBe('image/jpeg')
    expect(attemptWriters).toHaveLength(0)
    expect(readProcessedWindow).toHaveBeenCalledTimes(6)
    expect(readProcessedWindow.mock.calls[0]?.[0].outputRect.height).toBe(256)
    expect(readProcessedWindow.mock.calls[2]?.[0].outputRect.height).toBe(128)
    expect(readProcessedWindow.mock.calls[5]?.[0].outputRect.height).toBe(128)
    expect(firstWriter.writeRows).toHaveBeenCalledTimes(4)
    expect(firstWriter.abort).toHaveBeenCalledTimes(1)
    expect(firstWriter.close).not.toHaveBeenCalled()
    expect(secondWriter.writeRows).toHaveBeenCalledTimes(8)
    expect(secondWriter.close).toHaveBeenCalledTimes(1)
    expect(secondWriter.abort).not.toHaveBeenCalled()
    expect(metrics.map((metric) => (metric as { kind: string }).kind)).toEqual([
      'strip',
      'strip',
      'strip',
      'strip',
      'summary',
    ])
    expect(
      metrics
        .filter((metric) => (metric as { kind: string }).kind === 'strip')
        .map((metric) => ({
          rows: (metric as { rows: number }).rows,
          totalStrips: (metric as { totalStrips: number }).totalStrips,
        })),
    ).toEqual([
      { rows: 128, totalStrips: 4 },
      { rows: 128, totalStrips: 4 },
      { rows: 128, totalStrips: 4 },
      { rows: 128, totalStrips: 4 },
    ])
    expect(metrics.at(-1)).toMatchObject({
      kind: 'summary',
      stripRows: 128,
      retries: 1,
      concurrency: 1,
    })
  })

  it('emits strip and summary performance metrics without changing output rows', async () => {
    const metrics: unknown[] = []
    const writtenRows: Array<{ rowCount: number; bytes: Uint8Array }> = []
    const writer = {
      writeRows: vi.fn(async (bytes: Uint8Array, rowCount: number) => {
        writtenRows.push({ rowCount, bytes: new Uint8Array(bytes) })
      }),
      close: vi.fn(async () => makeJpegOutput([new Uint8Array([1])])),
      abort: vi.fn(async () => undefined),
    }

    const blob = await runFullResolutionJpegExportBlob({
      capability: makeCapability({
        width: 4,
        height: 128,
        rawHeight: 128,
        visibleCrop: { x: 0, y: 0, width: 4, height: 128 },
      }),
      graph: {
        supported: true,
        outputGamut: 'srgb-rec709',
        outputTransfer: 'srgb',
        lutProfile: null,
        steps: [
          { kind: 'input-linear-prophoto' },
          IDENTITY_RAW_RENDER_EXPOSURE_STEP,
          ...neutralToneSteps(),
          { kind: 'output-srgb' },
        ],
      },
      preferredRows: 64,
      readProcessedWindow: async (request) => makeProcessedWindow(request),
      writerFactory: () => writer,
      onMetric(metric) {
        metrics.push(metric)
      },
    })

    expect(blob.type).toBe('image/jpeg')
    expect(writer.writeRows).toHaveBeenCalledTimes(2)
    expect(writtenRows.map((entry) => entry.rowCount)).toEqual([64, 64])
    expect(
      writtenRows.reduce((total, entry) => total + entry.rowCount, 0),
    ).toBe(128)
    expect(writtenRows.map((entry) => entry.bytes)).toEqual([
      new Uint8Array(4 * 64 * 3).fill(188),
      new Uint8Array(4 * 64 * 3).fill(188),
    ])
    expect(metrics.map((metric) => (metric as { kind: string }).kind)).toEqual([
      'strip',
      'strip',
      'summary',
    ])
    expect(metrics.at(-1)).toMatchObject({
      kind: 'summary',
      concurrency: 2,
    })
  })

  it('retries writer allocation failures and throws FULL_RES_EXPORT_RESOURCE_FAILURE after exhaustion', async () => {
    const readProcessedWindow = vi.fn()
    const writerFactory = vi.fn(() => {
      throw new Error('RESOURCE_ALLOCATION_FAILED')
    })

    await expect(
      runFullResolutionJpegExport({
        capability: makeCapability({
          height: 256,
          rawHeight: 256,
          visibleCrop: { x: 0, y: 0, width: 4, height: 256 },
        }),
        graph: {
          supported: true,
          outputGamut: 'srgb-rec709',
          outputTransfer: 'srgb',
          lutProfile: null,
          steps: [
            { kind: 'input-linear-prophoto' },
            IDENTITY_RAW_RENDER_EXPOSURE_STEP,
            ...neutralToneSteps(),
            { kind: 'output-srgb' },
          ],
        },
        preferredRows: 256,
        readProcessedWindow,
        writerFactory,
      }),
    ).rejects.toThrow('FULL_RES_EXPORT_RESOURCE_FAILURE')

    expect(writerFactory).toHaveBeenCalledTimes(3)
    expect(readProcessedWindow).not.toHaveBeenCalled()
  })

  it('surfaces a browser-build error when JPEG runtime initialization fails', async () => {
    const readProcessedWindow = vi.fn()

    await expect(
      runFullResolutionJpegExport({
        capability: makeCapability(),
        graph: {
          supported: true,
          outputGamut: 'srgb-rec709',
          outputTransfer: 'srgb',
          lutProfile: null,
          steps: [
            { kind: 'input-linear-prophoto' },
            IDENTITY_RAW_RENDER_EXPOSURE_STEP,
            ...neutralToneSteps(),
            { kind: 'output-srgb' },
          ],
        },
        readProcessedWindow,
        jpegSink: createWasmJpegRowSink(() => {
          throw new Error('JPEG_RUNTIME_UNAVAILABLE')
        }),
      }),
    ).rejects.toMatchObject({
      message:
        'Full-resolution JPEG export is not available in this browser build.',
    })

    expect(readProcessedWindow).not.toHaveBeenCalled()
  })

  it('retries wrapped JPEG encoder resource failures with smaller strips', async () => {
    const writtenRows: number[] = []
    let failedOnce = false
    let sessionCount = 0
    const jpegSink = createWasmJpegRowSink(() => ({
      createEncoder() {
        sessionCount += 1
        return {
          async writeRows(_bytes: Uint8Array, rowCount: number) {
            if (!failedOnce) {
              failedOnce = true
              throw new Error('RESOURCE_ALLOCATION_FAILED')
            }
            writtenRows.push(rowCount)
          },
          async finish() {
            return new Blob([new Uint8Array([1, 2, 3])], {
              type: 'image/jpeg',
            })
          },
          abort: vi.fn(),
        }
      },
      dispose: vi.fn(),
    }))

    const blob = await runFullResolutionJpegExportBlob({
      capability: makeCapability({
        height: 256,
        rawHeight: 256,
        visibleCrop: { x: 0, y: 0, width: 4, height: 256 },
      }),
      graph: {
        supported: true,
        outputGamut: 'srgb-rec709',
        outputTransfer: 'srgb',
        lutProfile: null,
        steps: [
          { kind: 'input-linear-prophoto' },
          IDENTITY_RAW_RENDER_EXPOSURE_STEP,
          ...neutralToneSteps(),
          { kind: 'output-srgb' },
        ],
      },
      preferredRows: 256,
      readProcessedWindow: vi.fn((request: LumaRawProcessedWindowRequest) =>
        Promise.resolve(makeProcessedWindow(request)),
      ),
      jpegSink,
    })

    expect(blob.type).toBe('image/jpeg')
    expect(sessionCount).toBe(2)
    expect(writtenRows).toEqual([64, 64, 64, 64])
  })

  it('throws FULL_RES_EXPORT_RESOURCE_FAILURE after exhausting strip retries', async () => {
    const writer = {
      writeRows: vi.fn(),
      close: vi.fn(),
      abort: vi.fn(async () => undefined),
    }
    const readProcessedWindow = vi.fn(() =>
      Promise.reject(new Error('RESOURCE_ALLOCATION_FAILED')),
    )

    await expect(
      runFullResolutionJpegExport({
        capability: makeCapability({
          height: 256,
          rawHeight: 256,
          visibleCrop: { x: 0, y: 0, width: 4, height: 256 },
        }),
        graph: {
          supported: true,
          outputGamut: 'srgb-rec709',
          outputTransfer: 'srgb',
          lutProfile: null,
          steps: [
            { kind: 'input-linear-prophoto' },
            IDENTITY_RAW_RENDER_EXPOSURE_STEP,
            ...neutralToneSteps(),
            { kind: 'output-srgb' },
          ],
        },
        preferredRows: 256,
        readProcessedWindow,
        writerFactory: () => writer,
      }),
    ).rejects.toThrow('FULL_RES_EXPORT_RESOURCE_FAILURE')

    expect(readProcessedWindow).toHaveBeenCalledTimes(3)
    expect(writer.writeRows).not.toHaveBeenCalled()
    expect(writer.abort).toHaveBeenCalledTimes(3)
  })

  it('uses the color graph before writing JPEG rows', async () => {
    const writtenRows: Array<{ rowCount: number; bytes: Uint8Array }> = []
    const readProcessedWindow = vi.fn(
      (request: LumaRawProcessedWindowRequest) =>
        Promise.resolve(makeProcessedWindow(request, 65535)),
    )
    const writer = {
      writeRows: vi.fn(async (bytes: Uint8Array, rowCount: number) => {
        writtenRows.push({ rowCount, bytes: new Uint8Array(bytes) })
      }),
      close: vi.fn(async () => makeJpegOutput()),
      abort: vi.fn(async () => undefined),
    }

    await runFullResolutionJpegExport({
      capability: makeCapability(),
      graph: {
        supported: true,
        outputGamut: 'srgb-rec709',
        outputTransfer: 'srgb',
        lutProfile: null,
        steps: [
          { kind: 'input-linear-prophoto' },
          IDENTITY_RAW_RENDER_EXPOSURE_STEP,
          ...neutralToneSteps(),
          { kind: 'output-srgb' },
        ],
      },
      preferredRows: 2,
      readProcessedWindow,
      writerFactory: () => writer,
    })

    expect(writtenRows.map((entry) => entry.rowCount)).toEqual([2, 2])
    expect(writtenRows[0]?.bytes[0]).toBe(255)
  })

  it('matches scene-referred LUT domain, range, decode, and intensity semantics', async () => {
    const writtenRows: Array<{ rowCount: number; bytes: Uint8Array }> = []
    const legalScale = (940 - 64) / 1023
    const legalOffset = 64 / 1023
    const domainMin = 0.25
    const domainMax = 0.75
    const intensity = 0.25
    const lut = new Float32Array(2 * 2 * 2 * 3)

    for (let blue = 0; blue < 2; blue += 1) {
      for (let green = 0; green < 2; green += 1) {
        for (let red = 0; red < 2; red += 1) {
          const value = red
          const index = ((blue * 2 + green) * 2 + red) * 3
          lut[index] = value
          lut[index + 1] = value
          lut[index + 2] = value
        }
      }
    }

    const writer = {
      writeRows: vi.fn(async (bytes: Uint8Array, rowCount: number) => {
        writtenRows.push({ rowCount, bytes: new Uint8Array(bytes) })
      }),
      close: vi.fn(async () => makeJpegOutput()),
      abort: vi.fn(async () => undefined),
    }

    await runFullResolutionJpegExport({
      capability: makeCapability(),
      graph: {
        supported: true,
        outputGamut: 'srgb-rec709',
        outputTransfer: 'srgb',
        lutProfile: null,
        steps: [
          { kind: 'input-linear-prophoto' },
          IDENTITY_RAW_RENDER_EXPOSURE_STEP,
          ...neutralToneSteps(),
          {
            kind: 'gamut-to-lut-input',
            matrix: mat3Identity(),
            gamut: 'prophoto-rgb',
          },
          {
            kind: 'encode-lut-transfer',
            transfer: 'gamma24',
            range: 'legal',
          },
          {
            kind: 'lut3d',
            size: 2,
            data: lut,
            domainMin: [domainMin, domainMin, domainMin],
            domainMax: [domainMax, domainMax, domainMax],
          },
          {
            kind: 'lut-output-to-srgb',
            matrix: mat3Identity(),
            transfer: 'gamma24',
            range: 'legal',
            role: 'scene-creative',
            intensity,
          },
          { kind: 'output-srgb' },
        ],
      },
      preferredRows: 2,
      readProcessedWindow: vi.fn((request: LumaRawProcessedWindowRequest) =>
        Promise.resolve(makeProcessedWindow(request, 32768)),
      ),
      writerFactory: () => writer,
    })

    const baseLinear = 32768 / 65535
    const lutInputEncoded =
      clamp01(Math.pow(baseLinear, 1 / 2.4)) * legalScale + legalOffset
    const normalized = clamp01(
      (lutInputEncoded - domainMin) / (domainMax - domainMin),
    )
    const lutOutputLinear = Math.max(
      Math.pow((normalized - legalOffset) / legalScale, 2.4),
      0,
    )
    const mixedLinear = baseLinear + (lutOutputLinear - baseLinear) * intensity
    const expectedByte = Math.round(clamp01(linearToSrgb(mixedLinear)) * 255)

    expect(writtenRows.map((entry) => entry.rowCount)).toEqual([2, 2])
    expect(writtenRows[0]?.bytes[0]).toBe(expectedByte)
    expect(writtenRows[0]?.bytes[0]).not.toBe(188)
  })

  it('aborts the writer if strip export fails after writer creation', async () => {
    const writer = {
      writeRows: vi.fn(),
      close: vi.fn(),
      abort: vi.fn(async () => undefined),
    }

    await expect(
      runFullResolutionJpegExport({
        capability: makeCapability(),
        graph: {
          supported: true,
          outputGamut: 'srgb-rec709',
          outputTransfer: 'srgb',
          lutProfile: null,
          steps: [
            { kind: 'input-linear-prophoto' },
            IDENTITY_RAW_RENDER_EXPOSURE_STEP,
            ...neutralToneSteps(),
            { kind: 'output-srgb' },
          ],
        },
        readProcessedWindow: vi
          .fn()
          .mockRejectedValue(new Error('read failed')),
        writerFactory: () => writer,
      }),
    ).rejects.toThrow('read failed')

    expect(writer.abort).toHaveBeenCalledTimes(1)
  })

  it('fails closed for malformed supported graphs instead of falling back to the simple path', async () => {
    const writer = {
      writeRows: vi.fn(),
      close: vi.fn(),
      abort: vi.fn(async () => undefined),
    }

    await expect(
      runFullResolutionJpegExport({
        capability: makeCapability(),
        graph: {
          supported: true,
          outputGamut: 'srgb-rec709',
          outputTransfer: 'srgb',
          lutProfile: null,
          steps: [
            { kind: 'input-linear-prophoto' },
            IDENTITY_RAW_RENDER_EXPOSURE_STEP,
            ...neutralToneSteps(),
            {
              kind: 'lut-output-to-srgb',
              matrix: mat3Identity(),
              transfer: 'srgb',
              range: 'full',
              role: 'scene-creative',
              intensity: 0.5,
            },
            { kind: 'output-srgb' },
          ],
        },
        readProcessedWindow: vi.fn(),
        writerFactory: () => writer,
      }),
    ).rejects.toThrow('FULL_RES_EXPORT_UNSUPPORTED_PIPELINE')

    expect(writer.writeRows).not.toHaveBeenCalled()
    expect(writer.abort).not.toHaveBeenCalled()
  })

  it('fails closed for malformed but complete supported graphs with duplicate steps', async () => {
    const writer = {
      writeRows: vi.fn(),
      close: vi.fn(),
      abort: vi.fn(async () => undefined),
    }

    await expect(
      runFullResolutionJpegExport({
        capability: makeCapability(),
        graph: {
          supported: true,
          outputGamut: 'srgb-rec709',
          outputTransfer: 'srgb',
          lutProfile: null,
          steps: [
            { kind: 'input-linear-prophoto' },
            IDENTITY_RAW_RENDER_EXPOSURE_STEP,
            ...neutralToneSteps(),
            {
              kind: 'gamut-to-lut-input',
              matrix: mat3Identity(),
              gamut: 'prophoto-rgb',
            },
            {
              kind: 'encode-lut-transfer',
              transfer: 'srgb',
              range: 'full',
            },
            {
              kind: 'encode-lut-transfer',
              transfer: 'srgb',
              range: 'full',
            },
            {
              kind: 'lut3d',
              size: 2,
              data: new Float32Array(24),
              domainMin: [0, 0, 0],
              domainMax: [1, 1, 1],
            },
            {
              kind: 'lut-output-to-srgb',
              matrix: mat3Identity(),
              transfer: 'srgb',
              range: 'full',
              role: 'scene-creative',
              intensity: 0.5,
            },
            { kind: 'output-srgb' },
          ],
        },
        readProcessedWindow: vi.fn(),
        writerFactory: () => writer,
      }),
    ).rejects.toThrow('FULL_RES_EXPORT_UNSUPPORTED_PIPELINE')

    expect(writer.writeRows).not.toHaveBeenCalled()
    expect(writer.abort).not.toHaveBeenCalled()
  })
})

describe('runFullResolutionJpegExport with geometry', () => {
  const geometryGraph: SupportedExportColorGraphDescriptor = {
    supported: true,
    outputGamut: 'srgb-rec709',
    outputTransfer: 'srgb',
    lutProfile: null,
    steps: [
      { kind: 'input-linear-prophoto' },
      IDENTITY_RAW_RENDER_EXPOSURE_STEP,
      ...neutralToneSteps(),
      { kind: 'output-srgb' },
    ],
  }

  function collectingWriter() {
    const writtenRows: Array<{ bytes: Uint8Array; rowCount: number }> = []
    const writer = {
      writeRows: vi.fn(async (bytes: Uint8Array, rowCount: number) => {
        writtenRows.push({ bytes: new Uint8Array(bytes), rowCount })
      }),
      close: vi.fn(async () => makeJpegOutput([new Uint8Array([1])])),
      abort: vi.fn(async () => undefined),
    }
    return { writer, writtenRows }
  }

  async function exportWithGeometry(options: {
    size: number
    geometry?: { matrix: number[]; constrainCrop: boolean }
    preferredRows: number
  }) {
    const rect = { x: 0, y: 0, width: options.size, height: options.size }
    const { writer, writtenRows } = collectingWriter()
    let windowReads = 0

    await runFullResolutionJpegExport({
      capability: makeCapability({
        width: options.size,
        height: options.size,
        rawWidth: options.size,
        rawHeight: options.size,
        visibleCrop: rect,
      }),
      graph: geometryGraph,
      preferredRows: options.preferredRows,
      concurrency: 1,
      readProcessedWindow: async (request) => {
        windowReads += 1
        return makePatternedProcessedWindow(request)
      },
      writerFactory: () => writer,
      ...(options.geometry ? { geometry: options.geometry } : {}),
    })

    return {
      bytes: concatByteRows(writtenRows.map((entry) => entry.bytes)),
      rowCounts: writtenRows.map((entry) => entry.rowCount),
      windowReads,
    }
  }

  it('matches the ungeometried export byte for byte under identity geometry', async () => {
    const plain = await exportWithGeometry({ size: 96, preferredRows: 64 })
    const identity = await exportWithGeometry({
      size: 96,
      preferredRows: 64,
      geometry: { matrix: [1, 0, 0, 0, 1, 0, 0, 0, 1], constrainCrop: true },
    })

    // Identity geometry must not perturb a single pixel, otherwise the
    // resample is lying about what it does at rest.
    expect(identity.bytes).toEqual(plain.bytes)
  })

  it('produces the same bytes no matter how the output was tiled', async () => {
    const geometry = {
      matrix: [
        Math.cos(0.15),
        -Math.sin(0.15),
        0.08,
        Math.sin(0.15),
        Math.cos(0.15),
        0.04,
        0,
        0,
        1,
      ],
      constrainCrop: true,
    }
    const coarse = await exportWithGeometry({
      size: 96,
      preferredRows: 256,
      geometry,
    })
    const fine = await exportWithGeometry({
      size: 96,
      preferredRows: 64,
      geometry,
    })

    // Strip height changes the read plan but must not change the photograph.
    // This is what proves the bounded path is exact rather than approximate.
    expect(fine.windowReads).toBeGreaterThan(coarse.windowReads)
    expect(fine.bytes).toEqual(coarse.bytes)
  })

  it('writes the cropped output frame rather than the source frame', async () => {
    const size = 96
    const geometry = {
      matrix: [
        Math.cos(0.3),
        -Math.sin(0.3),
        0.15,
        Math.sin(0.3),
        Math.cos(0.3),
        0.08,
        0,
        0,
        1,
      ],
      constrainCrop: true,
    }
    const planned = planExportGeometry(geometry, {
      width: size,
      height: size,
    })
    const result = await exportWithGeometry({
      size,
      preferredRows: 64,
      geometry,
    })

    expect(planned.outputWidth).toBeLessThan(size)
    expect(result.rowCounts.reduce((total, count) => total + count, 0)).toBe(
      planned.outputHeight,
    )
    expect(result.bytes.length).toBe(
      planned.outputWidth * planned.outputHeight * 3,
    )
  })

  it('mattes the pixels an unconstrained crop leaves without source', async () => {
    const size = 64
    const result = await exportWithGeometry({
      size,
      preferredRows: 64,
      // Slide the frame sideways so the left edge has nothing behind it.
      geometry: {
        matrix: [1, 0, 0.5, 0, 1, 0, 0, 0, 1],
        constrainCrop: false,
      },
    })

    expect(Array.from(result.bytes.subarray(0, 3))).toEqual([
      ...EXPORT_GEOMETRY_MATTE,
    ])
    // The far edge still carries photograph, not matte.
    const lastPixel = result.bytes.subarray((size - 1) * 3, size * 3)
    expect(Array.from(lastPixel)).not.toEqual([...EXPORT_GEOMETRY_MATTE])
  })

  it('fails closed on a geometry that cannot be exported', async () => {
    const { writer } = collectingWriter()
    const readProcessedWindow = vi.fn()

    await expect(
      runFullResolutionJpegExport({
        capability: makeCapability(),
        graph: geometryGraph,
        preferredRows: 2,
        readProcessedWindow,
        writerFactory: () => writer,
        geometry: { matrix: [1, 0, 0, 0, 1, 0, 0, -2, 1], constrainCrop: true },
      }),
    ).rejects.toThrow(INVALID_EXPORT_GEOMETRY)

    // Validation happens before any window is read or any byte is written.
    expect(readProcessedWindow).not.toHaveBeenCalled()
    expect(writer.writeRows).not.toHaveBeenCalled()
  })
})
