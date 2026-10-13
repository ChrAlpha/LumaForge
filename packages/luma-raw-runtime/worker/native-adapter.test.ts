import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { createNativeFactory } from './native-adapter'
import type {
  LumaRawNativeDecodeOptions,
  LumaRawNativeOpenSettings,
} from './native-types'

type ProcessorValues = {
  openTimings?: unknown
  metadata?: unknown
  thumbnail?: unknown
  exportCapability?: unknown
  processedWindow?: unknown
  image?: unknown
  onDecodePreview?: (options?: LumaRawNativeDecodeOptions) => void
  onDecodeHq?: (options?: LumaRawNativeDecodeOptions) => void
}

const settings = {
  halfSize: true,
  useCameraWb: true,
  outputColor: 4,
  outputBps: 16,
  noAutoBright: true,
  useAutoWb: false,
  useCameraMatrix: 1,
  bright: 1,
  highlight: 2,
  userQual: 0,
  gamm: [1, 1, 1, 1, 0, 0],
} satisfies LumaRawNativeOpenSettings

function createProcessor(values: ProcessorValues) {
  const image = values.image ?? {
    data: new Uint16Array([1, 2, 3]),
    width: 1,
    height: 1,
  }

  return createNativeFactory({
    LumaRawProcessor: class {
      loadBuffer(_data: Uint8Array) {
        return { copyToWasm: 0 }
      }
      openWithSettings(_settings: LumaRawNativeOpenSettings) {
        return values.openTimings ?? { copyToWasm: 0, librawOpen: 0 }
      }
      readMetadata() {
        return values.metadata ?? {}
      }
      extractThumbnail() {
        return values.thumbnail
      }
      probeExportCapability() {
        return values.exportCapability
      }
      readProcessedWindow(_request: {
        outputRect: {
          x: number
          y: number
          width: number
          height: number
        }
        halo: { left: number; top: number; right: number; bottom: number }
      }) {
        return values.processedWindow
      }
      decodePreview(options?: LumaRawNativeDecodeOptions) {
        values.onDecodePreview?.(options)
        return image
      }
      decodeHq(options?: LumaRawNativeDecodeOptions) {
        values.onDecodeHq?.(options)
        return image
      }
      delete() {}
    },
  }).createProcessor()
}

function createFactoryWithHeap(heap?: Uint8Array) {
  return createNativeFactory({
    ...(heap !== undefined ? { HEAPU8: heap } : {}),
    LumaRawProcessor: class {
      loadBuffer() {
        return { copyToWasm: 0 }
      }
      openWithSettings() {
        return { copyToWasm: 0, librawOpen: 0 }
      }
      readMetadata() {
        return {}
      }
      extractThumbnail() {
        return undefined
      }
      decodePreview() {
        return { data: new Uint16Array([1, 2, 3]), width: 1, height: 1 }
      }
      decodeHq() {
        return { data: new Uint16Array([1, 2, 3]), width: 1, height: 1 }
      }
      delete() {}
    },
  })
}

// The color and orientation facts the native wrapper's
// supportedExportCapability emits for a processed-window source. The test
// below holds this fixture to the wrapper source, so a fact the wrapper stops
// emitting fails here instead of being defaulted by the adapter.
const NATIVE_COLOR_FACTS = {
  whiteBalance: [2.1, 1, 1.4, 1],
  cameraToWorkingRgb: [1.2, -0.1, -0.1, -0.05, 1.1, -0.05, 0, -0.2, 1.2],
  workingSpace: 'linear-prophoto-rgb',
  librawOutputColor: 'prophoto',
  gamma: 'linear',
  cameraWhiteBalanceAppliedByRuntime: true,
  cameraMatrixAppliedByRuntime: true,
} as const

function nativeSupportedCapability(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    supported: true,
    strategy: 'libraw-processed-window',
    width: 3000,
    height: 4000,
    rawWidth: 4024,
    rawHeight: 3024,
    visibleCrop: { x: 12, y: 12, width: 4000, height: 3000 },
    cfa: { pattern: 'rggb', xPhase: 0, yPhase: 0 },
    blackLevel: 512,
    whiteLevel: 16383,
    orientation: {
      code: 6,
      supported: true,
      outputWidth: 3000,
      outputHeight: 4000,
    },
    sensor: {
      layout: 'bayer',
      colorCount: 3,
      cfa: { pattern: 'rggb', xPhase: 0, yPhase: 0 },
      phaseIsWindowLocal: false,
    },
    levels: {
      black: 512,
      white: 16383,
      perChannelBlack: [0, 0, 0, 0],
    },
    windows: { librawProcessed: true },
    diagnostics: {
      make: 'Nikon',
      model: 'Fixture',
      normalizedMake: 'Nikon',
      normalizedModel: 'Fixture',
      librawFilterCode: 0x94949494,
      hasRawImage: true,
      hasColor3Image: false,
      hasColor4Image: false,
      hasXTransTable: false,
      canRepeatCropProcess: true,
      lastLibRawWarningMask: 0,
    },
    color: { ...NATIVE_COLOR_FACTS },
    reasons: [],
    ...overrides,
  }
}

function withoutColorFact(key: keyof typeof NATIVE_COLOR_FACTS) {
  const color: Record<string, unknown> = { ...NATIVE_COLOR_FACTS }
  delete color[key]
  return color
}

