import { describe, expect, it, vi } from 'vitest'

import { version as packageVersion } from '../package.json'
import { LumaRawRuntimeError } from '../src/errors'
import type { LumaRawExportCapability } from '../src/types'
import type { LumaRawWorkerRequest } from '../src/worker-protocol'
import type { LumaRawNativeFactory } from './native-types'
import {
  createRuntimeCore,
  rawRequestFailureFallbackCodes,
} from './runtime-core'

const unsupportedNativeCapability: LumaRawExportCapability = {
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
}

const makeNativeFactory = (): LumaRawNativeFactory => ({
  createProcessor() {
    let openCount = 0
    let loaded = false

    return {
      loadBuffer(data) {
        if (data.byteLength === 0) {
          throw new Error('empty input')
        }
        loaded = true
        return {
          copyToWasm: 0,
        }
      },
      openWithSettings(_settings) {
        if (!loaded) {
          throw new Error('missing input')
        }
        openCount += 1
        return {
          copyToWasm: 0,
          librawOpen: 0,
        }
      },
      readMetadata() {
        return {
          width: 4000,
          height: 3000,
          rawWidth: 4024,
          rawHeight: 3024,
          make: 'Sony',
          model: `A7-${openCount}`,
          iso: 200,
          orientation: 1,
          thumbnail: {
            width: 1600,
            height: 1067,
            format: 'jpeg',
          },
          blackLevel: 512,
          whiteLevel: 16383,
          baselineExposure: 1.25,
        }
      },
      extractThumbnail() {
        return {
          data: new Uint8Array([1, 2, 3, 4]),
          width: 1600,
          height: 1067,
          format: 'jpeg',
        }
      },
      decodePreview() {
        return {
          data: new Uint16Array([0, 32768, 65535]),
          width: 1,
          height: 1,
          bits: 16,
        }
      },
      decodeHq() {
        return {
          data: new Uint16Array([65535, 32768, 0]),
          width: 1,
          height: 1,
          bits: 16,
        }
      },
      probeExportCapability: () => unsupportedNativeCapability,
      readProcessedWindow() {
        throw new Error('unexpected processed-window read')
      },
      applyCalibration() {},
      dispose() {},
    }
  },
})

const sourcePayload = {
  fileBuffer: new ArrayBuffer(4),
  fileName: 'sample.ARW',
  fileSize: 4,
}

async function openTestSession(
  core: ReturnType<typeof createRuntimeCore>,
  id = 'open-session',
) {
  const opened = await core.handleRequest({
    id,
    type: 'openSession',
    payload: { ...sourcePayload, fileBuffer: new ArrayBuffer(4) },
  })
  if (!opened.ok || opened.type !== 'openSession') {
    throw new Error('Expected an open session.')
  }
  return opened.payload
}

function thumbnailFactory(
  thumbnail: ReturnType<
    ReturnType<LumaRawNativeFactory['createProcessor']>['extractThumbnail']
  >,
): LumaRawNativeFactory {
  return {
    createProcessor() {
      return {
        ...makeNativeFactory().createProcessor(),
        extractThumbnail: () => thumbnail,
      }
    },
  }
}

type SessionRequestType =
  | 'extractEmbeddedPreviewFromSession'
  | 'decodeQuickFromSession'
  | 'decodeBoundedHqFromSession'
  | 'probeExportCapabilityFromSession'
  | 'readProcessedWindowFromSession'
  | 'applyCalibrationToSession'
  | 'closeSession'

function sessionRequest(
  type: SessionRequestType,
  sessionId: string,
  id = `classify-${type}`,
): LumaRawWorkerRequest {
  switch (type) {
    case 'decodeBoundedHqFromSession':
      return { id, type, payload: { sessionId, maxOutputPixels: 1_000_000 } }
    case 'readProcessedWindowFromSession':
      return {
        id,
        type,
        payload: {
          sessionId,
          request: {
            outputRect: { x: 0, y: 0, width: 2, height: 2 },
            halo: { left: 0, top: 0, right: 0, bottom: 0 },
          },
        },
      }
    case 'applyCalibrationToSession':
      return {
        id,
        type,
        payload: {
          sessionId,
          cameraCalibration: {
            profileId: 'p1',
            profileName: 'Adobe Standard',
            xyzToCamera: new Float32Array(9),
          },
        },
      }
    default:
      return { id, type, payload: { sessionId } }
  }
}

