import { describe, expect, it } from 'vitest'

import { LumaRawRuntimeError, normalizeRawRuntimeError } from './errors'
import type {
  LumaRawExportCapability,
  LumaRawFrame,
  LumaRawFullResInputStrategy,
  LumaRawProcessedWindow,
  LumaRawProcessedWindowRequest,
  LumaRawProcessedWindowTimings,
  LumaRawRuntimeInfo,
  LumaRawSensorLayout,
  LumaRawTimings,
  LumaRawWindow,
  LumaRawWindowRect,
} from './types'

describe('luma raw runtime public contract', () => {
  it('describes RGB16 Linear ProPhoto frames', () => {
    const timings: LumaRawTimings = {
      readFile: 3,
      openBuffer: 4,
      process: 12,
      transfer: 2,
      total: 21,
    }

    const frame: LumaRawFrame = {
      jobId: 'job-1',
      sessionId: 'session-1',
      source: 'quick',
      width: 2,
      height: 1,
      data: new Uint16Array([0, 32768, 65535, 1000, 2000, 3000]),
      layout: 'rgb',
      bitDepth: 16,
      colorSpace: 'linear-prophoto-rgb',
      orientation: 1,
      metadata: {
        width: 2,
        height: 1,
        supportLevel: 'experimental',
      },
      timings,
    }

    expect(frame.layout).toBe('rgb')
    expect(frame.bitDepth).toBe(16)
    expect(frame.colorSpace).toBe('linear-prophoto-rgb')
    expect(frame.data.byteLength).toBe(12)
  })

  it('allows optional baseline exposure in public metadata', () => {
    const frame: LumaRawFrame = {
      jobId: 'job-1',
      source: 'quick',
      width: 1,
      height: 1,
      data: new Uint16Array([0, 0, 0]),
      layout: 'rgb',
      bitDepth: 16,
      colorSpace: 'linear-prophoto-rgb',
      orientation: 1,
      metadata: {
        width: 1,
        height: 1,
        baselineExposure: 0.75,
        supportLevel: 'official',
      },
      timings: { total: 1 },
    }

    expect(frame.metadata.baselineExposure).toBe(0.75)
  })

  it('normalizes stable runtime errors', () => {
    const error = new LumaRawRuntimeError(
      'RAW_CROSS_ORIGIN_ISOLATION_REQUIRED',
      'Cross-origin isolation is required for pthread RAW decode.',
    )
    const normalized = normalizeRawRuntimeError(
      error,
      'RAW_WORKER_PROTOCOL_ERROR',
    )
    const wrapped = normalizeRawRuntimeError(
      new Error('unexpected worker failure'),
      'RAW_WORKER_PROTOCOL_ERROR',
    )
    const fallback = normalizeRawRuntimeError(
      'unexpected string failure',
      'RAW_RUNTIME_UNAVAILABLE',
    )

    expect(normalized).toBe(error)
    expect(normalized.name).toBe('LumaRawRuntimeError')
    expect(normalized.code).toBe('RAW_CROSS_ORIGIN_ISOLATION_REQUIRED')
    expect(wrapped.name).toBe('LumaRawRuntimeError')
    expect(wrapped.code).toBe('RAW_WORKER_PROTOCOL_ERROR')
    expect(wrapped.message).toBe('unexpected worker failure')
    expect(fallback.name).toBe('LumaRawRuntimeError')
    expect(fallback.code).toBe('RAW_RUNTIME_UNAVAILABLE')
    expect(fallback.message).toBe('RAW runtime request failed.')
  })

  it('types raw-window export capability payloads', () => {
    const rect: LumaRawWindowRect = { x: 4, y: 6, width: 8, height: 10 }
    const supported: LumaRawExportCapability = {
      supported: true,
      width: 6000,
      height: 4000,
      rawWidth: 6048,
      rawHeight: 4024,
      cfa: { pattern: 'rggb', xPhase: 0, yPhase: 0 },
      blackLevel: 512,
      whiteLevel: 16383,
      orientation: { code: 1, supported: true },
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
    const unsupported: LumaRawExportCapability = {
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
      windows: { librawProcessed: false, rawMosaic: false },
      diagnostics: {
        hasRawImage: false,
        hasColor3Image: false,
        hasColor4Image: false,
        hasXTransTable: false,
      },
      reasons: ['unsupported-cfa'],
    }
    const rawWindow: LumaRawWindow = {
      rect,
      cfa: supported.cfa,
      data: new Uint16Array(rect.width * rect.height),
      blackLevel: supported.blackLevel,
      whiteLevel: supported.whiteLevel,
    }

    expect(supported.supported).toBe(true)
    expect(supported.sensor.layout).toBe('bayer')
    expect(supported.windows.rawMosaic).toBe(true)
    expect(supported.diagnostics.hasRawImage).toBe(true)
    expect(unsupported.supported).toBe(false)
    expect(rawWindow.data.length).toBe(80)
  })

  it('types LibRaw processed-window full-resolution payloads', () => {
    const strategy: LumaRawFullResInputStrategy = 'libraw-processed-window'
    const layout: LumaRawSensorLayout = 'bayer'
    const request: LumaRawProcessedWindowRequest = {
      outputRect: { x: 0, y: 8, width: 4, height: 2 },
      halo: { left: 2, top: 2, right: 2, bottom: 2 },
    }
    const window: LumaRawProcessedWindow = {
      rect: request.outputRect,
      workingSpace: 'linear-prophoto-rgb',
      data: new Uint16Array(
        request.outputRect.width * request.outputRect.height * 3,
      ),
      width: request.outputRect.width,
      height: request.outputRect.height,
      stride: request.outputRect.width * 3,
      normalized: false,
      orientationApplied: true,
      colorApplied: true,
      warnings: [],
    }
    const capability: LumaRawExportCapability = {
      supported: true,
      strategy,
      width: 4,
      height: 10,
      rawWidth: 4,
      rawHeight: 10,
      visibleCrop: { x: 0, y: 0, width: 4, height: 10 },
      cfa: { pattern: 'rggb', xPhase: 0, yPhase: 0 },
      blackLevel: 0,
      whiteLevel: 65535,
      orientation: {
        code: 6,
        supported: true,
        outputWidth: 10,
        outputHeight: 4,
      },
      sensor: {
        layout,
        colorCount: 3,
        cfa: { pattern: 'rggb', xPhase: 0, yPhase: 0 },
        phaseIsWindowLocal: false,
      },
      levels: { black: 0, white: 65535 },
      color: {
        workingSpace: 'linear-prophoto-rgb',
        librawOutputColor: 'prophoto',
        gamma: 'linear',
        cameraWhiteBalanceAppliedByRuntime: true,
        cameraMatrixAppliedByRuntime: true,
      },
      windows: { librawProcessed: true, rawMosaic: false },
      diagnostics: {
        make: 'Nikon',
        model: 'Fixture',
        librawFilterCode: 0x94949494,
        hasRawImage: true,
        hasColor3Image: false,
        hasColor4Image: false,
        hasXTransTable: false,
        canRepeatCropProcess: true,
      },
      reasons: [],
    }

    expect(capability.strategy).toBe(strategy)
    expect(capability.sensor.layout).toBe(layout)
    expect(capability.windows.librawProcessed).toBe(true)
    expect(capability.diagnostics.hasRawImage).toBe(true)
    expect(window.data).toHaveLength(24)
  })

  it('types processed-window export timing payloads', () => {
    const timings: LumaRawProcessedWindowTimings = {
      setup: 1,
      open: 2,
      unpack: 3,
      process: 4,
      outputCopy: 5,
      total: 15,
    }
    const window: LumaRawProcessedWindow = {
      rect: { x: 0, y: 0, width: 1, height: 1 },
      workingSpace: 'linear-prophoto-rgb',
      data: new Uint16Array([1, 2, 3]),
      width: 1,
      height: 1,
      stride: 3,
      normalized: false,
      orientationApplied: true,
      colorApplied: true,
      warnings: [],
      timings,
    }

    expect(window.timings?.process).toBe(4)
  })

  it('reports runtime capabilities without app dependencies', () => {
    const info: LumaRawRuntimeInfo = {
      runtime: 'luma',
      version: '0.1.0',
      simd: true,
      pthreads: true,
      crossOriginIsolated: true,
      memoryTier: 'normal',
      memoryProfile: 'desktop',
      workerPoolSize: 2,
    }

    expect(info.runtime).toBe('luma')
    expect(info.pthreads).toBe(true)
  })
})