describe('native-adapter', () => {
  it('reports wasm heap byte length', () => {
    const factory = createFactoryWithHeap(new Uint8Array(new ArrayBuffer(64)))

    expect(factory.heapBytes?.()).toBe(64)
  })

  it('returns undefined when wasm heap telemetry is unavailable', () => {
    const factory = createFactoryWithHeap()

    expect(factory.heapBytes?.()).toBeUndefined()
  })

  it('preserves zero-length wasm heap byte length', () => {
    const factory = createFactoryWithHeap(new Uint8Array(new ArrayBuffer(0)))

    expect(factory.heapBytes?.()).toBe(0)
  })

  it('normalizes finite DNG baseline exposure metadata', () => {
    const processor = createNativeFactory({
      LumaRawProcessor: class {
        loadBuffer() {
          return { copyToWasm: 0 }
        }
        openWithSettings() {
          return { copyToWasm: 0, librawOpen: 0 }
        }
        readMetadata() {
          return {
            width: 2,
            height: 1,
            baselineExposure: 1.25,
          }
        }
        extractThumbnail() {
          return undefined
        }
        decodePreview() {
          return {
            data: new Uint16Array([1, 2, 3, 4, 5, 6]),
            width: 2,
            height: 1,
          }
        }
        decodeHq() {
          return {
            data: new Uint16Array([1, 2, 3, 4, 5, 6]),
            width: 2,
            height: 1,
          }
        }
        delete() {}
      },
    }).createProcessor()

    expect(processor.readMetadata()).toMatchObject({
      width: 2,
      height: 1,
      baselineExposure: 1.25,
    })
  })

  it('throws when a thumbnail object has malformed data', () => {
    const processor = createProcessor({
      thumbnail: {
        data: [1, 2, 3],
        width: 1,
        height: 1,
        format: 'jpeg',
      },
    })

    expect(() => processor.extractThumbnail()).toThrow(TypeError)
    expect(() => processor.extractThumbnail()).toThrow(
      'Native RAW thumbnail did not return Uint8Array data.',
    )
  })

  it('returns undefined when thumbnail is unavailable', () => {
    const processor = createProcessor({ thumbnail: undefined })

    expect(processor.extractThumbnail()).toBeUndefined()
  })

  it('falls back to an unsupported export capability when raw-window probing is unavailable', () => {
    const processor = createFactoryWithHeap().createProcessor()

    expect(processor.probeExportCapability?.()).toEqual({
      supported: false,
      width: 0,
      height: 0,
      rawWidth: 0,
      rawHeight: 0,
      cfa: { pattern: 'unsupported', xPhase: 0, yPhase: 0 },
      blackLevel: 0,
      whiteLevel: 0,
      orientation: { code: 1, supported: true },
      sensor: {
        layout: 'unknown',
        colorCount: 0,
        cfa: { pattern: 'unsupported', xPhase: 0, yPhase: 0 },
        phaseIsWindowLocal: false,
      },
      windows: { librawProcessed: false },
      diagnostics: {
        hasRawImage: false,
        hasColor3Image: false,
        hasColor4Image: false,
        hasXTransTable: false,
      },
      reasons: ['raw-window-unavailable'],
    })
  })

  it('fails closed when a supported payload lacks a LibRaw processed window', () => {
    const processor = createProcessor({
      exportCapability: {
        supported: true,
        strategy: 'libraw-processed-window',
        width: 4000,
        height: 3000,
        rawWidth: 4024,
        rawHeight: 3024,
        visibleCrop: { x: 12, y: 12, width: 4000, height: 3000 },
        cfa: { pattern: 'rggb', xPhase: 0, yPhase: 0 },
        blackLevel: 512,
        whiteLevel: 16383,
        orientation: { code: 1, supported: true },
        color: { ...NATIVE_COLOR_FACTS },
        windows: { librawProcessed: false },
        diagnostics: {
          hasRawImage: true,
          hasColor3Image: true,
          hasColor4Image: false,
          hasXTransTable: false,
        },
        reasons: [],
      },
    })

    expect(processor.probeExportCapability?.()).toMatchObject({
      supported: false,
      color: { ...NATIVE_COLOR_FACTS },
      windows: { librawProcessed: false },
      reasons: ['processed-window-unavailable'],
    })
  })

  it('preserves unknown native source diagnostics without overclaiming processed windows', () => {
    const processor = createProcessor({
      exportCapability: {
        supported: false,
        width: 4000,
        height: 3000,
        rawWidth: 4024,
        rawHeight: 3024,
        visibleCrop: { x: 12, y: 12, width: 4000, height: 3000 },
        cfa: { pattern: 'unsupported', xPhase: 0, yPhase: 0 },
        blackLevel: 512,
        whiteLevel: 16383,
        orientation: {
          code: 6,
          supported: true,
          outputWidth: 3000,
          outputHeight: 4000,
        },
        sensor: {
          layout: 'unknown',
          colorCount: 3,
          cfa: { pattern: 'unsupported', xPhase: 0, yPhase: 0 },
          phaseIsWindowLocal: false,
        },
        levels: {
          black: 512,
          white: 16383,
          perChannelBlack: [512, 512, 512, 512],
        },
        windows: { librawProcessed: false },
        diagnostics: {
          hasRawImage: false,
          hasColor3Image: false,
          hasColor4Image: false,
          hasXTransTable: false,
          canRepeatCropProcess: false,
        },
        reasons: ['unsupported-sensor-layout'],
      },
    })

    expect(processor.probeExportCapability?.()).toMatchObject({
      supported: false,
      sensor: { layout: 'unknown' },
      windows: { librawProcessed: false },
      diagnostics: {
        hasRawImage: false,
        canRepeatCropProcess: false,
      },
      reasons: expect.arrayContaining(['unsupported-sensor-layout']),
    })
  })

  it('normalizes processed-window payloads', () => {
    const pooled = new Uint16Array([9, 1, 2, 3, 4, 5, 6, 8]).subarray(1, 7)
    const processor = createProcessor({
      processedWindow: {
        rect: { x: 0, y: 2, width: 2, height: 1 },
        workingSpace: 'linear-prophoto-rgb',
        data: pooled,
        width: 2,
        height: 1,
        stride: 6,
        normalized: false,
        orientationApplied: true,
        colorApplied: true,
        warnings: ['clipped'],
      },
    })

    const window = processor.readProcessedWindow?.({
      outputRect: { x: 0, y: 2, width: 2, height: 1 },
      halo: { left: 1, top: 1, right: 1, bottom: 1 },
    })

    expect(window).toEqual({
      rect: { x: 0, y: 2, width: 2, height: 1 },
      workingSpace: 'linear-prophoto-rgb',
      data: new Uint16Array([1, 2, 3, 4, 5, 6]),
      width: 2,
      height: 1,
      stride: 6,
      normalized: false,
      orientationApplied: true,
      colorApplied: true,
      warnings: ['clipped'],
    })
    expect(window?.data.buffer).not.toBe(pooled.buffer)
  })

  it('normalizes processed-window timing payloads', () => {
    const processor = createProcessor({
      processedWindow: {
        rect: { x: 0, y: 2, width: 2, height: 1 },
        workingSpace: 'linear-prophoto-rgb',
        data: new Uint16Array([1, 2, 3, 4, 5, 6]),
        width: 2,
        height: 1,
        stride: 6,
        normalized: false,
        orientationApplied: true,
        colorApplied: true,
        warnings: [],
        timings: {
          setup: 1,
          open: 2,
          unpack: 3,
          process: 4,
          outputCopy: 5,
          orientation: 6,
          total: 21,
        },
      },
    })

    const window = processor.readProcessedWindow?.({
      outputRect: { x: 0, y: 2, width: 2, height: 1 },
      halo: { left: 1, top: 1, right: 1, bottom: 1 },
    })

    expect(window?.timings).toEqual({
      setup: 1,
      open: 2,
      unpack: 3,
      process: 4,
      outputCopy: 5,
      orientation: 6,
      total: 21,
    })
  })

  it('accepts absent processed-window timing payloads', () => {
    const baseWindow = {
      rect: { x: 0, y: 2, width: 2, height: 1 },
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
    const withoutTimings = createProcessor({ processedWindow: baseWindow })
    const nullTimings = createProcessor({
      processedWindow: { ...baseWindow, timings: null },
    })
    const request = {
      outputRect: { x: 0, y: 2, width: 2, height: 1 },
      halo: { left: 1, top: 1, right: 1, bottom: 1 },
    }

    expect(
      withoutTimings.readProcessedWindow?.(request).timings,
    ).toBeUndefined()
    expect(nullTimings.readProcessedWindow?.(request).timings).toBeUndefined()
  })

  it.each([
    ['missing total', { process: 4 }],
    ['negative total', { total: -1 }],
    ['negative optional field', { process: -1, total: 1 }],
    ['infinite optional field', { open: Infinity, total: 1 }],
    ['NaN optional field', { unpack: Number.NaN, total: 1 }],
    ['present invalid optional field', { process: 'bad', total: 1 }],
  ])('rejects %s in processed-window timings', (_label, timings) => {
    const processor = createProcessor({
      processedWindow: {
        rect: { x: 0, y: 2, width: 2, height: 1 },
        workingSpace: 'linear-prophoto-rgb',
        data: new Uint16Array([1, 2, 3, 4, 5, 6]),
        width: 2,
        height: 1,
        stride: 6,
        normalized: false,
        orientationApplied: true,
        colorApplied: true,
        warnings: [],
        timings,
      },
    })

    expect(() =>
      processor.readProcessedWindow?.({
        outputRect: { x: 0, y: 2, width: 2, height: 1 },
        halo: { left: 1, top: 1, right: 1, bottom: 1 },
      }),
    ).toThrow('Native RAW processed-window timings returned invalid')
  })

  it('preserves native receiver when reading processed windows', () => {
    const processor = createNativeFactory({
      LumaRawProcessor: class {
        processedWindow = {
          rect: { x: 0, y: 2, width: 2, height: 1 },
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
        loadBuffer(_data: Uint8Array) {
          return { copyToWasm: 0 }
        }
        openWithSettings(_settings: LumaRawNativeOpenSettings) {
          return {
            copyToWasm: 0,
            librawOpen: 0,
          }
        }
        readMetadata() {
          return {}
        }
        extractThumbnail() {
          return undefined
        }
        readProcessedWindow() {
          return this.processedWindow
        }
        decodePreview() {
          return { data: new Uint16Array([1, 2, 3]), width: 1, height: 1 }
        }
        decodeHq() {
          return { data: new Uint16Array([1, 2, 3]), width: 1, height: 1 }
        }
        delete() {}
      },
    }).createProcessor()

    expect(
      processor.readProcessedWindow?.({
        outputRect: { x: 0, y: 2, width: 2, height: 1 },
        halo: { left: 0, top: 0, right: 0, bottom: 0 },
      }),
    ).toMatchObject({
      rect: { x: 0, y: 2, width: 2, height: 1 },
      workingSpace: 'linear-prophoto-rgb',
    })
  })

  it('omits processed-window access when native processor does not expose it', () => {
    const processor = createNativeFactory({
      LumaRawProcessor: class {
        loadBuffer(_data: Uint8Array) {
          return { copyToWasm: 0 }
        }
        openWithSettings(_settings: LumaRawNativeOpenSettings) {
          return {
            copyToWasm: 0,
            librawOpen: 0,
          }
        }
        readMetadata() {
          return {}
        }
        extractThumbnail() {
          return undefined
        }
        decodePreview() {
          return { data: new Uint16Array([1, 2, 3]), width: 1, height: 1 }
        }
        decodeHq() {
          return { data: new Uint16Array([1, 2, 3]), width: 1, height: 1 }
        }
        delete() {}
      },
    }).createProcessor()

    expect('readProcessedWindow' in processor).toBe(false)
    expect(processor.readProcessedWindow).toBeUndefined()
  })

  it('rejects malformed processed-window payloads', () => {
    const malformed = createProcessor({
      processedWindow: {
        rect: { x: 0, y: 0, width: 2, height: 1 },
        workingSpace: 'linear-prophoto-rgb',
        data: new Uint16Array([1, 2, 3]),
        width: 2,
        height: 1,
        stride: 6,
        normalized: false,
        orientationApplied: true,
        colorApplied: true,
        warnings: [],
      },
    })

    expect(() =>
      malformed.readProcessedWindow?.({
        outputRect: { x: 0, y: 0, width: 2, height: 1 },
        halo: { left: 0, top: 0, right: 0, bottom: 0 },
      }),
    ).toThrow(
      'Native RAW processed-window data length does not match RGB dimensions.',
    )
  })

  it('rejects padded processed-window RGB16 payloads', () => {
    const padded = createProcessor({
      processedWindow: {
        rect: { x: 0, y: 0, width: 2, height: 1 },
        workingSpace: 'linear-prophoto-rgb',
        data: new Uint16Array([1, 2, 3, 4, 5, 6, 7, 8]),
        width: 2,
        height: 1,
        stride: 8,
        normalized: false,
        orientationApplied: true,
        colorApplied: true,
        warnings: [],
      },
    })

    expect(() =>
      padded.readProcessedWindow?.({
        outputRect: { x: 0, y: 0, width: 2, height: 1 },
        halo: { left: 0, top: 0, right: 0, bottom: 0 },
      }),
    ).toThrow(
      'Native RAW processed-window data length does not match RGB dimensions.',
    )
  })

  it('does not allow native camera white balance to fall back to LibRaw pre_mul', () => {
    const wrapperSource = readFileSync(
      resolve(
        dirname(fileURLToPath(import.meta.url)),
        '..',
        'native',
        'libraw_wrapper.cpp',
      ),
      'utf8',
    )
    const cameraWhiteBalanceSelector = wrapperSource.match(
      /bool selectCameraWhiteBalance[\s\S]*?\n\}\n\nbool buildCameraToWorkingRgb/,
    )?.[0]

    expect(cameraWhiteBalanceSelector).toContain('color.cam_mul')
    expect(cameraWhiteBalanceSelector).not.toContain('color.pre_mul')
  })

  it('documents native camera white balance normalization and fail-closed guards', () => {
    const wrapperSource = readFileSync(
      resolve(
        dirname(fileURLToPath(import.meta.url)),
        '..',
        'native',
        'libraw_wrapper.cpp',
      ),
      'utf8',
    )
    const cameraWhiteBalanceSelector = wrapperSource.match(
      /bool selectCameraWhiteBalance[\s\S]*?\n\}\n\nbool buildCameraToWorkingRgb/,
    )?.[0]

    expect(cameraWhiteBalanceSelector).toContain(
      'const double normalization_scale = raw_multipliers[1]',
    )
    expect(cameraWhiteBalanceSelector).toContain(
      'white_balance[index] = raw_multipliers[index] / normalization_scale',
    )
    expect(cameraWhiteBalanceSelector).not.toContain(
      'std::numeric_limits<double>::infinity()',
    )
    expect(cameraWhiteBalanceSelector).toContain(
      'max_multiplier <= min_multiplier',
    )
    expect(cameraWhiteBalanceSelector).toContain('source[index] <= 0')
  })

  it('normalizes LibRaw CFA color slots before matching Bayer patterns', () => {
    const wrapperSource = readFileSync(
      resolve(
        dirname(fileURLToPath(import.meta.url)),
        '..',
        'native',
        'libraw_wrapper.cpp',
      ),
      'utf8',
    )
    const cfaSelector = wrapperSource.match(
      /int normalizedCfaColor[\s\S]*?\n\}\n\nbool hasBayerRawImage/,
    )?.[0]

    expect(cfaSelector).toContain('processor.imgdata.idata.cdesc[color_index]')
    expect(cfaSelector).toContain("case 'G':")
    expect(cfaSelector).toContain('normalizedFilterColor')
    expect(cfaSelector).toContain(
      'const int top_right = normalizedCfaColor(processor, 0, 1)',
    )
    expect(cfaSelector).not.toContain('const int top_right = processor.COLOR')
  })

  it('keeps native raw unpack idempotent across capability and window reads', () => {
    const wrapperSource = readFileSync(
      resolve(
        dirname(fileURLToPath(import.meta.url)),
        '..',
        'native',
        'libraw_wrapper.cpp',
      ),
      'utf8',
    )
    const probeCapability = wrapperSource.match(
      /val probeExportCapability\(\)[\s\S]*?\n {2}\}\n\n {2}val readRawWindow/,
    )?.[0]
    const readRawWindow = wrapperSource.match(
      /val readRawWindow\(val rect\)[\s\S]*?\n {2}\}\n\n private:/,
    )?.[0]
    const ensureProcessed = wrapperSource.match(
      /void ensureProcessed\(\)[\s\S]*?\n {2}\}\n\n {2}val decodeImage/,
    )?.[0]

    expect(wrapperSource).toContain('bool unpacked_ = false;')
    expect(probeCapability).toContain('ensureUnpacked();')
    expect(readRawWindow).toContain('ensureUnpacked();')
    expect(ensureProcessed).toContain('ensureUnpacked();')
  })

  it('documents the processed-window orientation support boundary', () => {
    const wrapperSource = readFileSync(
      resolve(
        dirname(fileURLToPath(import.meta.url)),
        '..',
        'native',
        'libraw_wrapper.cpp',
      ),
      'utf8',
    )
    const orientationSupport = wrapperSource.match(
      /bool supportsProcessedWindowOrientation\(int code\) \{[\s\S]*?\n\}/,
    )?.[0]
    const orientationObject = wrapperSource.match(
      /val orientationObject\(const libraw_image_sizes_t &sizes\) \{[\s\S]*?\n\}/,
    )?.[0]

    expect(orientationSupport).toContain('normalizedOrientationCode(code)')
    for (const code of ['1', '3', '5', '6', '8']) {
      expect(orientationSupport).toContain(`case ${code}:`)
    }
    expect(orientationSupport).toContain('return false;')
    expect(orientationObject).toContain(
      'supportsProcessedWindowOrientation(normalized_code)',
    )
    expect(orientationObject).not.toContain(
      'orientation.set("supported", true)',
    )
  })

  it('requires processed-window support to include orientation support', () => {
    const wrapperSource = readFileSync(
      resolve(
        dirname(fileURLToPath(import.meta.url)),
        '..',
        'native',
        'libraw_wrapper.cpp',
      ),
      'utf8',
    )
    const processedWindowSupport = wrapperSource.match(
      /bool supportsProcessedWindow\(const libraw_data_t &imgdata\) \{[\s\S]*?\n\}/,
    )?.[0]
    const probeCapability = wrapperSource.match(
      /val probeExportCapability\(\)[\s\S]*?\n {2}\}\n\n {2}val readRawWindow/,
    )?.[0]

    expect(processedWindowSupport).toContain(
      'supportsProcessedWindowOrientation(imgdata.sizes.flip)',
    )
    expect(probeCapability).toContain(
      'if (!supportsProcessedWindowOrientation(sizes.flip))',
    )
    expect(probeCapability).toContain(
      'return unsupportedCapability(imgdata, "unsupported-orientation",',
    )
  })

  it('reports supported capability dimensions in processed output coordinates', () => {
    const wrapperSource = readFileSync(
      resolve(
        dirname(fileURLToPath(import.meta.url)),
        '..',
        'native',
        'libraw_wrapper.cpp',
      ),
      'utf8',
    )
    const supportedCapability = wrapperSource.match(
      /val supportedExportCapability\(const libraw_data_t &imgdata,[\s\S]*?\n\}/,
    )?.[0]

    expect(wrapperSource).toContain('int processedOutputWidth(')
    expect(wrapperSource).toContain('int processedOutputHeight(')
    expect(supportedCapability).toContain(
      'const int output_width = processedOutputWidth(sizes);',
    )
    expect(supportedCapability).toContain(
      'const int output_height = processedOutputHeight(sizes);',
    )
    expect(supportedCapability).toContain(
      'capability.set("width", output_width)',
    )
    expect(supportedCapability).toContain(
      'capability.set("height", output_height)',
    )
    expect(supportedCapability).not.toContain(
      'capability.set("width", sizes.width)',
    )
    expect(supportedCapability).not.toContain(
      'capability.set("height", sizes.height)',
    )
  })

  it('exposes native capability v2 source facts without rejecting runtime-applied orientation', () => {
    const wrapperSource = readFileSync(
      resolve(
        dirname(fileURLToPath(import.meta.url)),
        '..',
        'native',
        'libraw_wrapper.cpp',
      ),
      'utf8',
    )
    const probeCapability = wrapperSource.match(
      /val probeExportCapability\(\)[\s\S]*?\n {2}\}\n\n {2}val readRawWindow/,
    )?.[0]
    const processedWindowSupport = wrapperSource.match(
      /bool supportsProcessedWindow\(const libraw_data_t &imgdata\) \{[\s\S]*?\n\}/,
    )?.[0]
    const repeatableCropSupport = wrapperSource.match(
      /bool supportsRepeatableCropProcess\(const libraw_data_t &imgdata\) \{[\s\S]*?\n\}/,
    )?.[0]
    const colorFactsPosition =
      probeCapability?.indexOf('double camera_white_balance[4]') ?? -1
    const processedWindowFailurePosition =
      probeCapability?.indexOf('if (!supportsProcessedWindow(imgdata))') ?? -1

    expect(wrapperSource).toContain('sensorLayoutObject')
    expect(wrapperSource).toContain('supportsProcessedWindow')
    expect(wrapperSource).toContain('supportsRepeatableCropProcess')
    expect(wrapperSource).toContain('hasColor3Image')
    expect(wrapperSource).toContain('hasColor4Image')
    expect(wrapperSource).toContain(
      'windows.set("librawProcessed", supportsProcessedWindow(imgdata));',
    )
    expect(wrapperSource).toContain(
      'diagnostics.set("canRepeatCropProcess", supportsRepeatableCropProcess(imgdata));',
    )
    expect(processedWindowSupport).toContain(
      'return supportsRepeatableCropProcess(imgdata) &&',
    )
    expect(repeatableCropSupport).not.toContain('return false;')
    expect(wrapperSource).not.toContain('windows.set("librawProcessed", true)')
    expect(wrapperSource).not.toContain(
      'diagnostics.set("canRepeatCropProcess", true)',
    )
    expect(colorFactsPosition).toBeGreaterThan(-1)
    expect(processedWindowFailurePosition).toBeGreaterThan(-1)
    expect(colorFactsPosition).toBeLessThan(processedWindowFailurePosition)
    expect(probeCapability).toContain(
      'return unsupportedCapability(imgdata, "processed-window-unavailable",',
    )
    expect(probeCapability).toContain(
      'return unsupportedCapability(imgdata, "unsupported-orientation",',
    )
  })

  it('documents native LibRaw cropbox processed-window primitives', () => {
    const wrapperSource = readFileSync(
      resolve(
        dirname(fileURLToPath(import.meta.url)),
        '..',
        'native',
        'libraw_wrapper.cpp',
      ),
      'utf8',
    )
    const readProcessedWindow = wrapperSource.match(
      /val readProcessedWindow\(val request\)[\s\S]*?\n {2}\}\n\n private:/,
    )?.[0]

    expect(readProcessedWindow).toContain('params.cropbox')
    expect(readProcessedWindow).toContain(
      'auto crop_processor = std::make_unique<LibRaw>()',
    )
    expect(readProcessedWindow).toContain('crop_processor->open_buffer')
    expect(readProcessedWindow).toContain('crop_processor->dcraw_process()')
    expect(readProcessedWindow).toContain('crop_processor->copy_mem_image')
    expect(readProcessedWindow).not.toContain('processor_.dcraw_process()')
    expect(readProcessedWindow).not.toContain('processor_.copy_mem_image')
    expect(readProcessedWindow).not.toContain(
      'dcraw_make_mem_image(&image_error)',
    )
    expect(wrapperSource).toContain(
      '.function("readProcessedWindow", &LumaRawProcessor::readProcessedWindow)',
    )
  })

  it('fails closed when visible crop exceeds raw bounds', () => {
    const processor = createProcessor({
      exportCapability: {
        supported: true,
        width: 4000,
        height: 3000,
        rawWidth: 4048,
        rawHeight: 3040,
        visibleCrop: { x: 80, y: 20, width: 4000, height: 3000 },
        cfa: { pattern: 'rggb', xPhase: 0, yPhase: 0 },
        blackLevel: 512,
        whiteLevel: 16383,
        orientation: { code: 1, supported: true },
        color: {
          whiteBalance: [2.1, 1, 1.4, 1],
          cameraToWorkingRgb: [1, 0, 0, 0, 1, 0, 0, 0, 1],
          workingSpace: 'linear-prophoto-rgb',
          librawOutputColor: 'prophoto',
          gamma: 'linear',
          cameraWhiteBalanceAppliedByRuntime: true,
          cameraMatrixAppliedByRuntime: true,
        },
        reasons: [],
      },
    })

    expect(processor.probeExportCapability?.()).toMatchObject({
      supported: false,
      reasons: expect.arrayContaining(['missing-visible-crop']),
    })
  })

  it('normalizes export capability CFA, reasons, and phases', () => {
    const processor = createProcessor({
      exportCapability: {
        supported: true,
        width: 6000,
        height: 4000,
        rawWidth: 6048,
        rawHeight: 4024,
        visibleCrop: { x: 24, y: 20, width: 6000, height: 4000 },
        cfa: { pattern: 'invalid', xPhase: -1, yPhase: 9 },
        blackLevel: 512,
        whiteLevel: 16383,
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
        reasons: [
          'unsupported-cfa',
          'compressed-raw-window-unavailable',
          'missing-dimensions',
          'missing-levels',
          'unexpected-native-reason',
        ],
      },
    })

    expect(processor.probeExportCapability?.()).toEqual({
      supported: false,
      width: 6000,
      height: 4000,
      rawWidth: 6048,
      rawHeight: 4024,
      visibleCrop: { x: 24, y: 20, width: 6000, height: 4000 },
      cfa: { pattern: 'unsupported', xPhase: 0, yPhase: 5 },
      blackLevel: 512,
      whiteLevel: 16383,
      orientation: { code: 1, supported: true },
      color: {
        librawOutputColor: 'prophoto',
        gamma: 'linear',
        cameraWhiteBalanceAppliedByRuntime: true,
        cameraMatrixAppliedByRuntime: true,
        whiteBalance: [2, 1, 1.5, 1],
        cameraToWorkingRgb: [1, 0, 0, 0, 1, 0, 0, 0, 1],
        workingSpace: 'linear-prophoto-rgb',
      },
      sensor: {
        layout: 'unknown',
        colorCount: 3,
        cfa: { pattern: 'unsupported', xPhase: 0, yPhase: 5 },
        phaseIsWindowLocal: false,
      },
      levels: { black: 512, white: 16383 },
      windows: { librawProcessed: false },
      diagnostics: {
        hasRawImage: false,
        hasColor3Image: false,
        hasColor4Image: false,
        hasXTransTable: false,
      },
      reasons: [
        'unsupported-cfa',
        'compressed-raw-window-unavailable',
        'missing-dimensions',
        'missing-levels',
        'processed-window-unavailable',
      ],
    })
  })

  it('normalizes JPEG thumbnail dimensions from metadata fallback fields', () => {
    const module = {
      LumaRawProcessor: class {
        loadBuffer() {
          return { copyToWasm: 1 }
        }
        openWithSettings() {
          return { copyToWasm: 0, librawOpen: 2 }
        }
        readMetadata() {
          return {}
        }
        extractThumbnail() {
          return {
            data: new Uint8Array([1, 2, 3]),
            width: 0,
            height: 0,
            thumbWidth: 1616,
            thumbHeight: 1080,
            format: 'jpeg',
          }
        }
        decodePreview() {
          return { data: new Uint16Array([1, 2, 3]), width: 1, height: 1 }
        }
        decodeHq() {
          return { data: new Uint16Array([1, 2, 3]), width: 1, height: 1 }
        }
      },
    }

    const processor = createNativeFactory(module).createProcessor()
    expect(processor.extractThumbnail()).toMatchObject({
      width: 1616,
      height: 1080,
      format: 'jpeg',
    })
  })

  it('throws when thumbnail dimensions are invalid', () => {
    const negativeWidth = createProcessor({
      thumbnail: {
        data: new Uint8Array([1, 2, 3]),
        width: -1,
        height: 1,
        thumbWidth: 1616,
        format: 'jpeg',
      },
    })
    const fractionalFallbackHeight = createProcessor({
      thumbnail: {
        data: new Uint8Array([1, 2, 3]),
        width: 1,
        height: 0,
        thumbHeight: 1080.5,
        format: 'jpeg',
      },
    })

    expect(() => negativeWidth.extractThumbnail()).toThrow(
      'Native RAW thumbnail returned invalid width.',
    )
    expect(() => fractionalFallbackHeight.extractThumbnail()).toThrow(
      'Native RAW thumbnail returned invalid thumbHeight.',
    )
  })

  it('throws when decoded image data is not Uint16Array', () => {
    const processor = createProcessor({
      image: {
        data: new Uint8Array([1, 2, 3]),
        width: 1,
        height: 1,
      },
    })

    expect(() => processor.decodePreview()).toThrow(TypeError)
    expect(() => processor.decodePreview()).toThrow(
      'Native RAW image did not return Uint16Array data.',
    )
  })

  it('throws when decoded image dimensions are not positive integers', () => {
    const zeroWidth = createProcessor({
      image: {
        data: new Uint16Array([1, 2, 3]),
        width: 0,
        height: 1,
      },
    })
    const fractionalHeight = createProcessor({
      image: {
        data: new Uint16Array([1, 2, 3]),
        width: 1,
        height: 1.5,
      },
    })

    expect(() => zeroWidth.decodePreview()).toThrow(
      'Native RAW image returned invalid width.',
    )
    expect(() => fractionalHeight.decodePreview()).toThrow(
      'Native RAW image returned invalid height.',
    )
  })

  it('throws when decoded image data length does not match RGB dimensions', () => {
    const processor = createProcessor({
      image: {
        data: new Uint16Array([1, 2, 3, 4, 5]),
        width: 1,
        height: 2,
      },
    })

    expect(() => processor.decodePreview()).toThrow(TypeError)
    expect(() => processor.decodePreview()).toThrow(
      'Native RAW image data length does not match RGB dimensions.',
    )
  })

  it('normalizes valid thumbnail and image objects', () => {
    const thumbnailData = new Uint8Array([9, 8, 7])
    const imageData = new Uint16Array([1, 2, 3, 4, 5, 6])
    const processor = createProcessor({
      thumbnail: {
        data: thumbnailData,
        width: 3,
        height: 2,
        format: 'jpeg',
      },
      image: {
        data: imageData,
        width: 2,
        height: 1,
      },
    })

    expect(processor.extractThumbnail()).toEqual({
      data: thumbnailData,
      width: 3,
      height: 2,
      format: 'jpeg',
    })
    expect(processor.extractThumbnail()?.data).toBe(thumbnailData)
    expect(processor.decodeHq()).toEqual({
      data: imageData,
      width: 2,
      height: 1,
      bits: 16,
    })
    expect(processor.decodePreview().data).toBe(imageData)
    processor.dispose()
  })

  it('normalizes non-tight thumbnail and image output buffers to owned arrays', () => {
    const thumbnailData = new Uint8Array([8, 9, 1, 2, 3, 7]).subarray(2, 5)
    const imageData = new Uint16Array([8, 9, 1, 2, 3, 7]).subarray(2, 5)
    const processor = createProcessor({
      thumbnail: {
        data: thumbnailData,
        width: 3,
        height: 1,
        format: 'jpeg',
      },
      image: {
        data: imageData,
        width: 1,
        height: 1,
      },
    })

    const thumbnail = processor.extractThumbnail()
    const image = processor.decodePreview()

    expect(thumbnail?.data).toEqual(new Uint8Array([1, 2, 3]))
    expect(thumbnail?.data).not.toBe(thumbnailData)
    expect(thumbnail?.data.buffer).not.toBe(thumbnailData.buffer)
    expect(thumbnail?.data.byteOffset).toBe(0)
    expect(thumbnail?.data.byteLength).toBe(thumbnail?.data.buffer.byteLength)

    expect(image.data).toEqual(new Uint16Array([1, 2, 3]))
    expect(image.data).not.toBe(imageData)
    expect(image.data.buffer).not.toBe(imageData.buffer)
    expect(image.data.byteOffset).toBe(0)
    expect(image.data.byteLength).toBe(image.data.buffer.byteLength)
  })

  it('throws when native output buffers are not transferable ArrayBuffers', () => {
    const thumbnailBuffer = new SharedArrayBuffer(3)
    const imageBuffer = new SharedArrayBuffer(6)
    const thumbnail = createProcessor({
      thumbnail: {
        data: new Uint8Array(thumbnailBuffer),
        width: 3,
        height: 1,
        format: 'jpeg',
      },
    })
    const image = createProcessor({
      image: {
        data: new Uint16Array(imageBuffer),
        width: 1,
        height: 1,
      },
    })

    expect(() => thumbnail.extractThumbnail()).toThrow(
      'Native RAW thumbnail returned data backed by a non-transferable buffer.',
    )
    expect(() => image.decodePreview()).toThrow(
      'Native RAW image returned data backed by a non-transferable buffer.',
    )
  })

  it('normalizes valid open timing objects', () => {
    const processor = createProcessor({
      openTimings: {
        copyToWasm: 7,
        librawOpen: 11,
      },
    })

    expect(processor.openWithSettings(settings)).toEqual({
      copyToWasm: 7,
      librawOpen: 11,
    })
  })

  it('passes decode options to the native processor', () => {
    const options = { maxOutputPixels: 123 }
    let receivedPreviewOptions: LumaRawNativeDecodeOptions | undefined
    let receivedHqOptions: LumaRawNativeDecodeOptions | undefined
    const processor = createProcessor({
      onDecodePreview(nextOptions) {
        receivedPreviewOptions = nextOptions
      },
      onDecodeHq(nextOptions) {
        receivedHqOptions = nextOptions
      },
    })

    expect(processor.decodePreview(options)).toEqual({
      data: new Uint16Array([1, 2, 3]),
      width: 1,
      height: 1,
      bits: 16,
    })
    expect(processor.decodeHq(options)).toEqual({
      data: new Uint16Array([1, 2, 3]),
      width: 1,
      height: 1,
      bits: 16,
    })
    expect(receivedPreviewOptions).toEqual(options)
    expect(receivedPreviewOptions).not.toBe(options)
    expect(receivedHqOptions).toEqual(options)
    expect(receivedHqOptions).not.toBe(options)
  })

  it('omits absent decode maxOutputPixels for uncapped native calls', () => {
    const receivedOptions: Array<LumaRawNativeDecodeOptions | undefined> = []
    const processor = createProcessor({
      onDecodePreview(nextOptions) {
        receivedOptions.push(nextOptions)
      },
      onDecodeHq(nextOptions) {
        receivedOptions.push(nextOptions)
      },
    })

    processor.decodePreview()
    processor.decodePreview({})
    processor.decodeHq({})

    expect(receivedOptions).toEqual([undefined, undefined, undefined])
  })

  it('rejects invalid decode maxOutputPixels before native calls', () => {
    let nativeCallCount = 0
    const processor = createProcessor({
      onDecodePreview() {
        nativeCallCount += 1
      },
      onDecodeHq() {
        nativeCallCount += 1
      },
    })
    const invalidValues = [0, -1, Number.NaN, 1.5, 2_147_483_648]

    for (const maxOutputPixels of invalidValues) {
      expect(() =>
        processor.decodePreview({
          maxOutputPixels,
        } as LumaRawNativeDecodeOptions),
      ).toThrow('Native RAW decode options include invalid maxOutputPixels.')
      expect(() =>
        processor.decodeHq({
          maxOutputPixels,
        } as LumaRawNativeDecodeOptions),
      ).toThrow('Native RAW decode options include invalid maxOutputPixels.')
    }

    expect(nativeCallCount).toBe(0)
  })

  it('rejects malformed open timing objects', () => {
    const negativeTiming = createProcessor({
      openTimings: {
        copyToWasm: -1,
        librawOpen: 11,
      },
    })
    const missingTiming = createProcessor({
      openTimings: {
        copyToWasm: 7,
      },
    })
    const nonObjectTiming = createProcessor({
      openTimings: 12,
    })

    for (const processor of [negativeTiming, missingTiming, nonObjectTiming]) {
      expect(() => processor.openWithSettings(settings)).toThrow(
        'Native RAW openBuffer returned invalid timing data.',
      )
    }
  })
})