describe('runtime-core', () => {
  it('reports low-memory runtime info when initialized with low-memory profile', async () => {
    const core = createRuntimeCore(makeNativeFactory(), {
      memoryProfile: 'low-memory',
    })

    await expect(
      core.handleRequest({
        id: 'init-low',
        type: 'init',
        payload: {
          requireCrossOriginIsolation: false,
          memoryProfile: 'low-memory',
        },
      }),
    ).resolves.toMatchObject({
      ok: true,
      payload: {
        pthreads: false,
        memoryTier: 'low',
        memoryProfile: 'low-memory',
        workerPoolSize: 1,
      },
    })
  })

  it('reports the package version as the runtime version', async () => {
    const core = createRuntimeCore(makeNativeFactory())

    await expect(
      core.handleRequest({
        id: 'init-version',
        type: 'init',
        payload: {
          requireCrossOriginIsolation: false,
          memoryProfile: 'desktop',
        },
      }),
    ).resolves.toMatchObject({
      ok: true,
      payload: { runtime: 'luma', version: packageVersion },
    })
  })

  it('returns probe metadata without maker-note bulk', async () => {
    const session = await openTestSession(
      createRuntimeCore(makeNativeFactory()),
    )

    expect(session.probe).toMatchObject({
      width: 4000,
      height: 3000,
      make: 'Sony',
      baselineExposure: 1.25,
      supportLevel: 'experimental',
    })
  })

  it.each([
    ['jpeg', new Uint8Array([1, 2, 3, 4]), 'image/jpeg'],
    ['bitmap', new Uint8Array([255, 0, 128, 255]), 'application/octet-stream'],
    // PNG signature bytes without an encoded native format stay octet-stream.
    [
      'unknown',
      new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
      'application/octet-stream',
    ],
  ] as const)(
    'returns %s embedded preview bytes uncloned with their MIME type',
    async (format, data, mimeType) => {
      const core = createRuntimeCore(
        thumbnailFactory({ data, width: 2, height: 2, format }),
      )
      const { sessionId } = await openTestSession(core)

      const response = await core.handleRequest({
        id: `job-${format}-preview`,
        type: 'extractEmbeddedPreviewFromSession',
        payload: { sessionId },
      })

      expect(response).toMatchObject({
        ok: true,
        payload: {
          sessionId,
          width: 2,
          height: 2,
          mimeType,
          colorSpace: 'display-srgb-preview',
        },
      })
      if (
        response.ok &&
        response.type === 'extractEmbeddedPreviewFromSession'
      ) {
        expect(response.payload?.data).toBe(data)
      }
    },
  )

  it('returns null when embedded thumbnail is unavailable', async () => {
    const core = createRuntimeCore(thumbnailFactory(undefined))
    const { sessionId } = await openTestSession(core)

    const response = await core.handleRequest({
      id: 'job-no-thumb',
      type: 'extractEmbeddedPreviewFromSession',
      payload: { sessionId },
    })

    expect(response).toMatchObject({ ok: true, payload: null })
  })

  it('returns quick and bounded HQ RGB16 Linear ProPhoto frames', async () => {
    const core = createRuntimeCore(makeNativeFactory())
    const { sessionId } = await openTestSession(core)

    const quick = await core.handleRequest({
      id: 'job-3',
      type: 'decodeQuickFromSession',
      payload: { sessionId },
    })
    const hq = await core.handleRequest({
      id: 'job-4',
      type: 'decodeBoundedHqFromSession',
      payload: { sessionId, maxOutputPixels: 12_000_000 },
    })

    const frame = {
      sessionId,
      layout: 'rgb',
      bitDepth: 16,
      colorSpace: 'linear-prophoto-rgb',
    }
    expect(quick).toMatchObject({
      ok: true,
      payload: { ...frame, source: 'quick' },
    })
    expect(hq).toMatchObject({
      ok: true,
      payload: { ...frame, source: 'bounded-hq' },
    })
  })

  it('records heap before and after session stages', async () => {
    let heap = 256
    const core = createRuntimeCore({
      createProcessor() {
        return makeNativeFactory().createProcessor()
      },
      heapBytes() {
        heap += 16
        return heap
      },
    })
    const expectHeapGrowth = (stats?: {
      before?: number
      after?: number
      peak?: number
    }) => {
      expect(stats?.before).toBeGreaterThan(0)
      expect(stats?.after).toBeGreaterThan(stats?.before ?? 0)
      expect(stats?.peak).toBe(stats?.after)
    }

    const opened = await core.handleRequest({
      id: 'job-heap-open',
      type: 'openSession',
      payload: {
        fileBuffer: new ArrayBuffer(4),
        fileName: 'sample.ARW',
        fileSize: 4,
      },
    })

    expect(opened.ok && opened.type === 'openSession').toBe(true)
    if (!opened.ok || opened.type !== 'openSession') return
    expectHeapGrowth(opened.payload.heap)

    const sessionId = opened.payload.sessionId
    const embedded = await core.handleRequest({
      id: 'job-heap-embedded',
      type: 'extractEmbeddedPreviewFromSession',
      payload: { sessionId },
    })
    const quick = await core.handleRequest({
      id: 'job-heap-quick',
      type: 'decodeQuickFromSession',
      payload: { sessionId },
    })
    const hq = await core.handleRequest({
      id: 'job-heap-hq',
      type: 'decodeBoundedHqFromSession',
      payload: { sessionId, maxOutputPixels: 12_000_000 },
    })
    await core.handleRequest({
      id: 'job-heap-close',
      type: 'closeSession',
      payload: { sessionId },
    })

    expect(
      embedded.ok && embedded.type === 'extractEmbeddedPreviewFromSession',
    ).toBe(true)
    expect(quick.ok && quick.type === 'decodeQuickFromSession').toBe(true)
    expect(hq.ok && hq.type === 'decodeBoundedHqFromSession').toBe(true)
    if (
      !embedded.ok ||
      embedded.type !== 'extractEmbeddedPreviewFromSession' ||
      !quick.ok ||
      quick.type !== 'decodeQuickFromSession' ||
      !hq.ok ||
      hq.type !== 'decodeBoundedHqFromSession'
    ) {
      return
    }

    expectHeapGrowth(embedded.payload?.heap)
    expectHeapGrowth(quick.payload.heap)
    expectHeapGrowth(hq.payload.heap)
  })

  it('opens a session once and reuses loaded input across session stages', async () => {
    let loadCount = 0
    let disposeCount = 0
    let heapBytes = 268435456
    const openSettings: unknown[] = []
    const previewOptions: unknown[] = []
    const core = createRuntimeCore({
      createProcessor() {
        const processor = makeNativeFactory().createProcessor()
        return {
          ...processor,
          loadBuffer(data) {
            loadCount += 1
            return processor.loadBuffer(data)
          },
          openWithSettings(settings) {
            openSettings.push(settings)
            return processor.openWithSettings(settings)
          },
          decodePreview(options) {
            previewOptions.push(options)
            return processor.decodePreview(options)
          },
          dispose() {
            disposeCount += 1
            processor.dispose()
          },
        }
      },
      heapBytes() {
        heapBytes += 1024
        return heapBytes
      },
    })

    const open = await core.handleRequest({
      id: 'job-session-open',
      type: 'openSession',
      payload: {
        fileBuffer: new ArrayBuffer(4),
        fileName: 'sample.ARW',
        fileSize: 4,
        maxOutputPixels: 123,
      },
    })

    expect(open.ok && open.type === 'openSession').toBe(true)
    if (!open.ok || open.type !== 'openSession') return
    expect(open.payload.heap).toMatchObject({
      before: 268436480,
      after: 268437504,
    })

    const sessionId = open.payload.sessionId
    const embedded = await core.handleRequest({
      id: 'job-session-embedded',
      type: 'extractEmbeddedPreviewFromSession',
      payload: { sessionId },
    })
    const quick = await core.handleRequest({
      id: 'job-session-quick',
      type: 'decodeQuickFromSession',
      payload: { sessionId },
    })
    const hq = await core.handleRequest({
      id: 'job-session-hq',
      type: 'decodeBoundedHqFromSession',
      payload: { sessionId, maxOutputPixels: 12_000_000 },
    })
    const close = await core.handleRequest({
      id: 'job-session-close',
      type: 'closeSession',
      payload: { sessionId },
    })

    expect(embedded).toMatchObject({
      ok: true,
      type: 'extractEmbeddedPreviewFromSession',
      payload: {
        sessionId,
        source: 'embedded',
      },
    })
    expect(quick).toMatchObject({
      ok: true,
      type: 'decodeQuickFromSession',
      payload: {
        sessionId,
        source: 'quick',
      },
    })
    expect(hq).toMatchObject({
      ok: true,
      type: 'decodeBoundedHqFromSession',
      payload: {
        sessionId,
        source: 'bounded-hq',
      },
    })
    expect(close).toMatchObject({
      ok: true,
      type: 'closeSession',
      payload: { closed: true },
    })
    expect(loadCount).toBe(1)
    expect(openSettings).toMatchObject([
      { halfSize: true },
      { halfSize: true },
      { halfSize: true },
      { halfSize: false },
    ])
    expect(previewOptions).toEqual([{ maxOutputPixels: 123 }])
    expect(disposeCount).toBe(1)
  })

  it('uses high-quality native settings with a bounded HQ output cap', async () => {
    const decodeHq = vi.fn(() => ({
      data: new Uint16Array(4000 * 3000 * 3),
      width: 4000,
      height: 3000,
      bits: 16 as const,
    }))
    const core = createRuntimeCore({
      createProcessor() {
        return {
          ...makeNativeFactory().createProcessor(),
          readMetadata() {
            return {
              width: 11662,
              height: 8746,
              rawWidth: 11662,
              rawHeight: 8746,
              orientation: 1,
            }
          },
          decodeHq,
        }
      },
    })

    const opened = await core.handleRequest({
      id: 'open-1',
      type: 'openSession',
      payload: {
        fileBuffer: new ArrayBuffer(4),
        fileName: 'sample.RAF',
        fileSize: 4,
      },
    })
    expect(opened.ok && opened.type === 'openSession').toBe(true)
    if (!opened.ok || opened.type !== 'openSession') return

    const response = await core.handleRequest({
      id: 'bounded-1',
      type: 'decodeBoundedHqFromSession',
      payload: {
        sessionId: opened.payload.sessionId,
        maxOutputPixels: 12_000_000,
      },
    })

    expect(response.ok && response.type === 'decodeBoundedHqFromSession').toBe(
      true,
    )
    if (!response.ok || response.type !== 'decodeBoundedHqFromSession') return
    expect(response.payload.source).toBe('bounded-hq')
    expect(decodeHq).toHaveBeenCalledWith({ maxOutputPixels: 12_000_000 })
  })

  it('rejects session bounded HQ requests with a missing output cap', async () => {
    const decodeHq = vi.fn(() => ({
      data: new Uint16Array(1),
      width: 1,
      height: 1,
      bits: 16 as const,
    }))
    const core = createRuntimeCore({
      createProcessor() {
        return {
          ...makeNativeFactory().createProcessor(),
          decodeHq,
        }
      },
    })

    const opened = await core.handleRequest({
      id: 'open-missing-cap',
      type: 'openSession',
      payload: {
        fileBuffer: new ArrayBuffer(4),
        fileName: 'sample.RAF',
        fileSize: 4,
      },
    })
    expect(opened.ok && opened.type === 'openSession').toBe(true)
    if (!opened.ok || opened.type !== 'openSession') return

    const response = await core.handleRequest({
      id: 'bounded-missing-cap',
      type: 'decodeBoundedHqFromSession',
      payload: {
        sessionId: opened.payload.sessionId,
      },
    } as never)

    expect(response).toMatchObject({
      ok: false,
      type: 'decodeBoundedHqFromSession',
      error: {
        code: 'RAW_WORKER_PROTOCOL_ERROR',
      },
    })
    expect(decodeHq).not.toHaveBeenCalled()
  })

  it('rejects session bounded HQ requests with a non-finite output cap', async () => {
    const decodeHq = vi.fn(() => ({
      data: new Uint16Array(1),
      width: 1,
      height: 1,
      bits: 16 as const,
    }))
    const core = createRuntimeCore({
      createProcessor() {
        return {
          ...makeNativeFactory().createProcessor(),
          decodeHq,
        }
      },
    })
    const { sessionId } = await openTestSession(core)

    const response = await core.handleRequest({
      id: 'bounded-non-finite-cap',
      type: 'decodeBoundedHqFromSession',
      payload: { sessionId, maxOutputPixels: Number.POSITIVE_INFINITY },
    })

    expect(response).toMatchObject({
      ok: false,
      type: 'decodeBoundedHqFromSession',
      error: {
        code: 'RAW_WORKER_PROTOCOL_ERROR',
      },
    })
    expect(decodeHq).not.toHaveBeenCalled()
  })

  it('passes through native processed-window payloads', async () => {
    const request = {
      outputRect: { x: 0, y: 4, width: 2, height: 1 },
      halo: { left: 1, top: 1, right: 1, bottom: 1 },
    }
    const processedWindow = {
      rect: request.outputRect,
      workingSpace: 'linear-prophoto-rgb' as const,
      data: new Uint16Array([1, 2, 3, 4, 5, 6]),
      width: 2,
      height: 1,
      stride: 6,
      normalized: false as const,
      orientationApplied: true as const,
      colorApplied: true as const,
      warnings: [],
    }
    const core = createRuntimeCore({
      createProcessor() {
        return {
          ...makeNativeFactory().createProcessor(),
          readProcessedWindow(receivedRequest) {
            expect(receivedRequest).toEqual(request)
            return processedWindow
          },
        }
      },
    })

    const opened = await core.handleRequest({
      id: 'job-processed-open',
      type: 'openSession',
      payload: {
        fileBuffer: new ArrayBuffer(4),
        fileName: 'sample.ARW',
        fileSize: 4,
      },
    })
    expect(opened.ok && opened.type === 'openSession').toBe(true)
    if (!opened.ok || opened.type !== 'openSession') return

    const response = await core.handleRequest({
      id: 'job-processed-read',
      type: 'readProcessedWindowFromSession',
      payload: { sessionId: opened.payload.sessionId, request },
    })

    expect(response).toEqual({
      id: 'job-processed-read',
      ok: true,
      type: 'readProcessedWindowFromSession',
      payload: processedWindow,
    })
  })

  it('passes quick maxOutputPixels to native decodePreview', async () => {
    let receivedMaxOutputPixels: number | undefined

    const core = createRuntimeCore({
      createProcessor() {
        return {
          ...makeNativeFactory().createProcessor(),
          loadBuffer() {
            return { copyToWasm: 1 }
          },
          openWithSettings() {
            return { copyToWasm: 0, librawOpen: 1 }
          },
          readMetadata() {
            return { width: 6000, height: 4000 }
          },
          extractThumbnail() {
            return undefined
          },
          decodePreview(options) {
            receivedMaxOutputPixels = options?.maxOutputPixels
            return {
              data: new Uint16Array(1500 * 1000 * 3),
              width: 1500,
              height: 1000,
              bits: 16,
            }
          },
          decodeHq() {
            return {
              data: new Uint16Array(6000 * 4000 * 3),
              width: 6000,
              height: 4000,
              bits: 16,
            }
          },
          dispose() {},
        }
      },
    })

    const opened = await core.handleRequest({
      id: 'job-open-session',
      type: 'openSession',
      payload: {
        fileBuffer: new ArrayBuffer(4),
        fileName: 'sample.ARW',
        fileSize: 4,
        maxOutputPixels: 1_000_000,
      },
    })
    expect(opened.ok && opened.type === 'openSession').toBe(true)
    if (!opened.ok || opened.type !== 'openSession') return

    const response = await core.handleRequest({
      id: 'job-quick-session',
      type: 'decodeQuickFromSession',
      payload: {
        sessionId: opened.payload.sessionId,
        maxOutputPixels: 1_500_000,
      },
    })

    expect(response.ok && response.type === 'decodeQuickFromSession').toBe(true)
    expect(receivedMaxOutputPixels).toBe(1_500_000)
  })

  it('reopens the session before probing export capability after preview decode', async () => {
    let sensorFactsAvailable = false
    let openWithSettingsCount = 0

    const supportedCapability: LumaRawExportCapability = {
      supported: true,
      strategy: 'libraw-processed-window' as const,
      width: 4000,
      height: 3000,
      rawWidth: 4024,
      rawHeight: 3024,
      visibleCrop: { x: 12, y: 12, width: 4000, height: 3000 },
      cfa: { pattern: 'rggb' as const, xPhase: 0 as const, yPhase: 0 as const },
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
      sensor: {
        layout: 'bayer' as const,
        colorCount: 3,
        cfa: {
          pattern: 'rggb' as const,
          xPhase: 0 as const,
          yPhase: 0 as const,
        },
        phaseIsWindowLocal: false,
      },
      windows: { librawProcessed: true },
      diagnostics: {
        hasRawImage: true,
        hasColor3Image: false,
        hasColor4Image: false,
        hasXTransTable: false,
      },
      reasons: [],
    }
    const unsupportedCapability: LumaRawExportCapability = {
      ...supportedCapability,
      supported: false,
      cfa: {
        pattern: 'unsupported' as const,
        xPhase: 0 as const,
        yPhase: 0 as const,
      },
      sensor: {
        layout: 'unknown' as const,
        colorCount: 0,
        cfa: {
          pattern: 'unsupported' as const,
          xPhase: 0 as const,
          yPhase: 0 as const,
        },
        phaseIsWindowLocal: false,
      },
      reasons: ['unsupported-sensor-layout' as const],
    }

    const core = createRuntimeCore({
      createProcessor() {
        const processor = makeNativeFactory().createProcessor()

        return {
          ...processor,
          openWithSettings(settings) {
            sensorFactsAvailable = true
            openWithSettingsCount += 1
            return processor.openWithSettings(settings)
          },
          decodePreview(options) {
            sensorFactsAvailable = false
            return processor.decodePreview(options)
          },
          probeExportCapability() {
            return sensorFactsAvailable
              ? supportedCapability
              : unsupportedCapability
          },
        }
      },
    })

    const opened = await core.handleRequest({
      id: 'job-export-after-preview-open',
      type: 'openSession',
      payload: {
        fileBuffer: new ArrayBuffer(4),
        fileName: 'sample.ARW',
        fileSize: 4,
      },
    })
    expect(opened.ok && opened.type === 'openSession').toBe(true)
    if (!opened.ok || opened.type !== 'openSession') return

    await core.handleRequest({
      id: 'job-export-after-preview-decode',
      type: 'decodeQuickFromSession',
      payload: { sessionId: opened.payload.sessionId },
    })

    const capability = await core.handleRequest({
      id: 'job-export-after-preview-capability',
      type: 'probeExportCapabilityFromSession',
      payload: { sessionId: opened.payload.sessionId },
    })

    expect(openWithSettingsCount).toBeGreaterThanOrEqual(3)
    expect(capability).toMatchObject({
      ok: true,
      type: 'probeExportCapabilityFromSession',
      payload: {
        supported: true,
        cfa: { pattern: 'rggb' },
        sensor: { layout: 'bayer' },
        reasons: [],
      },
    })
  })

  it('passes default quick maxOutputPixels to native decodePreview', async () => {
    const previewOptions: unknown[] = []
    const hqOptions: unknown[] = []
    const core = createRuntimeCore({
      createProcessor() {
        const processor = makeNativeFactory().createProcessor()
        return {
          ...processor,
          decodePreview(options) {
            previewOptions.push(options)
            return processor.decodePreview(options)
          },
          decodeHq(options) {
            hqOptions.push(options)
            return processor.decodeHq(options)
          },
        }
      },
    })

    const opened = await core.handleRequest({
      id: 'job-default-session-cap-open',
      type: 'openSession',
      payload: {
        fileBuffer: new ArrayBuffer(4),
        fileName: 'sample.ARW',
        fileSize: 4,
      },
    })
    expect(opened.ok && opened.type === 'openSession').toBe(true)
    if (!opened.ok || opened.type !== 'openSession') return

    const sessionQuick = await core.handleRequest({
      id: 'job-default-session-cap-quick',
      type: 'decodeQuickFromSession',
      payload: {
        sessionId: opened.payload.sessionId,
      },
    })
    const hq = await core.handleRequest({
      id: 'job-default-hq-no-cap',
      type: 'decodeBoundedHqFromSession',
      payload: {
        sessionId: opened.payload.sessionId,
        maxOutputPixels: 12_000_000,
      },
    })

    expect(
      sessionQuick.ok && sessionQuick.type === 'decodeQuickFromSession',
    ).toBe(true)
    expect(hq.ok && hq.type === 'decodeBoundedHqFromSession').toBe(true)
    expect(previewOptions).toEqual([{ maxOutputPixels: 2_500_000 }])
    expect(hqOptions).toEqual([{ maxOutputPixels: 12_000_000 }])
  })

  it('disposes an opened session when late cancellation targets its open request', async () => {
    let disposeCount = 0
    const core = createRuntimeCore({
      createProcessor() {
        const processor = makeNativeFactory().createProcessor()
        return {
          ...processor,
          dispose() {
            disposeCount += 1
            processor.dispose()
          },
        }
      },
    })

    const open = await core.handleRequest({
      id: 'job-late-cancel-open',
      type: 'openSession',
      payload: {
        fileBuffer: new ArrayBuffer(4),
        fileName: 'sample.ARW',
        fileSize: 4,
      },
    })

    expect(open.ok && open.type === 'openSession').toBe(true)
    if (!open.ok || open.type !== 'openSession') return

    const cancel = await core.handleRequest({
      id: 'job-late-cancel',
      type: 'cancel',
      payload: {
        targetJobId: 'job-late-cancel-open',
      },
    })
    const decodeAfterCancel = await core.handleRequest({
      id: 'job-after-late-cancel',
      type: 'decodeQuickFromSession',
      payload: {
        sessionId: open.payload.sessionId,
      },
    })

    expect(cancel).toMatchObject({
      ok: true,
      type: 'cancel',
      payload: { cancelled: true },
    })
    expect(disposeCount).toBe(1)
    expect(decodeAfterCancel).toMatchObject({
      ok: false,
      type: 'decodeQuickFromSession',
      error: {
        code: 'RAW_WORKER_PROTOCOL_ERROR',
      },
    })
  })

  it('reports copyToWasm and librawOpen timings separately on session open', async () => {
    const core = createRuntimeCore({
      createProcessor() {
        const processor = makeNativeFactory().createProcessor()

        return {
          ...processor,
          loadBuffer(data) {
            processor.loadBuffer(data)
            return { copyToWasm: 3 }
          },
          openWithSettings(settings) {
            processor.openWithSettings(settings)
            return { copyToWasm: 4, librawOpen: 11 }
          },
        }
      },
    })

    const { timings } = await openTestSession(core)

    expect(timings.copyToWasm).toBe(7)
    expect(timings.librawOpen).toBe(11)
    expect(timings.openBuffer).toBe(18)
  })

  it('keeps native-owned output buffers without cloning in runtime-core', async () => {
    const nativeData = new Uint16Array([1, 2, 3])
    const core = createRuntimeCore({
      createProcessor() {
        return {
          ...makeNativeFactory().createProcessor(),
          loadBuffer() {
            return { copyToWasm: 1 }
          },
          openWithSettings() {
            return { copyToWasm: 0, librawOpen: 1 }
          },
          readMetadata() {
            return { width: 1, height: 1 }
          },
          extractThumbnail() {
            return undefined
          },
          decodePreview() {
            return {
              data: nativeData,
              width: 1,
              height: 1,
              bits: 16,
            }
          },
          decodeHq() {
            return {
              data: nativeData,
              width: 1,
              height: 1,
              bits: 16,
            }
          },
          dispose() {},
        }
      },
    })

    const { sessionId } = await openTestSession(core)
    const response = await core.handleRequest({
      id: 'job-no-clone',
      type: 'decodeQuickFromSession',
      payload: { sessionId },
    })

    expect(response.ok && response.type === 'decodeQuickFromSession').toBe(true)
    if (!response.ok || response.type !== 'decodeQuickFromSession') return

    expect(response.payload.data).toBe(nativeData)
  })

  it('opens quick and bounded HQ decodes with native RGB16 ProPhoto settings', async () => {
    const openSettings: unknown[] = []
    const core = createRuntimeCore({
      createProcessor() {
        const processor = makeNativeFactory().createProcessor()
        return {
          ...processor,
          openWithSettings(settings) {
            openSettings.push(settings)
            return processor.openWithSettings(settings)
          },
        }
      },
    })
    const { sessionId } = await openTestSession(core)

    await core.handleRequest({
      id: 'job-settings-hq',
      type: 'decodeBoundedHqFromSession',
      payload: { sessionId, maxOutputPixels: 12_000_000 },
    })

    expect(openSettings).toEqual([
      {
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
      },
      {
        halfSize: false,
        useCameraWb: true,
        outputColor: 4,
        outputBps: 16,
        noAutoBright: true,
        useAutoWb: false,
        useCameraMatrix: 1,
        bright: 1,
        highlight: 2,
        userQual: 2,
        gamm: [1, 1, 1, 1, 0, 0],
      },
    ])
  })

  it('preserves primary native failure when dispose also fails', async () => {
    const core = createRuntimeCore({
      createProcessor() {
        const processor = makeNativeFactory().createProcessor()
        return {
          ...processor,
          readMetadata() {
            throw new LumaRawRuntimeError(
              'RAW_METADATA_FAILED',
              'metadata failed',
            )
          },
          dispose() {
            throw new LumaRawRuntimeError(
              'RAW_RUNTIME_UNAVAILABLE',
              'dispose failed',
            )
          },
        }
      },
    })

    const response = await core.handleRequest({
      id: 'job-primary-failure',
      type: 'openSession',
      payload: sourcePayload,
    })

    expect(response).toMatchObject({
      ok: false,
      type: 'openSession',
      error: {
        code: 'RAW_METADATA_FAILED',
        message: 'metadata failed',
      },
    })
  })

  it('acknowledges cancellation and avoids returning data for pre-cancelled jobs', async () => {
    let openCount = 0
    const core = createRuntimeCore({
      createProcessor() {
        const processor = makeNativeFactory().createProcessor()
        return {
          ...processor,
          loadBuffer(data) {
            openCount += 1
            return processor.loadBuffer(data)
          },
        }
      },
    })

    const cancel = await core.handleRequest({
      id: 'job-cancel-request',
      type: 'cancel',
      payload: {
        targetJobId: 'job-cancelled',
      },
    })
    const cancelled = await core.handleRequest({
      id: 'job-cancelled',
      type: 'openSession',
      payload: sourcePayload,
    })

    expect(cancel).toMatchObject({
      ok: true,
      type: 'cancel',
      payload: { cancelled: true },
    })
    expect(cancelled).toMatchObject({
      ok: false,
      type: 'openSession',
      error: {
        code: 'RAW_JOB_CANCELLED',
      },
    })
    expect(openCount).toBe(0)
  })

  it('forwards applyCalibrationToSession payloads into the native processor', async () => {
    const calls: Array<{
      xyzToCamera: Float32Array
      toneCurveLut?: Float32Array
    }> = []
    const core = createRuntimeCore({
      createProcessor() {
        return {
          ...makeNativeFactory().createProcessor(),
          applyCalibration(payload) {
            calls.push({
              xyzToCamera: payload.xyzToCamera,
              toneCurveLut: payload.toneCurveLut,
            })
          },
        }
      },
    })

    const opened = await core.handleRequest({
      id: 'job-calibration-open',
      type: 'openSession',
      payload: {
        fileBuffer: new ArrayBuffer(4),
        fileName: 'sample.ARW',
        fileSize: 4,
      },
    })
    expect(opened.ok && opened.type === 'openSession').toBe(true)
    if (!opened.ok || opened.type !== 'openSession') return

    const xyzToCamera = new Float32Array([
      0.7, 0.2, 0.1, 0.3, 0.85, -0.15, -0.05, 0.1, 0.95,
    ])
    const toneCurveLut = new Float32Array(4096)

    const matrixOnly = await core.handleRequest({
      id: 'job-calibration-matrix-only',
      type: 'applyCalibrationToSession',
      payload: {
        sessionId: opened.payload.sessionId,
        cameraCalibration: {
          profileId: 'p-matrix',
          profileName: 'Matrix Only',
          xyzToCamera,
        },
      },
    })

    const matrixAndCurve = await core.handleRequest({
      id: 'job-calibration-with-curve',
      type: 'applyCalibrationToSession',
      payload: {
        sessionId: opened.payload.sessionId,
        cameraCalibration: {
          profileId: 'p-curve',
          profileName: 'With Curve',
          xyzToCamera,
          toneCurveLut,
        },
      },
    })

    expect(matrixOnly).toMatchObject({
      ok: true,
      type: 'applyCalibrationToSession',
      payload: { applied: true },
    })
    expect(matrixAndCurve).toMatchObject({
      ok: true,
      type: 'applyCalibrationToSession',
      payload: { applied: true },
    })
    expect(calls).toHaveLength(2)
    expect(calls[0]).toMatchObject({
      xyzToCamera,
      toneCurveLut: undefined,
    })
    expect(calls[1]).toMatchObject({
      xyzToCamera,
      toneCurveLut,
    })
  })

  describe('applyCalibrationToSession failures', () => {
    function makeCalibrationCore(applyCalibration: () => void) {
      const calls: number[] = []
      const core = createRuntimeCore({
        createProcessor() {
          return {
            ...makeNativeFactory().createProcessor(),
            applyCalibration() {
              calls.push(1)
              applyCalibration()
            },
          }
        },
      })
      return { core, calls }
    }

    async function openCalibrationSession(
      core: ReturnType<typeof createRuntimeCore>,
    ) {
      const opened = await core.handleRequest({
        id: 'calibration-failure-open',
        type: 'openSession',
        payload: {
          fileBuffer: new ArrayBuffer(4),
          fileName: 'sample.ARW',
          fileSize: 4,
        },
      })
      if (!opened.ok || opened.type !== 'openSession') {
        throw new Error('session open failed in fixture')
      }
      return opened.payload.sessionId
    }

    function calibrationRequest(
      sessionId: string,
      cameraCalibration: unknown,
      id = 'calibration-failure',
    ): LumaRawWorkerRequest {
      return {
        id,
        type: 'applyCalibrationToSession',
        payload: {
          sessionId,
          cameraCalibration,
        },
      } as LumaRawWorkerRequest
    }

    const validCalibration = {
      profileId: 'p1',
      profileName: 'Adobe Standard',
      xyzToCamera: new Float32Array(9),
    }

    // A full-length tone curve with one non-finite entry.
    function toneCurveHolding(value: number) {
      const lut = new Float32Array(4096)
      lut[2048] = value
      return lut
    }

    it('classifies an unclassified native failure as a calibration failure', async () => {
      const { core } = makeCalibrationCore(() => {
        throw new Error('native calibration rejected the matrix')
      })
      const sessionId = await openCalibrationSession(core)

      await expect(
        core.handleRequest(calibrationRequest(sessionId, validCalibration)),
      ).resolves.toEqual({
        id: 'calibration-failure',
        ok: false,
        type: 'applyCalibrationToSession',
        error: {
          code: 'RAW_CALIBRATION_FAILED',
          message: 'native calibration rejected the matrix',
        },
      })
    })

    it('keeps a specific runtime error the native operation raised', async () => {
      const { core } = makeCalibrationCore(() => {
        throw new LumaRawRuntimeError(
          'RAW_MEMORY_LIMIT',
          'RAW runtime ran out of memory.',
        )
      })
      const sessionId = await openCalibrationSession(core)

      await expect(
        core.handleRequest(calibrationRequest(sessionId, validCalibration)),
      ).resolves.toMatchObject({
        ok: false,
        error: {
          code: 'RAW_MEMORY_LIMIT',
          message: 'RAW runtime ran out of memory.',
        },
      })
    })

    it.each([
      ['a missing calibration', undefined],
      ['a non-object calibration', 'adobe-standard'],
      [
        'a plain-array matrix',
        { ...validCalibration, xyzToCamera: [1, 0, 0, 0, 1, 0, 0, 0, 1] },
      ],
      [
        'a short matrix',
        { ...validCalibration, xyzToCamera: new Float32Array(8) },
      ],
      [
        'a non-finite matrix',
        {
          ...validCalibration,
          xyzToCamera: new Float32Array([1, 0, 0, 0, Number.NaN, 0, 0, 0, 1]),
        },
      ],
      [
        'a plain-array tone curve',
        { ...validCalibration, toneCurveLut: [0, 1] },
      ],
      [
        'a short tone curve',
        { ...validCalibration, toneCurveLut: new Float32Array(4095) },
      ],
      [
        'a tone curve holding NaN',
        { ...validCalibration, toneCurveLut: toneCurveHolding(Number.NaN) },
      ],
      [
        'a tone curve holding +Infinity',
        {
          ...validCalibration,
          toneCurveLut: toneCurveHolding(Number.POSITIVE_INFINITY),
        },
      ],
      [
        'a tone curve holding -Infinity',
        {
          ...validCalibration,
          toneCurveLut: toneCurveHolding(Number.NEGATIVE_INFINITY),
        },
      ],
    ])(
      'refuses %s as malformed before the session lookup and native work',
      async (_label, cameraCalibration) => {
        const { core, calls } = makeCalibrationCore(() => {})
        const sessionId = await openCalibrationSession(core)

        const known = await core.handleRequest(
          calibrationRequest(sessionId, cameraCalibration),
        )
        const unknown = await core.handleRequest(
          calibrationRequest('raw-session-missing', cameraCalibration),
        )

        for (const response of [known, unknown]) {
          expect(response).toMatchObject({
            ok: false,
            type: 'applyCalibrationToSession',
            error: { code: 'RAW_WORKER_PROTOCOL_ERROR' },
          })
          expect(response).not.toMatchObject({
            error: { message: expect.stringContaining('session does not') },
          })
        }
        expect(calls).toEqual([])
      },
    )

    it('refuses a pre-cancelled malformed calibration as cancelled', async () => {
      const { core, calls } = makeCalibrationCore(() => {})
      const sessionId = await openCalibrationSession(core)

      await core.handleRequest({
        id: 'calibration-malformed-cancel',
        type: 'cancel',
        payload: { targetJobId: 'calibration-malformed' },
      })

      await expect(
        core.handleRequest(
          calibrationRequest(sessionId, undefined, 'calibration-malformed'),
        ),
      ).resolves.toMatchObject({
        ok: false,
        error: { code: 'RAW_JOB_CANCELLED' },
      })
      expect(calls).toEqual([])
    })
  })

  it('bounds best-effort cancellation tracking', async () => {
    const core = createRuntimeCore(makeNativeFactory())

    for (let index = 0; index < 129; index += 1) {
      await core.handleRequest({
        id: `cancel-${index}`,
        type: 'cancel',
        payload: {
          targetJobId: `cancelled-${index}`,
        },
      })
    }

    const evicted = await core.handleRequest({
      id: 'cancelled-0',
      type: 'openSession',
      payload: { ...sourcePayload, fileName: 'evicted.ARW' },
    })
    const retained = await core.handleRequest({
      id: 'cancelled-128',
      type: 'openSession',
      payload: { ...sourcePayload, fileName: 'retained.ARW' },
    })

    expect(evicted).toMatchObject({
      ok: true,
      type: 'openSession',
    })
    expect(retained).toMatchObject({
      ok: false,
      type: 'openSession',
      error: {
        code: 'RAW_JOB_CANCELLED',
      },
    })
  })
})

