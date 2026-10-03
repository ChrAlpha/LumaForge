import type {
  LumaRawExportCapability,
  LumaRawFrame,
  LumaRawRuntime,
  LumaRawRuntimeInfo,
} from '@lumaforge/luma-raw-runtime'
import { JPEG_RUNTIME_UNAVAILABLE_MESSAGE } from '@lumaforge/render-engine/export'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  BOUNDED_HQ_PREVIEW_LOW_MEMORY_MAX_PIXELS,
  BOUNDED_HQ_PREVIEW_MAX_PIXELS,
} from './decoder'
import { disposeLumaRawRuntime } from './luma-runtime-adapter'
import { createRawRuntimeAdapter } from './runtime-adapter'

function makeRuntimeInfo(): LumaRawRuntimeInfo {
  return {
    runtime: 'luma',
    version: '0.1.0',
    simd: true,
    pthreads: true,
    crossOriginIsolated: true,
    memoryTier: 'normal',
    memoryProfile: 'desktop',
    workerPoolSize: 2,
  }
}

function makeFrame(data: Uint16Array): LumaRawFrame {
  return {
    jobId: 'quick-1',
    source: 'quick',
    width: 1,
    height: 1,
    data,
    layout: 'rgb',
    bitDepth: 16,
    colorSpace: 'linear-prophoto-rgb',
    orientation: 1,
    metadata: {
      width: 1,
      height: 1,
      make: 'Sony',
      model: 'A7',
      supportLevel: 'experimental',
    },
    timings: { total: 20 },
  }
}

function makeLumaFrame(source: 'quick' | 'bounded-hq'): LumaRawFrame {
  return {
    jobId: `${source}-1`,
    source,
    width: 1,
    height: 1,
    data: new Uint16Array([0, 32768, 65535]),
    layout: 'rgb' as const,
    bitDepth: 16 as const,
    colorSpace: 'linear-prophoto-rgb' as const,
    orientation: 1,
    metadata: {
      width: 1,
      height: 1,
      supportLevel: 'experimental' as const,
    },
    timings: { total: 1 },
  }
}

function makeCapability(): LumaRawExportCapability {
  return {
    supported: true,
    width: 6240,
    height: 4168,
    rawWidth: 6240,
    rawHeight: 4168,
    visibleCrop: { x: 0, y: 0, width: 6240, height: 4168 },
    cfa: { pattern: 'rggb', xPhase: 0, yPhase: 0 },
    blackLevel: 0,
    whiteLevel: 65535,
    strategy: 'libraw-processed-window',
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
    levels: { black: 0, white: 65535 },
    windows: { librawProcessed: true, rawMosaic: false },
    diagnostics: {
      hasRawImage: true,
      hasColor3Image: false,
      hasColor4Image: false,
      hasXTransTable: false,
    },
    reasons: [],
  }
}

function makeRawMosaicCapability(): LumaRawExportCapability {
  return {
    ...makeCapability(),
    strategy: 'raw-mosaic-window',
    windows: { librawProcessed: false, rawMosaic: true },
  }
}

function makeLumaRuntime(
  dataOrOverrides: Uint16Array | Partial<LumaRawRuntime> = new Uint16Array([
    0, 32768, 65535,
  ]),
) {
  const data =
    dataOrOverrides instanceof Uint16Array
      ? dataOrOverrides
      : new Uint16Array([0, 32768, 65535])
  const overrides =
    dataOrOverrides instanceof Uint16Array ? {} : dataOrOverrides
  const quickFrame = makeFrame(data)

  return {
    runtime: {
      init: vi
        .fn<LumaRawRuntime['init']>()
        .mockResolvedValue(makeRuntimeInfo()),
      probe: vi.fn<LumaRawRuntime['probe']>(),
      extractEmbeddedPreview: vi
        .fn<LumaRawRuntime['extractEmbeddedPreview']>()
        .mockResolvedValue({
          jobId: 'embedded-1',
          source: 'embedded',
          width: 1600,
          height: 1067,
          data: new Uint8Array([1, 2, 3]),
          mimeType: 'image/jpeg',
          colorSpace: 'display-srgb-preview',
          orientation: 1,
          timings: { total: 10 },
        }),
      decodeQuick: vi
        .fn<LumaRawRuntime['decodeQuick']>()
        .mockResolvedValue(quickFrame),
      decodeBoundedHq: vi
        .fn<LumaRawRuntime['decodeBoundedHq']>()
        .mockResolvedValue({
          ...quickFrame,
          jobId: 'bounded-hq-1',
          source: 'bounded-hq',
        }),
      dispose: vi.fn<LumaRawRuntime['dispose']>(),
      openSession: vi.fn<LumaRawRuntime['openSession']>().mockResolvedValue({
        sessionId: 'session-1',
        probe: {
          jobId: 'probe',
          width: 6240,
          height: 4168,
          supportLevel: 'experimental',
          timings: { total: 1 },
        },
        timings: { total: 1 },
        extractEmbeddedPreview: vi.fn().mockResolvedValue(null),
        probeExportCapability: vi.fn().mockResolvedValue(makeCapability()),
        readRawWindow: vi.fn(),
        readProcessedWindow: vi.fn(),
        decodeQuick: vi.fn().mockResolvedValue(makeLumaFrame('quick')),
        decodeBoundedHq: vi.fn().mockResolvedValue(makeLumaFrame('bounded-hq')),
        applyCalibration: vi.fn().mockResolvedValue({ applied: true } as const),
        dispose: vi.fn(),
      }),
      ...overrides,
    } satisfies LumaRawRuntime,
    quickFrame,
  }
}