describe('native export capability facts', () => {
  it('holds the positive fixture to the facts the native wrapper emits', () => {
    const wrapperSource = readFileSync(
      resolve(
        dirname(fileURLToPath(import.meta.url)),
        '..',
        'native',
        'libraw_wrapper.cpp',
      ),
      'utf8',
    )
    const supportedCapability = wrapperSource.match(
      /val supportedExportCapability\(const libraw_data_t &imgdata,[\s\S]*?\n\}/,
    )?.[0]
    const colorFactKeys = Array.from(
      (supportedCapability ?? '').matchAll(/color_facts\.set\("(\w+)"/g),
      (match) => match[1],
    )

    expect(colorFactKeys.sort()).toEqual(Object.keys(NATIVE_COLOR_FACTS).sort())
    expect(supportedCapability).toContain(
      'color_facts.set("workingSpace", std::string("linear-prophoto-rgb"));',
    )
    expect(supportedCapability).toContain(
      'color_facts.set("librawOutputColor", std::string("prophoto"));',
    )
    expect(supportedCapability).toContain(
      'color_facts.set("gamma", std::string("linear"));',
    )
    expect(supportedCapability).toContain(
      'color_facts.set("cameraWhiteBalanceAppliedByRuntime", true);',
    )
    expect(supportedCapability).toContain(
      'color_facts.set("cameraMatrixAppliedByRuntime", true);',
    )
    expect(supportedCapability).toContain(
      'capability.set("orientation", orientationObject(sizes));',
    )
    expect(wrapperSource).toMatch(
      /val orientationObject\(const libraw_image_sizes_t &sizes\) \{[\s\S]*?orientation\.set\("outputWidth"[\s\S]*?orientation\.set\("outputHeight"/,
    )
  })

  it('accepts the canonical native facts', () => {
    const processor = createProcessor({
      exportCapability: nativeSupportedCapability(),
    })

    expect(processor.probeExportCapability?.()).toEqual(
      nativeSupportedCapability(),
    )
  })

  it.each(
    Object.keys(NATIVE_COLOR_FACTS) as (keyof typeof NATIVE_COLOR_FACTS)[],
  )('refuses a supported capability whose color facts lack %s', (key) => {
    const processor = createProcessor({
      exportCapability: nativeSupportedCapability({
        color: withoutColorFact(key),
      }),
    })
    const capability = processor.probeExportCapability?.()

    expect(capability?.supported).toBe(false)
    expect(capability?.color).toBeUndefined()
    expect(capability?.reasons).toEqual(['missing-color-transform'])
  })

  it.each([
    ['cameraWhiteBalanceAppliedByRuntime', 1],
    ['cameraWhiteBalanceAppliedByRuntime', 'true'],
    ['cameraWhiteBalanceAppliedByRuntime', null],
    ['cameraMatrixAppliedByRuntime', 1],
    ['cameraMatrixAppliedByRuntime', 'true'],
    ['cameraMatrixAppliedByRuntime', null],
  ])('treats %s = %j as an absent fact', (key, value) => {
    const processor = createProcessor({
      exportCapability: nativeSupportedCapability({
        color: { ...NATIVE_COLOR_FACTS, [key]: value },
      }),
    })
    const capability = processor.probeExportCapability?.()

    expect(capability?.supported).toBe(false)
    expect(capability?.color).toBeUndefined()
    expect(capability?.reasons).toEqual(['missing-color-transform'])
  })

  it.each([
    ['cameraWhiteBalanceAppliedByRuntime', 'missing-camera-white-balance'],
    ['cameraMatrixAppliedByRuntime', 'missing-camera-to-output-color'],
  ] as const)(
    'keeps an explicit false %s and refuses the capability',
    (key, reason) => {
      const processor = createProcessor({
        exportCapability: nativeSupportedCapability({
          color: { ...NATIVE_COLOR_FACTS, [key]: false },
        }),
      })
      const capability = processor.probeExportCapability?.()

      expect(capability?.supported).toBe(false)
      expect(capability?.color).toEqual({ ...NATIVE_COLOR_FACTS, [key]: false })
      expect(capability?.reasons).toEqual([reason])
    },
  )

  it('does not read cameraWhiteBalance as whiteBalance', () => {
    const color = withoutColorFact('whiteBalance')
    color.cameraWhiteBalance = [2100, 1000, 1400, 1000]
    const processor = createProcessor({
      exportCapability: nativeSupportedCapability({ color }),
    })
    const capability = processor.probeExportCapability?.()

    expect(capability?.supported).toBe(false)
    expect(capability?.color).toBeUndefined()
    expect(capability?.reasons).toEqual(['missing-color-transform'])
  })

  it.each([
    ['workingSpace', 'prophoto-linear'],
    ['librawOutputColor', 'srgb'],
    ['gamma', 'srgb'],
  ])('refuses %s = %j', (key, value) => {
    const processor = createProcessor({
      exportCapability: nativeSupportedCapability({
        color: { ...NATIVE_COLOR_FACTS, [key]: value },
      }),
    })
    const capability = processor.probeExportCapability?.()

    expect(capability?.supported).toBe(false)
    expect(capability?.color).toBeUndefined()
    expect(capability?.reasons).toEqual(['missing-color-transform'])
  })

  it.each([
    ['non-positive', [2.1, 0, 1.4, 1]],
    ['short', [2.1, 1, 1.4]],
    ['non-finite', [2.1, 1, Number.NaN, 1]],
  ])('refuses a %s whiteBalance', (_label, whiteBalance) => {
    const processor = createProcessor({
      exportCapability: nativeSupportedCapability({
        color: { ...NATIVE_COLOR_FACTS, whiteBalance },
      }),
    })

    expect(processor.probeExportCapability?.()).toMatchObject({
      supported: false,
      reasons: ['missing-color-transform'],
    })
  })

  it.each([
    ['an all-zero', [0, 0, 0, 0, 0, 0, 0, 0, 0]],
    ['a singular', [1, 2, 3, 2, 4, 6, 0, 1, 0]],
  ])('refuses %s cameraToWorkingRgb', (_label, cameraToWorkingRgb) => {
    const processor = createProcessor({
      exportCapability: nativeSupportedCapability({
        color: { ...NATIVE_COLOR_FACTS, cameraToWorkingRgb },
      }),
    })

    expect(processor.probeExportCapability?.()).toMatchObject({
      supported: false,
      reasons: ['missing-color-transform'],
    })
  })

  it.each([
    ['zero width', { width: 0 }, 'missing-dimensions'],
    [
      'a non-finite black level',
      { blackLevel: Number.NaN, levels: undefined },
      'missing-levels',
    ],
  ])('refuses a supported capability with %s', (_label, overrides, reason) => {
    const processor = createProcessor({
      exportCapability: nativeSupportedCapability(overrides),
    })

    expect(processor.probeExportCapability?.()).toMatchObject({
      supported: false,
      reasons: [reason],
    })
  })

  it.each([1, 6])(
    'refuses numeric capability orientation %i and keeps metadata orientation',
    (code) => {
      const processor = createProcessor({
        metadata: { orientation: code },
        exportCapability: nativeSupportedCapability({ orientation: code }),
      })
      const capability = processor.probeExportCapability?.()

      expect(capability?.supported).toBe(false)
      expect(capability?.orientation).toBeUndefined()
      expect(capability?.reasons).toEqual(['unsupported-orientation'])
      expect(processor.readMetadata().orientation).toBe(code)
    },
  )

  it.each([
    ['no orientation facts', undefined],
    ['an unsupported orientation', { code: 6, supported: false }],
  ])('refuses a supported capability with %s', (_label, orientation) => {
    const processor = createProcessor({
      exportCapability: nativeSupportedCapability({ orientation }),
    })

    expect(processor.probeExportCapability?.()).toMatchObject({
      supported: false,
      reasons: ['unsupported-orientation'],
    })
  })
})