describe('runtime-core request failure classification', () => {
  type FailingMethod =
    | 'loadBuffer'
    | 'extractThumbnail'
    | 'decodePreview'
    | 'decodeHq'
    | 'probeExportCapability'
    | 'readProcessedWindow'
    | 'applyCalibration'
    | 'dispose'

  const makeFailingFactory = (
    method: FailingMethod,
    failure: unknown,
  ): LumaRawNativeFactory => ({
    createProcessor() {
      const processor = makeNativeFactory().createProcessor()
      const fail = () => {
        throw failure
      }
      return {
        ...processor,
        [method]: fail,
      }
    },
  })

  const filePayload = {
    fileBuffer: new ArrayBuffer(4),
    fileName: 'sample.ARW',
    fileSize: 4,
  }

  async function openSession(
    core: ReturnType<typeof createRuntimeCore>,
    id = 'classify-open',
  ) {
    const opened = await core.handleRequest({
      id,
      type: 'openSession',
      payload: filePayload,
    })
    if (!opened.ok || opened.type !== 'openSession') {
      throw new Error('session open failed in fixture')
    }
    return opened.payload.sessionId
  }

  it('classifies unexpected session open failures as source-open failures', async () => {
    const core = createRuntimeCore(
      makeFailingFactory('loadBuffer', new Error('load exploded')),
    )

    await expect(
      core.handleRequest({
        id: 'classify-openSession',
        type: 'openSession',
        payload: filePayload,
      }),
    ).resolves.toMatchObject({
      ok: false,
      type: 'openSession',
      error: { code: 'RAW_OPEN_FAILED', message: 'load exploded' },
    })
  })

  it.each([
    [
      'extractEmbeddedPreviewFromSession',
      'extractThumbnail',
      'RAW_THUMBNAIL_UNAVAILABLE',
    ],
    ['decodeQuickFromSession', 'decodePreview', 'RAW_QUICK_DECODE_FAILED'],
    ['decodeBoundedHqFromSession', 'decodeHq', 'RAW_HQ_DECODE_FAILED'],
    [
      'probeExportCapabilityFromSession',
      'probeExportCapability',
      'RAW_METADATA_FAILED',
    ],
    [
      'readProcessedWindowFromSession',
      'readProcessedWindow',
      'RAW_WINDOW_READ_FAILED',
    ],
    ['applyCalibrationToSession', 'applyCalibration', 'RAW_CALIBRATION_FAILED'],
    ['closeSession', 'dispose', 'RAW_RUNTIME_UNAVAILABLE'],
  ] as const)(
    'classifies unexpected %s failures by operation',
    async (type, method, code) => {
      const core = createRuntimeCore(
        makeFailingFactory(method, new TypeError(`${method} exploded`)),
      )
      const sessionId = await openSession(core)

      await expect(
        core.handleRequest(sessionRequest(type, sessionId)),
      ).resolves.toEqual({
        id: `classify-${type}`,
        ok: false,
        type,
        error: { code, message: `${method} exploded` },
      })
    },
  )

  it.each([
    ['a string', 'native abort'],
    ['undefined', undefined],
    ['a plain object', { status: 12 }],
  ])(
    'classifies non-Error window throws (%s) without losing the operation',
    async (_label, failure) => {
      const core = createRuntimeCore(
        makeFailingFactory('readProcessedWindow', failure),
      )
      const sessionId = await openSession(core)

      await expect(
        core.handleRequest(
          sessionRequest('readProcessedWindowFromSession', sessionId),
        ),
      ).resolves.toMatchObject({
        ok: false,
        type: 'readProcessedWindowFromSession',
        error: {
          code: 'RAW_WINDOW_READ_FAILED',
          message: 'RAW runtime request failed.',
        },
      })
    },
  )

  it('classifies non-Error decode throws by operation', async () => {
    const core = createRuntimeCore(makeFailingFactory('decodeHq', 'oom'))
    const sessionId = await openSession(core)

    await expect(
      core.handleRequest(
        sessionRequest('decodeBoundedHqFromSession', sessionId),
      ),
    ).resolves.toMatchObject({
      ok: false,
      error: {
        code: 'RAW_HQ_DECODE_FAILED',
        message: 'RAW runtime request failed.',
      },
    })
  })

  it.each([
    ['RAW_MEMORY_LIMIT', 'decodeHq', 'decodeBoundedHqFromSession'],
    [
      'RAW_MEMORY_LIMIT',
      'readProcessedWindow',
      'readProcessedWindowFromSession',
    ],
    [
      'RAW_JOB_CANCELLED',
      'extractThumbnail',
      'extractEmbeddedPreviewFromSession',
    ],
    ['RAW_UNSUPPORTED_FORMAT', 'decodePreview', 'decodeQuickFromSession'],
  ] as const)(
    'keeps specific %s failures thrown during %s',
    async (code, method, type) => {
      const core = createRuntimeCore(
        makeFailingFactory(
          method,
          new LumaRawRuntimeError(code, `${code} from native`),
        ),
      )
      const sessionId = await openSession(core)

      await expect(
        core.handleRequest(sessionRequest(type, sessionId)),
      ).resolves.toMatchObject({
        ok: false,
        type,
        error: { code, message: `${code} from native` },
      })
    },
  )
})