afterEach(() => {
  disposeLumaRawRuntime()
  vi.clearAllMocks()
})

describe('raw runtime adapter', () => {
  it('uses the luma runtime by default without an env flag', async () => {
    const { runtime } = makeLumaRuntime()
    const adapter = createRawRuntimeAdapter({
      lumaRuntimeFactory: () => runtime,
    })

    await adapter.decodeQuickRaw(new File(['raw'], 'sample.ARW'))

    expect(runtime.init).toHaveBeenCalledTimes(1)
    expect(runtime.decodeQuick).toHaveBeenCalledTimes(1)
  })

  it('returns embedded preview bytes from the default luma runtime', async () => {
    const { runtime } = makeLumaRuntime()
    const adapter = createRawRuntimeAdapter({
      lumaRuntimeFactory: () => runtime,
    })

    const preview = await adapter.extractEmbeddedPreview(
      new File(['raw'], 'sample.ARW'),
    )

    expect(preview).toMatchObject({
      width: 1600,
      height: 1067,
      mimeType: 'image/jpeg',
    })
    expect(preview?.data).toEqual(new Uint8Array([1, 2, 3]))
    expect(runtime.init).toHaveBeenCalledTimes(1)
    expect(runtime.extractEmbeddedPreview).toHaveBeenCalledTimes(1)
  })

  it('preserves RGB16 Linear ProPhoto quick decode data', async () => {
    const quickData = new Uint16Array([0, 32768, 65535])
    const { runtime } = makeLumaRuntime(quickData)
    const adapter = createRawRuntimeAdapter({
      lumaRuntimeFactory: () => runtime,
    })

    const image = await adapter.decodeQuickRaw(new File(['raw'], 'sample.ARW'))

    expect(image.data).toBe(quickData)
    expect(image.data).toBeInstanceOf(Uint16Array)
    expect(image.channels).toBe(3)
    expect(image.bitsPerChannel).toBe(16)
    expect(image.layout).toBe('rgb-u16')
    expect(image.colorSpace).toBe('linear-prophoto-rgb')
    expect(image.source).toBe('quick')
    expect(image.metadata).toMatchObject({
      make: 'Sony',
      model: 'A7',
      width: 1,
      height: 1,
      orientation: 1,
    })
  })

  it('attaches DNG baseline render exposure to decoded images', async () => {
    const frame = makeLumaFrame('quick')
    frame.metadata.baselineExposure = 1
    const { runtime } = makeLumaRuntime({
      decodeQuick: vi.fn().mockResolvedValue(frame),
    })
    const adapter = createRawRuntimeAdapter({
      lumaRuntimeFactory: () => runtime,
    })

    const image = await adapter.decodeQuickRaw(new File(['raw'], 'sample.DNG'))

    expect(image.renderExposure).toEqual({
      ev: 1,
      multiplier: 2,
      source: 'dng-baseline',
    })
  })

  it('attaches statistical render exposure when metadata is missing', async () => {
    const frame = makeLumaFrame('quick')
    frame.metadata.baselineExposure = undefined
    frame.data = new Uint16Array([
      2048, 2048, 2048, 4096, 4096, 4096, 8192, 8192, 8192,
    ])
    frame.width = 3
    frame.height = 1
    const { runtime } = makeLumaRuntime({
      decodeQuick: vi.fn().mockResolvedValue(frame),
    })
    const adapter = createRawRuntimeAdapter({
      lumaRuntimeFactory: () => runtime,
    })

    const image = await adapter.decodeQuickRaw(new File(['raw'], 'sample.RAF'))

    expect(image.renderExposure.source).toBe('image-statistics')
    expect(image.renderExposure.ev).toBeGreaterThan(0)
  })

  it('preserves stable luma runtime error codes', async () => {
    const { runtime } = makeLumaRuntime()
    const runtimeError = Object.assign(
      new Error('Cross-origin isolation is required.'),
      {
        code: 'RAW_CROSS_ORIGIN_ISOLATION_REQUIRED',
      },
    )
    vi.mocked(runtime.init).mockRejectedValue(runtimeError)
    const adapter = createRawRuntimeAdapter({
      lumaRuntimeFactory: () => runtime,
    })

    await expect(
      adapter.decodeQuickRaw(new File(['raw'], 'sample.ARW')),
    ).rejects.toMatchObject({
      code: 'RAW_CROSS_ORIGIN_ISOLATION_REQUIRED',
      message: 'Cross-origin isolation is required.',
    })
  })

  it('opens one luma session and decodes stages without rereading the file', async () => {
    const extractEmbeddedPreview = vi.fn().mockResolvedValue(null)
    const probeExportCapability = vi.fn().mockResolvedValue(makeCapability())
    const decodeQuick = vi.fn().mockResolvedValue(makeLumaFrame('quick'))
    const decodeBoundedHq = vi
      .fn()
      .mockResolvedValue(makeLumaFrame('bounded-hq'))
    const dispose = vi.fn()
    const openSignal = new AbortController().signal
    const stageSignal = new AbortController().signal
    const { runtime } = makeLumaRuntime({
      openSession: vi.fn().mockResolvedValue({
        sessionId: 'session-1',
        probe: {
          jobId: 'probe',
          width: 6240,
          height: 4168,
          supportLevel: 'experimental',
          timings: { total: 1 },
        },
        timings: { total: 1 },
        extractEmbeddedPreview,
        probeExportCapability,
        readRawWindow: vi.fn(),
        readProcessedWindow: vi.fn(),
        decodeQuick,
        decodeBoundedHq,
        applyCalibration: vi.fn().mockResolvedValue({ applied: true } as const),
        dispose,
      }),
    })

    const adapter = createRawRuntimeAdapter({
      lumaRuntimeFactory: () => runtime,
      jpegRuntimeAvailabilityProbe: vi.fn().mockReturnValue(true),
    })

    const file = new File(['raw'], 'sample.ARW')
    const session = await adapter.openSession(file, openSignal)
    await session.extractEmbeddedPreview(stageSignal)
    await session.probeExportCapability?.(stageSignal)
    await session.decodeQuickRaw(undefined, stageSignal)
    await session.decodeBoundedHqRaw(
      { maxOutputPixels: BOUNDED_HQ_PREVIEW_MAX_PIXELS },
      undefined,
      stageSignal,
    )
    session.dispose()

    expect(runtime.openSession).toHaveBeenCalledWith(
      file,
      expect.objectContaining({ maxOutputPixels: expect.any(Number) }),
      openSignal,
    )
    expect(extractEmbeddedPreview).toHaveBeenCalledWith(stageSignal)
    expect(probeExportCapability).toHaveBeenCalledWith(stageSignal)
    expect(decodeQuick).toHaveBeenCalledWith(
      expect.objectContaining({ maxOutputPixels: expect.any(Number) }),
      stageSignal,
    )
    expect(decodeBoundedHq).toHaveBeenCalledWith(
      { maxOutputPixels: BOUNDED_HQ_PREVIEW_MAX_PIXELS },
      stageSignal,
    )
    expect(dispose).toHaveBeenCalledTimes(1)
  })

  it('requests bounded HQ with the configured preview cap through an open session', async () => {
    const decodeBoundedHq = vi
      .fn()
      .mockResolvedValue(makeLumaFrame('bounded-hq'))
    const { runtime } = makeLumaRuntime({
      openSession: vi.fn().mockResolvedValue({
        sessionId: 'raw-session-1',
        probe: {
          jobId: 'probe',
          width: 11662,
          height: 8746,
          supportLevel: 'experimental',
          timings: { total: 1 },
        },
        timings: { total: 1 },
        extractEmbeddedPreview: vi.fn(),
        decodeQuick: vi.fn().mockResolvedValue(makeLumaFrame('quick')),
        decodeBoundedHq,
        probeExportCapability: vi.fn().mockResolvedValue(makeCapability()),
        readRawWindow: vi.fn(),
        readProcessedWindow: vi.fn(),
        applyCalibration: vi.fn().mockResolvedValue({ applied: true } as const),
        dispose: vi.fn(),
      }),
    })
    const adapter = createRawRuntimeAdapter({
      lumaRuntimeFactory: () => runtime,
    })
    const session = await adapter.openSession(new File(['raw'], 'sample.RAF'))

    const image = await session.decodeBoundedHqRaw({
      maxOutputPixels: BOUNDED_HQ_PREVIEW_LOW_MEMORY_MAX_PIXELS,
    })

    expect(image.source).toBe('bounded-hq')
    expect(decodeBoundedHq).toHaveBeenCalledWith(
      { maxOutputPixels: BOUNDED_HQ_PREVIEW_LOW_MEMORY_MAX_PIXELS },
      undefined,
    )
    expect(session.sourceDimensions).toEqual({ width: 11662, height: 8746 })
  })

  it('normalizes bounded HQ failures to RAW_BOUNDED_HQ_DECODE_FAILED', async () => {
    const { runtime } = makeLumaRuntime({
      openSession: vi.fn().mockResolvedValue({
        sessionId: 'raw-session-1',
        probe: {
          jobId: 'probe',
          width: 6240,
          height: 4168,
          supportLevel: 'experimental',
          timings: { total: 1 },
        },
        timings: { total: 1 },
        extractEmbeddedPreview: vi.fn(),
        decodeQuick: vi.fn().mockResolvedValue(makeLumaFrame('quick')),
        decodeBoundedHq: vi.fn().mockRejectedValue(new Error('bounded failed')),
        probeExportCapability: vi.fn().mockResolvedValue(makeCapability()),
        readRawWindow: vi.fn(),
        readProcessedWindow: vi.fn(),
        applyCalibration: vi.fn().mockResolvedValue({ applied: true } as const),
        dispose: vi.fn(),
      }),
    })
    const adapter = createRawRuntimeAdapter({
      lumaRuntimeFactory: () => runtime,
    })
    const session = await adapter.openSession(new File(['raw'], 'sample.RAF'))

    await expect(
      session.decodeBoundedHqRaw({
        maxOutputPixels: BOUNDED_HQ_PREVIEW_MAX_PIXELS,
      }),
    ).rejects.toMatchObject({
      code: 'RAW_BOUNDED_HQ_DECODE_FAILED',
    })
  })

  it('preserves processed-window export capability facts when JPEG runtime is available', async () => {
    const probeExportCapability = vi.fn().mockResolvedValue(makeCapability())
    const jpegRuntimeAvailabilityProbe = vi.fn().mockReturnValue(true)
    const { runtime } = makeLumaRuntime({
      openSession: vi.fn().mockResolvedValue({
        sessionId: 'session-1',
        probe: {
          jobId: 'probe',
          width: 6240,
          height: 4168,
          supportLevel: 'experimental',
          timings: { total: 1 },
        },
        timings: { total: 1 },
        extractEmbeddedPreview: vi.fn(),
        probeExportCapability,
        readRawWindow: vi.fn(),
        readProcessedWindow: vi.fn(),
        decodeQuick: vi.fn(),
        decodeBoundedHq: vi.fn(),
        applyCalibration: vi.fn().mockResolvedValue({ applied: true } as const),
        dispose: vi.fn(),
      }),
    })
    const adapter = createRawRuntimeAdapter({
      lumaRuntimeFactory: () => runtime,
      jpegRuntimeAvailabilityProbe,
    })

    const session = await adapter.openSession(new File(['raw'], 'sample.ARW'))

    await expect(session.probeExportCapability?.()).resolves.toMatchObject({
      supported: true,
      strategy: 'libraw-processed-window',
      windows: { librawProcessed: true, rawMosaic: false },
    })
    expect(probeExportCapability).toHaveBeenCalledTimes(1)
    expect(jpegRuntimeAvailabilityProbe).toHaveBeenCalledTimes(1)
  })

  it('keeps an open session usable past the decode bridge idle window', async () => {
    vi.useFakeTimers()
    try {
      // Mirrors LumaRawWorkerClient: once the runtime is disposed, every
      // session request rejects with this message.
      let runtimeDisposed = false
      const probeExportCapability = vi.fn(async () => {
        if (runtimeDisposed) {
          throw new Error('RAW runtime worker was disposed.')
        }
        return makeCapability()
      })
      const sessionDispose = vi.fn()
      const { runtime } = makeLumaRuntime({
        dispose: vi.fn<LumaRawRuntime['dispose']>(() => {
          runtimeDisposed = true
        }),
        openSession: vi.fn<LumaRawRuntime['openSession']>().mockResolvedValue({
          sessionId: 'session-1',
          probe: {
            jobId: 'probe',
            width: 11648,
            height: 8736,
            supportLevel: 'experimental',
            timings: { total: 1 },
          },
          timings: { total: 1 },
          extractEmbeddedPreview: vi.fn().mockResolvedValue(null),
          probeExportCapability,
          readRawWindow: vi.fn(),
          readProcessedWindow: vi.fn(),
          decodeQuick: vi.fn().mockResolvedValue(makeLumaFrame('quick')),
          decodeBoundedHq: vi
            .fn()
            .mockResolvedValue(makeLumaFrame('bounded-hq')),
          applyCalibration: vi
            .fn()
            .mockResolvedValue({ applied: true } as const),
          dispose: sessionDispose,
        }),
      })
      const adapter = createRawRuntimeAdapter({
        lumaRuntimeFactory: () => runtime,
        jpegRuntimeAvailabilityProbe: () => true,
      })

      const session = await adapter.openSession(
        new File(['raw'], 'GFX100RF.RAF'),
      )
      // A 100 MP quick decode can outlast the bridge idle window on its own;
      // the session's requests never pass through the bridge queue.
      await vi.advanceTimersByTimeAsync(30_000)

      await expect(session.probeExportCapability?.()).resolves.toMatchObject({
        supported: true,
      })
      expect(runtime.dispose).not.toHaveBeenCalled()

      // Once the session closes, the idle window reclaims the worker again.
      session.dispose()
      await vi.advanceTimersByTimeAsync(10_000)
      expect(sessionDispose).toHaveBeenCalledTimes(1)
      expect(runtime.dispose).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('fails export capability closed when the JPEG runtime is unavailable', async () => {
    const probeExportCapability = vi.fn().mockResolvedValue(makeCapability())
    const jpegRuntimeAvailabilityProbe = vi.fn().mockReturnValue(false)
    const { runtime } = makeLumaRuntime({
      openSession: vi.fn().mockResolvedValue({
        sessionId: 'session-1',
        probe: {
          jobId: 'probe',
          width: 6240,
          height: 4168,
          supportLevel: 'experimental',
          timings: { total: 1 },
        },
        timings: { total: 1 },
        extractEmbeddedPreview: vi.fn(),
        probeExportCapability,
        readRawWindow: vi.fn(),
        readProcessedWindow: vi.fn(),
        decodeQuick: vi.fn(),
        decodeBoundedHq: vi.fn(),
        applyCalibration: vi.fn().mockResolvedValue({ applied: true } as const),
        dispose: vi.fn(),
      }),
    })
    const adapter = createRawRuntimeAdapter({
      lumaRuntimeFactory: () => runtime,
      jpegRuntimeAvailabilityProbe,
    })

    const session = await adapter.openSession(new File(['raw'], 'sample.ARW'))

    await expect(session.probeExportCapability?.()).rejects.toMatchObject({
      message: JPEG_RUNTIME_UNAVAILABLE_MESSAGE,
    })
    expect(probeExportCapability).toHaveBeenCalledTimes(1)
    expect(jpegRuntimeAvailabilityProbe).toHaveBeenCalledTimes(1)
  })

  it.each([
    [
      'missing-color-transform',
      { color: undefined },
      ['missing-color-transform'],
    ],
    [
      'raw-mosaic-only-export',
      makeRawMosaicCapability(),
      ['processed-window-unavailable'],
    ],
    [
      'missing processed window',
      { windows: { librawProcessed: false, rawMosaic: false } },
      ['processed-window-unavailable'],
    ],
  ] as Array<
    [
      string,
      Partial<LumaRawExportCapability> | LumaRawExportCapability,
      string[],
    ]
  >)(
    'fails export capability closed for %s',
    async (_name, overrides, reasons) => {
      const jpegRuntimeAvailabilityProbe = vi.fn().mockReturnValue(true)
      const { runtime } = makeLumaRuntime({
        openSession: vi.fn().mockResolvedValue({
          sessionId: 'session-1',
          probe: {
            jobId: 'probe',
            width: 6240,
            height: 4168,
            supportLevel: 'experimental',
            timings: { total: 1 },
          },
          timings: { total: 1 },
          extractEmbeddedPreview: vi.fn(),
          probeExportCapability: vi
            .fn()
            .mockResolvedValue({ ...makeCapability(), ...overrides }),
          readRawWindow: vi.fn(),
          readProcessedWindow: vi.fn(),
          decodeQuick: vi.fn(),
          decodeBoundedHq: vi.fn(),
          applyCalibration: vi
            .fn()
            .mockResolvedValue({ applied: true } as const),
          dispose: vi.fn(),
        }),
      })
      const adapter = createRawRuntimeAdapter({
        lumaRuntimeFactory: () => runtime,
        jpegRuntimeAvailabilityProbe,
      })

      const session = await adapter.openSession(new File(['raw'], 'sample.ARW'))

      await expect(session.probeExportCapability?.()).resolves.toMatchObject({
        supported: false,
        reasons,
      })
      expect(jpegRuntimeAvailabilityProbe).not.toHaveBeenCalled()
    },
  )

  it('normalizes generic luma session open failures', async () => {
    const { runtime } = makeLumaRuntime({
      openSession: vi.fn().mockRejectedValue(new Error('open exploded')),
    })
    const adapter = createRawRuntimeAdapter({
      lumaRuntimeFactory: () => runtime,
    })

    await expect(
      adapter.openSession(new File(['raw'], 'sample.ARW')),
    ).rejects.toMatchObject({
      name: 'RawAdapterError',
      code: 'RAW_OPEN_FAILED',
      message: 'open exploded',
    })
  })

  it('normalizes generic luma session stage failures', async () => {
    const extractEmbeddedPreview = vi
      .fn()
      .mockRejectedValue(new Error('thumbnail exploded'))
    const decodeQuick = vi.fn().mockRejectedValue(new Error('quick exploded'))
    const decodeBoundedHq = vi
      .fn()
      .mockRejectedValue(new Error('bounded hq exploded'))
    const { runtime } = makeLumaRuntime({
      openSession: vi.fn().mockResolvedValue({
        sessionId: 'session-1',
        probe: {
          jobId: 'probe',
          width: 6240,
          height: 4168,
          supportLevel: 'experimental',
          timings: { total: 1 },
        },
        timings: { total: 1 },
        extractEmbeddedPreview,
        readRawWindow: vi.fn(),
        readProcessedWindow: vi.fn(),
        decodeQuick,
        decodeBoundedHq,
        applyCalibration: vi.fn().mockResolvedValue({ applied: true } as const),
        dispose: vi.fn(),
      }),
    })
    const adapter = createRawRuntimeAdapter({
      lumaRuntimeFactory: () => runtime,
    })
    const session = await adapter.openSession(new File(['raw'], 'sample.ARW'))

    await expect(session.extractEmbeddedPreview()).rejects.toMatchObject({
      name: 'RawAdapterError',
      code: 'RAW_THUMBNAIL_UNAVAILABLE',
      message: 'thumbnail exploded',
    })
    await expect(session.decodeQuickRaw()).rejects.toMatchObject({
      name: 'RawAdapterError',
      code: 'RAW_QUICK_DECODE_FAILED',
      message: 'quick exploded',
    })
    await expect(
      session.decodeBoundedHqRaw({
        maxOutputPixels: BOUNDED_HQ_PREVIEW_MAX_PIXELS,
      }),
    ).rejects.toMatchObject({
      name: 'RawAdapterError',
      code: 'RAW_BOUNDED_HQ_DECODE_FAILED',
      message: 'bounded hq exploded',
    })
  })

  it('shares one singleton runtime across concurrent first luma calls', async () => {
    vi.resetModules()

    const { runtime } = makeLumaRuntime()
    const createLumaRawRuntime = vi.fn(() => runtime)
    vi.doMock('@lumaforge/luma-raw-runtime', () => ({
      createLumaRawRuntime,
    }))

    try {
      const { decodeQuickRawWithLuma, disposeLumaRawRuntime } =
        await import('./luma-runtime-adapter')

      await Promise.all([
        decodeQuickRawWithLuma(new File(['raw-a'], 'a.ARW')),
        decodeQuickRawWithLuma(new File(['raw-b'], 'b.ARW')),
      ])

      expect(createLumaRawRuntime).toHaveBeenCalledTimes(1)
      expect(runtime.decodeQuick).toHaveBeenCalledTimes(2)

      disposeLumaRawRuntime()
    } finally {
      vi.doUnmock('@lumaforge/luma-raw-runtime')
      vi.resetModules()
    }
  })

  it('returns ready outcome and ready state after a successful prewarm', async () => {
    const { runtime } = makeLumaRuntime()
    const adapter = createRawRuntimeAdapter({
      lumaRuntimeFactory: () => runtime,
    })

    expect(adapter.getPrewarmState()).toBe('idle')

    const outcome = await adapter.prewarm()

    expect(outcome).toEqual({ status: 'ready' })
    expect(adapter.getPrewarmState()).toBe('ready')
    expect(runtime.init).toHaveBeenCalledTimes(1)
  })

  it('returns failed outcome with recoverable=false for irrecoverable RAW_CROSS_ORIGIN_ISOLATION_REQUIRED', async () => {
    const { runtime } = makeLumaRuntime()
    const error = Object.assign(
      new Error('Cross-origin isolation is required.'),
      { code: 'RAW_CROSS_ORIGIN_ISOLATION_REQUIRED' },
    )
    vi.mocked(runtime.init).mockRejectedValue(error)
    const adapter = createRawRuntimeAdapter({
      lumaRuntimeFactory: () => runtime,
    })

    const outcome = await adapter.prewarm()

    expect(outcome).toMatchObject({
      status: 'failed',
      recoverable: false,
    })
    expect(outcome.reason).toContain('Cross-origin isolation')
    expect(adapter.getPrewarmState()).toBe('failed')
  })

  it('classifies unknown errors as recoverable failures', async () => {
    const { runtime } = makeLumaRuntime()
    vi.mocked(runtime.init).mockRejectedValue(new Error('network blip'))
    const adapter = createRawRuntimeAdapter({
      lumaRuntimeFactory: () => runtime,
    })

    const outcome = await adapter.prewarm()

    expect(outcome).toMatchObject({
      status: 'failed',
      recoverable: true,
      reason: 'network blip',
    })
    expect(adapter.getPrewarmState()).toBe('failed')
  })

  it('shares one in-flight prewarm across concurrent callers', async () => {
    let resolveInit: ((info: LumaRawRuntimeInfo) => void) | undefined
    const { runtime } = makeLumaRuntime()
    vi.mocked(runtime.init).mockImplementation(
      () =>
        new Promise<LumaRawRuntimeInfo>((resolve) => {
          resolveInit = resolve
        }),
    )
    const adapter = createRawRuntimeAdapter({
      lumaRuntimeFactory: () => runtime,
    })

    const first = adapter.prewarm()
    const second = adapter.prewarm()
    expect(adapter.getPrewarmState()).toBe('pending')

    await vi.waitFor(() => expect(resolveInit).toBeTypeOf('function'))
    resolveInit?.(makeRuntimeInfo())

    const [a, b] = await Promise.all([first, second])
    expect(a).toEqual({ status: 'ready' })
    expect(b).toEqual({ status: 'ready' })
    expect(runtime.init).toHaveBeenCalledTimes(1)
  })

  it('memoizes outcome across calls (no re-init on repeat prewarm)', async () => {
    const { runtime } = makeLumaRuntime()
    const adapter = createRawRuntimeAdapter({
      lumaRuntimeFactory: () => runtime,
    })

    const first = await adapter.prewarm()
    const second = await adapter.prewarm()

    expect(first).toEqual({ status: 'ready' })
    expect(second).toEqual({ status: 'ready' })
    expect(runtime.init).toHaveBeenCalledTimes(1)
  })

  it('disposeLumaRawRuntime resets prewarm state to idle', async () => {
    const { runtime } = makeLumaRuntime()
    const adapter = createRawRuntimeAdapter({
      lumaRuntimeFactory: () => runtime,
    })

    await adapter.prewarm()
    expect(adapter.getPrewarmState()).toBe('ready')

    disposeLumaRawRuntime()

    expect(adapter.getPrewarmState()).toBe('idle')
  })
})