describe('runtime-core session jobs', () => {
  type SessionJobType = Exclude<SessionRequestType, 'closeSession'>
  type SessionJobMethod =
    | 'extractThumbnail'
    | 'decodePreview'
    | 'decodeHq'
    | 'probeExportCapability'
    | 'readProcessedWindow'
    | 'applyCalibration'

  const sessionJobs = [
    ['extractEmbeddedPreviewFromSession', 'extractThumbnail'],
    ['decodeQuickFromSession', 'decodePreview'],
    ['decodeBoundedHqFromSession', 'decodeHq'],
    ['probeExportCapabilityFromSession', 'probeExportCapability'],
    ['readProcessedWindowFromSession', 'readProcessedWindow'],
    ['applyCalibrationToSession', 'applyCalibration'],
  ] as const satisfies ReadonlyArray<
    readonly [SessionJobType, SessionJobMethod]
  >

  const supportedCapability: LumaRawExportCapability = {
    supported: true,
    width: 2,
    height: 2,
    rawWidth: 2,
    rawHeight: 2,
    visibleCrop: { x: 0, y: 0, width: 2, height: 2 },
    cfa: { pattern: 'rggb', xPhase: 0, yPhase: 0 },
    blackLevel: 64,
    whiteLevel: 1023,
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
    windows: { librawProcessed: true },
    diagnostics: {
      hasRawImage: true,
      hasColor3Image: false,
      hasColor4Image: false,
      hasXTransTable: false,
    },
    reasons: [],
  }

  // Every session-job native operation records its call and runs the
  // optional hook, which may queue a cancellation or throw mid-job.
  function makeSessionJobCore(
    onNativeCall?: (method: SessionJobMethod) => void,
  ) {
    const calls: SessionJobMethod[] = []
    const record = <T>(method: SessionJobMethod, value: () => T) => {
      calls.push(method)
      onNativeCall?.(method)
      return value()
    }
    const core = createRuntimeCore({
      createProcessor() {
        const processor = makeNativeFactory().createProcessor()
        return {
          ...processor,
          extractThumbnail: () =>
            record('extractThumbnail', () => processor.extractThumbnail()),
          decodePreview: (options) =>
            record('decodePreview', () => processor.decodePreview(options)),
          decodeHq: (options) =>
            record('decodeHq', () => processor.decodeHq(options)),
          probeExportCapability: () =>
            record('probeExportCapability', () => supportedCapability),
          readProcessedWindow: (request) =>
            record('readProcessedWindow', () => ({
              rect: request.outputRect,
              workingSpace: 'linear-prophoto-rgb' as const,
              data: new Uint16Array(
                request.outputRect.width * request.outputRect.height * 3,
              ),
              width: request.outputRect.width,
              height: request.outputRect.height,
              stride: request.outputRect.width * 3,
              normalized: false as const,
              orientationApplied: true as const,
              colorApplied: true as const,
              warnings: [],
            })),
          applyCalibration: () => record('applyCalibration', () => undefined),
        }
      },
    })

    return { core, calls }
  }

  async function openSessionId(core: ReturnType<typeof createRuntimeCore>) {
    const opened = await core.handleRequest({
      id: 'session-job-open',
      type: 'openSession',
      payload: {
        fileBuffer: new ArrayBuffer(4),
        fileName: 'sample.ARW',
        fileSize: 4,
      },
    })
    if (!opened.ok || opened.type !== 'openSession') {
      throw new Error('session open failed in fixture')
    }
    return opened.payload.sessionId
  }

  function cancel(
    core: ReturnType<typeof createRuntimeCore>,
    targetJobId: string,
  ) {
    return core.handleRequest({
      id: `${targetJobId}-cancel`,
      type: 'cancel',
      payload: { targetJobId },
    })
  }

  it.each(sessionJobs)(
    'refuses a pre-cancelled %s before the session lookup and native work, once',
    async (type) => {
      const { core, calls } = makeSessionJobCore()
      const sessionId = await openSessionId(core)
      const id = `pre-cancelled-${type}`

      await cancel(core, id)
      const cancelled = await core.handleRequest(
        sessionRequest(type, 'raw-session-missing', id),
      )
      const rerun = await core.handleRequest(
        sessionRequest(type, sessionId, id),
      )

      expect(cancelled).toEqual({
        id,
        ok: false,
        type,
        error: {
          code: 'RAW_JOB_CANCELLED',
          message: 'RAW runtime job was cancelled.',
        },
      })
      expect(rerun).toMatchObject({ id, ok: true, type })
      expect(calls).toHaveLength(1)
    },
  )

  it.each(sessionJobs)(
    'publishes cancellation that arrives while %s runs %s, once',
    async (type, method) => {
      const id = `late-cancelled-${type}`
      let cancelQueued = false
      const { core, calls } = makeSessionJobCore((called) => {
        if (called !== method || cancelQueued) return
        cancelQueued = true
        void cancel(core, id)
      })
      const sessionId = await openSessionId(core)

      const cancelled = await core.handleRequest(
        sessionRequest(type, sessionId, id),
      )
      const rerun = await core.handleRequest(
        sessionRequest(type, sessionId, id),
      )

      expect(cancelled).toEqual({
        id,
        ok: false,
        type,
        error: {
          code: 'RAW_JOB_CANCELLED',
          message: 'RAW runtime job was cancelled.',
        },
      })
      expect(rerun).toMatchObject({ id, ok: true, type })
      expect(calls).toEqual([method, method])
    },
  )

  it.each(sessionJobs)(
    'keeps a %s native failure ahead of cancellation queued during %s',
    async (type, method) => {
      const id = `failed-cancelled-${type}`
      const { core } = makeSessionJobCore((called) => {
        if (called !== method) return
        void cancel(core, id)
        throw new Error(`${method} exploded`)
      })
      const sessionId = await openSessionId(core)

      await expect(
        core.handleRequest(sessionRequest(type, sessionId, id)),
      ).resolves.toEqual({
        id,
        ok: false,
        type,
        error: {
          code: rawRequestFailureFallbackCodes[type],
          message: `${method} exploded`,
        },
      })
    },
  )

  it.each(sessionJobs)(
    'reports an unknown session for %s without native work',
    async (type) => {
      const { core, calls } = makeSessionJobCore()
      await openSessionId(core)

      await expect(
        core.handleRequest(sessionRequest(type, 'raw-session-missing')),
      ).resolves.toEqual({
        id: `classify-${type}`,
        ok: false,
        type,
        error: {
          code: 'RAW_WORKER_PROTOCOL_ERROR',
          message: 'RAW runtime session does not exist: raw-session-missing',
        },
      })
      expect(calls).toEqual([])
    },
  )

  it('validates bounded HQ options after cancellation and before the session lookup', async () => {
    const { core, calls } = makeSessionJobCore()
    const invalid = (id: string): LumaRawWorkerRequest => ({
      id,
      type: 'decodeBoundedHqFromSession',
      payload: { sessionId: 'raw-session-missing', maxOutputPixels: 0 },
    })

    await cancel(core, 'invalid-hq-cancelled')
    const cancelled = await core.handleRequest(invalid('invalid-hq-cancelled'))
    const rejected = await core.handleRequest(invalid('invalid-hq'))

    expect(cancelled).toMatchObject({
      ok: false,
      error: { code: 'RAW_JOB_CANCELLED' },
    })
    expect(rejected).toEqual({
      id: 'invalid-hq',
      ok: false,
      type: 'decodeBoundedHqFromSession',
      error: {
        code: 'RAW_WORKER_PROTOCOL_ERROR',
        message:
          'RAW runtime bounded HQ maxOutputPixels must be a positive finite number.',
      },
    })
    expect(calls).toEqual([])
  })

  it.each([
    ['readProcessedWindowFromSession', 'readProcessedWindow'],
    ['applyCalibrationToSession', 'applyCalibration'],
  ] as const)(
    'looks up the session before reporting missing %s support',
    async (type, method) => {
      const core = createRuntimeCore({
        createProcessor() {
          const processor = makeNativeFactory().createProcessor()
          return { ...processor, [method]: undefined }
        },
      })

      await cancel(core, `missing-${type}-cancelled`)
      const cancelled = await core.handleRequest(
        sessionRequest(
          type,
          'raw-session-missing',
          `missing-${type}-cancelled`,
        ),
      )
      const unknownSession = await core.handleRequest(
        sessionRequest(type, 'raw-session-missing'),
      )

      expect(cancelled).toMatchObject({
        ok: false,
        error: { code: 'RAW_JOB_CANCELLED' },
      })
      expect(unknownSession).toMatchObject({
        ok: false,
        error: {
          code: 'RAW_WORKER_PROTOCOL_ERROR',
          message: 'RAW runtime session does not exist: raw-session-missing',
        },
      })
    },
  )
})
