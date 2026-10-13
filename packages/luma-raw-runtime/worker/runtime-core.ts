import { version as runtimeVersion } from '../package.json'
import type { LumaRawErrorCode } from '../src/errors'
import { LumaRawRuntimeError, normalizeRawRuntimeError } from '../src/errors'
import type {
  LumaEmbeddedPreview,
  LumaRawExportCapability,
  LumaRawFrame,
  LumaRawHeapStats,
  LumaRawMetadata,
  LumaRawProbe,
  LumaRawRuntimeInfo,
  LumaRawRuntimeMemoryProfile,
  LumaRawSessionInfo,
  LumaRawTimings,
} from '../src/types'
import type {
  LumaRawWorkerRequest,
  LumaRawWorkerRequestType,
  LumaRawWorkerResponse,
} from '../src/worker-protocol'
import { normalizeExportCapability } from './native-adapter'
import type {
  LumaRawNativeCalibrationPayload,
  LumaRawNativeFactory,
  LumaRawNativeImage,
  LumaRawNativeMetadata,
  LumaRawNativeOpenSettings,
  LumaRawNativeOpenTimings,
  LumaRawNativeProcessor,
  LumaRawNativeThumbnail,
} from './native-types'
import type { RawSessionJobContext, RawWorkerRequestRef } from './session-job'
import { runSessionJob } from './session-job'

const quickSettings = {
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

const hqSettings = {
  ...quickSettings,
  halfSize: false,
  userQual: 2,
} satisfies LumaRawNativeOpenSettings

const maxCancelledJobIds = 128
const defaultQuickMaxOutputPixels = 2_500_000

type Timer = {
  mark: (name: Exclude<keyof LumaRawTimings, 'total'>) => void
  assign: (values: Partial<LumaRawTimings>) => void
  finish: () => LumaRawTimings
}

type RuntimeSession = {
  sessionId: string
  openRequestId: string
  processor: LumaRawNativeProcessor
  maxOutputPixels?: number
}

type RuntimeCoreOptions = {
  memoryProfile?: LumaRawRuntimeMemoryProfile
}

function now() {
  return globalThis.performance?.now() ?? Date.now()
}

function createTimer(): Timer {
  const start = now()
  let last = start
  const timings: Partial<LumaRawTimings> = {}

  return {
    mark(name) {
      const current = now()
      timings[name] = current - last
      last = current
    },
    assign(values) {
      Object.assign(timings, values)
      last = now()
    },
    finish() {
      return {
        ...timings,
        total: now() - start,
      }
    },
  }
}

function getRuntimeInfo(
  memoryProfile: LumaRawRuntimeMemoryProfile,
): LumaRawRuntimeInfo {
  const hardwareConcurrency =
    typeof globalThis.navigator?.hardwareConcurrency === 'number'
      ? globalThis.navigator.hardwareConcurrency
      : 1
  const workerPoolSize =
    memoryProfile === 'low-memory'
      ? 1
      : Math.max(1, Math.min(4, hardwareConcurrency))
  const isolated =
    'crossOriginIsolated' in globalThis
      ? Boolean(globalThis.crossOriginIsolated)
      : false

  return {
    runtime: 'luma',
    version: runtimeVersion,
    simd: true,
    pthreads: memoryProfile === 'desktop',
    crossOriginIsolated: isolated,
    memoryTier: memoryProfile === 'low-memory' ? 'low' : 'normal',
    memoryProfile,
    workerPoolSize,
  }
}

function toMetadata(metadata: LumaRawNativeMetadata): LumaRawMetadata {
  return {
    width: metadata.width,
    height: metadata.height,
    rawWidth: metadata.rawWidth,
    rawHeight: metadata.rawHeight,
    make: metadata.make,
    model: metadata.model,
    lens: metadata.lens,
    iso: metadata.iso,
    aperture: metadata.aperture,
    focalLength: metadata.focalLength,
    shutter: metadata.shutter,
    timestamp: metadata.timestamp,
    orientation: metadata.orientation,
    blackLevel: metadata.blackLevel,
    whiteLevel: metadata.whiteLevel,
    dataMaximum: metadata.dataMaximum,
    perChannelBlack: metadata.perChannelBlack,
    blackStat: metadata.blackStat,
    baselineExposure: metadata.baselineExposure,
    thumbnail: metadata.thumbnail,
    supportLevel:
      metadata.width !== undefined && metadata.height !== undefined
        ? 'experimental'
        : 'unsupported',
  }
}

function toMimeType(thumbnail: LumaRawNativeThumbnail) {
  // "bitmap" is native/raw bitmap bytes, not a PNG container. Only advertise
  // image/png once a native adapter exposes an explicit PNG-encoded format.
  return thumbnail.format === 'jpeg' ? 'image/jpeg' : 'application/octet-stream'
}

function asOpenTiming(value: unknown, label: keyof LumaRawNativeOpenTimings) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new TypeError(
      `Native RAW openBuffer returned invalid ${label} timing.`,
    )
  }

  return value
}

function maybeOpenTiming(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : undefined
}

function normalizeOpenTimings(
  timings: unknown,
): LumaRawNativeOpenTimings | undefined {
  if (timings === undefined) return undefined
  if (timings === null || typeof timings !== 'object') {
    return undefined
  }

  const raw = timings as Record<string, unknown>
  const copyToWasm = maybeOpenTiming(raw.copyToWasm)
  const librawOpen = maybeOpenTiming(raw.librawOpen)
  if (copyToWasm === undefined || librawOpen === undefined) {
    return undefined
  }

  return {
    copyToWasm,
    librawOpen,
  }
}

function normalizeRequiredOpenTimings(timings: unknown) {
  const openTimings = normalizeOpenTimings(timings)
  if (!openTimings) {
    throw new TypeError('Native RAW openBuffer returned invalid timing data.')
  }

  return openTimings
}

function normalizeLoadBufferTimings(timings: unknown) {
  if (
    timings === null ||
    timings === undefined ||
    typeof timings !== 'object'
  ) {
    throw new TypeError('Native RAW openBuffer returned invalid timing data.')
  }

  const raw = timings as Record<string, unknown>

  return {
    copyToWasm: asOpenTiming(raw.copyToWasm, 'copyToWasm'),
  }
}

function openProcessorWithSettings(
  processor: LumaRawNativeProcessor,
  settings: LumaRawNativeOpenSettings,
  timer: Timer,
  copyToWasmOffset = 0,
) {
  const openTimings = normalizeRequiredOpenTimings(
    processor.openWithSettings(settings),
  )
  const copyToWasm = copyToWasmOffset + openTimings.copyToWasm
  timer.assign({
    copyToWasm,
    librawOpen: openTimings.librawOpen,
    openBuffer: copyToWasm + openTimings.librawOpen,
  })
}

// Unclassified throws take the code of the operation that failed. Errors that
// already carry a runtime code (cancellation, memory, protocol, format) keep it.
export const rawRequestFailureFallbackCodes = {
  init: 'RAW_RUNTIME_UNAVAILABLE',
  cancel: 'RAW_RUNTIME_UNAVAILABLE',
  openSession: 'RAW_OPEN_FAILED',
  closeSession: 'RAW_RUNTIME_UNAVAILABLE',
  probe: 'RAW_OPEN_FAILED',
  extractEmbeddedPreview: 'RAW_THUMBNAIL_UNAVAILABLE',
  extractEmbeddedPreviewFromSession: 'RAW_THUMBNAIL_UNAVAILABLE',
  decodeQuick: 'RAW_QUICK_DECODE_FAILED',
  decodeQuickFromSession: 'RAW_QUICK_DECODE_FAILED',
  decodeBoundedHq: 'RAW_HQ_DECODE_FAILED',
  decodeBoundedHqFromSession: 'RAW_HQ_DECODE_FAILED',
  probeExportCapabilityFromSession: 'RAW_METADATA_FAILED',
  readRawWindowFromSession: 'RAW_WINDOW_READ_FAILED',
  readProcessedWindowFromSession: 'RAW_WINDOW_READ_FAILED',
  applyCalibrationToSession: 'RAW_CALIBRATION_FAILED',
} as const satisfies Record<LumaRawWorkerRequestType, LumaRawErrorCode>

function failureResponse(
  request: RawWorkerRequestRef,
  error: unknown,
): LumaRawWorkerResponse {
  const runtimeError = normalizeRawRuntimeError(
    error,
    rawRequestFailureFallbackCodes[request.type],
  )

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

function cancelledResponse(
  request: RawWorkerRequestRef,
): LumaRawWorkerResponse {
  return failureResponse(
    request,
    new LumaRawRuntimeError(
      'RAW_JOB_CANCELLED',
      'RAW runtime job was cancelled.',
    ),
  )
}

function createProbePayload(
  id: string,
  nativeMetadata: LumaRawNativeMetadata,
  timings: LumaRawTimings,
): LumaRawProbe {
  return {
    ...toMetadata(nativeMetadata),
    jobId: id,
    timings,
  }
}

function createFramePayload(
  request: LumaRawWorkerRequest<
    | 'decodeQuick'
    | 'decodeBoundedHq'
    | 'decodeQuickFromSession'
    | 'decodeBoundedHqFromSession'
  >,
  nativeMetadata: LumaRawNativeMetadata,
  image: LumaRawNativeImage,
  timings: LumaRawTimings,
  heap?: LumaRawHeapStats,
): LumaRawFrame {
  const metadata = toMetadata(nativeMetadata)
  const isBoundedHq = isBoundedHqRequest(request)

  return {
    jobId: request.id,
    sessionId: request.payload.sessionId,
    source: isBoundedHq ? 'bounded-hq' : 'quick',
    width: image.width,
    height: image.height,
    data: image.data,
    layout: 'rgb',
    bitDepth: image.bits,
    colorSpace: 'linear-prophoto-rgb',
    orientation: metadata.orientation ?? 1,
    blackLevel: metadata.blackLevel,
    whiteLevel: metadata.whiteLevel,
    metadata,
    timings,
    ...(heap ? { heap } : {}),
  }
}

function isBoundedHqRequest(
  request: LumaRawWorkerRequest,
): request is LumaRawWorkerRequest<
  'decodeBoundedHq' | 'decodeBoundedHqFromSession'
> {
  return (
    request.type === 'decodeBoundedHq' ||
    request.type === 'decodeBoundedHqFromSession'
  )
}

function requireBoundedHqMaxOutputPixels(
  request: LumaRawWorkerRequest<
    'decodeBoundedHq' | 'decodeBoundedHqFromSession'
  >,
) {
  const maxOutputPixels = (request.payload as { maxOutputPixels?: unknown })
    .maxOutputPixels
  if (
    typeof maxOutputPixels !== 'number' ||
    !Number.isFinite(maxOutputPixels) ||
    maxOutputPixels <= 0
  ) {
    throw new LumaRawRuntimeError(
      'RAW_WORKER_PROTOCOL_ERROR',
      'RAW runtime bounded HQ maxOutputPixels must be a positive finite number.',
    )
  }

  return maxOutputPixels
}

const CALIBRATION_MATRIX_LENGTH = 9
const CALIBRATION_TONE_CURVE_MIN_ENTRIES = 4096

function malformedCalibration(message: string): LumaRawRuntimeError {
  return new LumaRawRuntimeError(
    'RAW_WORKER_PROTOCOL_ERROR',
    `RAW runtime calibration ${message}`,
  )
}

// A calibration request whose payload is not a finite row-major 3x3 matrix,
// with an optional tone-curve LUT of at least 4096 finite entries, is
// malformed: it is refused as a protocol error before native work, so a native
// calibration failure keeps its own code.
function requireCalibrationPayload(
  request: LumaRawWorkerRequest<'applyCalibrationToSession'>,
): LumaRawNativeCalibrationPayload {
  const calibration = (request.payload as { cameraCalibration?: unknown })
    .cameraCalibration
  if (typeof calibration !== 'object' || calibration === null) {
    throw malformedCalibration('payload must be a camera calibration profile.')
  }

  const { xyzToCamera, toneCurveLut } = calibration as {
    xyzToCamera?: unknown
    toneCurveLut?: unknown
  }
  if (
    !(xyzToCamera instanceof Float32Array) ||
    xyzToCamera.length !== CALIBRATION_MATRIX_LENGTH ||
    !xyzToCamera.every(Number.isFinite)
  ) {
    throw malformedCalibration(
      'xyzToCamera must be a Float32Array of 9 finite values.',
    )
  }
  if (toneCurveLut === undefined) {
    return { xyzToCamera }
  }
  if (
    !(toneCurveLut instanceof Float32Array) ||
    toneCurveLut.length < CALIBRATION_TONE_CURVE_MIN_ENTRIES ||
    !toneCurveLut.every(Number.isFinite)
  ) {
    throw malformedCalibration(
      'toneCurveLut must be a Float32Array of at least 4096 finite entries.',
    )
  }

  return { xyzToCamera, toneCurveLut }
}

function captureHeap(nativeFactory: LumaRawNativeFactory) {
  return nativeFactory.heapBytes?.()
}

function heapStats(
  before?: number,
  after?: number,
): LumaRawHeapStats | undefined {
  if (before === undefined && after === undefined) return undefined
  return {
    before,
    after,
    peak: Math.max(before ?? 0, after ?? 0),
  }
}

function unsupportedRawWindowCapability(): LumaRawExportCapability {
  return {
    supported: false,
    width: 0,
    height: 0,
    rawWidth: 0,
    rawHeight: 0,
    cfa: { pattern: 'unsupported' as const, xPhase: 0, yPhase: 0 },
    blackLevel: 0,
    whiteLevel: 0,
    orientation: { code: 1, supported: true },
    sensor: {
      layout: 'unknown',
      colorCount: 0,
      cfa: { pattern: 'unsupported' as const, xPhase: 0, yPhase: 0 },
      phaseIsWindowLocal: false,
    },
    windows: { librawProcessed: false, rawMosaic: false },
    diagnostics: {
      hasRawImage: false,
      hasColor3Image: false,
      hasColor4Image: false,
      hasXTransTable: false,
    },
    reasons: ['raw-window-unavailable'],
  }
}

export function createRuntimeCore(
  nativeFactory: LumaRawNativeFactory,
  options: RuntimeCoreOptions = {},
) {
  const memoryProfile = options.memoryProfile ?? 'desktop'
  const cancelledJobIds = new Set<string>()
  const cancelledJobQueue: string[] = []
  const sessions = new Map<string, RuntimeSession>()
  const sessionsByOpenRequestId = new Map<string, RuntimeSession>()
  let sessionCounter = 0

  function nextSessionId() {
    sessionCounter += 1
    return `raw-session-${sessionCounter}`
  }

  function requireSession(sessionId: string) {
    const session = sessions.get(sessionId)
    if (!session) {
      throw new LumaRawRuntimeError(
        'RAW_WORKER_PROTOCOL_ERROR',
        `RAW runtime session does not exist: ${sessionId}`,
      )
    }

    return session
  }

  function rememberCancellation(jobId: string) {
    if (cancelledJobIds.has(jobId)) return

    cancelledJobIds.add(jobId)
    cancelledJobQueue.push(jobId)

    while (cancelledJobQueue.length > maxCancelledJobIds) {
      const expiredJobId = cancelledJobQueue.shift()
      if (expiredJobId) {
        cancelledJobIds.delete(expiredJobId)
      }
    }
  }

  function consumeCancellation(request: RawWorkerRequestRef) {
    const wasCancelled = cancelledJobIds.delete(request.id)
    if (!wasCancelled) return false

    const index = cancelledJobQueue.indexOf(request.id)
    if (index !== -1) {
      cancelledJobQueue.splice(index, 1)
    }
    return true
  }

  const sessionJobs: RawSessionJobContext<RuntimeSession> = {
    consumeCancellation,
    requireSession,
    cancelledResponse,
  }

  function handleFileRequest(
    request: LumaRawWorkerRequest<
      'probe' | 'extractEmbeddedPreview' | 'decodeQuick' | 'decodeBoundedHq'
    >,
  ): LumaRawWorkerResponse {
    if (consumeCancellation(request)) {
      return cancelledResponse(request)
    }

    const boundedHqMaxOutputPixels = isBoundedHqRequest(request)
      ? requireBoundedHqMaxOutputPixels(request)
      : undefined
    const timer = createTimer()
    const settings = isBoundedHqRequest(request) ? hqSettings : quickSettings
    const heapBefore =
      request.type === 'probe' ? undefined : captureHeap(nativeFactory)
    const processor = nativeFactory.createProcessor()
    let response: LumaRawWorkerResponse | undefined
    let primaryError: unknown
    let disposeError: unknown

    try {
      const openStart = now()
      const openTimings = normalizeOpenTimings(
        processor.openBuffer(
          new Uint8Array(request.payload.fileBuffer),
          settings,
        ),
      )
      const openElapsed = now() - openStart
      timer.assign(
        openTimings
          ? {
              copyToWasm: openTimings.copyToWasm,
              librawOpen: openTimings.librawOpen,
              openBuffer: openTimings.copyToWasm + openTimings.librawOpen,
            }
          : {
              openBuffer: openElapsed,
            },
      )

      const nativeMetadata = processor.readMetadata()
      timer.mark('metadata')

      if (request.type === 'probe') {
        response = {
          id: request.id,
          ok: true,
          type: request.type,
          payload: createProbePayload(
            request.id,
            nativeMetadata,
            timer.finish(),
          ),
        }
      } else if (request.type === 'extractEmbeddedPreview') {
        const thumbnail = processor.extractThumbnail()
        timer.mark('thumbnail')
        const heapAfter = captureHeap(nativeFactory)
        const heap = heapStats(heapBefore, heapAfter)

        const payload: LumaEmbeddedPreview | null = thumbnail
          ? {
              jobId: request.id,
              sessionId: request.payload.sessionId,
              source: 'embedded',
              width: thumbnail.width,
              height: thumbnail.height,
              data: thumbnail.data,
              mimeType: toMimeType(thumbnail),
              colorSpace: 'display-srgb-preview',
              orientation: nativeMetadata.orientation ?? 1,
              timings: timer.finish(),
              ...(heap ? { heap } : {}),
            }
          : null

        response = {
          id: request.id,
          ok: true,
          type: request.type,
          payload,
        }
      } else {
        const image = isBoundedHqRequest(request)
          ? processor.decodeHq({
              maxOutputPixels: boundedHqMaxOutputPixels,
            })
          : processor.decodePreview({
              maxOutputPixels: defaultQuickMaxOutputPixels,
            })
        timer.mark('unpack')
        const heapAfter = captureHeap(nativeFactory)

        response = {
          id: request.id,
          ok: true,
          type: request.type,
          payload: createFramePayload(
            request,
            nativeMetadata,
            image,
            timer.finish(),
            heapStats(heapBefore, heapAfter),
          ),
        }
      }
    } catch (error) {
      primaryError = error
    } finally {
      try {
        processor.dispose()
      } catch (error) {
        disposeError = error
      }

      if (!primaryError && response?.ok && consumeCancellation(request)) {
        response = cancelledResponse(request)
      }
    }

    if (primaryError) {
      throw primaryError
    }
    if (disposeError) {
      throw disposeError
    }

    return response ?? cancelledResponse(request)
  }

  function disposeSession(session: RuntimeSession) {
    sessions.delete(session.sessionId)
    sessionsByOpenRequestId.delete(session.openRequestId)
    session.processor.dispose()
  }

  function disposeSessionForOpenRequest(openRequestId: string) {
    const session = sessionsByOpenRequestId.get(openRequestId)
    if (!session) return false

    disposeSession(session)
    return true
  }

  function handleOpenSession(
    request: LumaRawWorkerRequest<'openSession'>,
  ): LumaRawWorkerResponse {
    if (consumeCancellation(request)) {
      return cancelledResponse(request)
    }

    const timer = createTimer()
    const heapBefore = captureHeap(nativeFactory)
    const sessionId = nextSessionId()
    const processor = nativeFactory.createProcessor()
    let session: RuntimeSession | undefined
    let response: LumaRawWorkerResponse | undefined
    let primaryError: unknown
    let disposeError: unknown

    try {
      const loadTimings = normalizeLoadBufferTimings(
        processor.loadBuffer(new Uint8Array(request.payload.fileBuffer)),
      )
      openProcessorWithSettings(
        processor,
        quickSettings,
        timer,
        loadTimings.copyToWasm,
      )

      const nativeMetadata = processor.readMetadata()
      timer.mark('metadata')
      const timings = timer.finish()
      const heapAfter = captureHeap(nativeFactory)
      const heap = heapStats(heapBefore, heapAfter)
      session = {
        sessionId,
        openRequestId: request.id,
        processor,
        maxOutputPixels: request.payload.maxOutputPixels,
      }
      sessions.set(sessionId, session)
      sessionsByOpenRequestId.set(request.id, session)

      const payload: LumaRawSessionInfo = {
        sessionId,
        probe: createProbePayload(request.id, nativeMetadata, timings),
        timings,
        ...(heap ? { heap } : {}),
      }

      response = {
        id: request.id,
        ok: true,
        type: request.type,
        payload,
      }
    } catch (error) {
      primaryError = error
    } finally {
      if (primaryError && !session) {
        try {
          processor.dispose()
        } catch (error) {
          disposeError = error
        }
      }

      if (!primaryError && response?.ok && consumeCancellation(request)) {
        if (session) {
          try {
            disposeSession(session)
          } catch (error) {
            disposeError = error
          }
        }
        response = cancelledResponse(request)
      }
    }

    if (primaryError) {
      throw primaryError
    }
    if (disposeError) {
      throw disposeError
    }

    return response ?? cancelledResponse(request)
  }

  function handleCloseSession(
    request: LumaRawWorkerRequest<'closeSession'>,
  ): LumaRawWorkerResponse {
    const session = requireSession(request.payload.sessionId)
    disposeSession(session)

    return {
      id: request.id,
      ok: true,
      type: request.type,
      payload: { closed: true },
    }
  }

  function handleExtractEmbeddedPreviewFromSession(
    request: LumaRawWorkerRequest<'extractEmbeddedPreviewFromSession'>,
  ): LumaRawWorkerResponse {
    return runSessionJob(sessionJobs, request, {
      run(session) {
        const timer = createTimer()
        const heapBefore = captureHeap(nativeFactory)

        openProcessorWithSettings(session.processor, quickSettings, timer)
        const nativeMetadata = session.processor.readMetadata()
        timer.mark('metadata')

        const thumbnail = session.processor.extractThumbnail()
        timer.mark('thumbnail')
        const heapAfter = captureHeap(nativeFactory)
        const heap = heapStats(heapBefore, heapAfter)

        return thumbnail
          ? {
              jobId: request.id,
              sessionId: session.sessionId,
              source: 'embedded',
              width: thumbnail.width,
              height: thumbnail.height,
              data: thumbnail.data,
              mimeType: toMimeType(thumbnail),
              colorSpace: 'display-srgb-preview',
              orientation: nativeMetadata.orientation ?? 1,
              timings: timer.finish(),
              ...(heap ? { heap } : {}),
            }
          : null
      },
    })
  }

  function handleDecodeFromSession(
    request: LumaRawWorkerRequest<
      'decodeQuickFromSession' | 'decodeBoundedHqFromSession'
    >,
  ): LumaRawWorkerResponse {
    return runSessionJob(sessionJobs, request, {
      options: (job) =>
        isBoundedHqRequest(job)
          ? requireBoundedHqMaxOutputPixels(job)
          : undefined,
      run(session, boundedHqMaxOutputPixels) {
        const timer = createTimer()
        const heapBefore = captureHeap(nativeFactory)
        const settings = isBoundedHqRequest(request)
          ? hqSettings
          : quickSettings

        openProcessorWithSettings(session.processor, settings, timer)
        const nativeMetadata = session.processor.readMetadata()
        timer.mark('metadata')

        const image = isBoundedHqRequest(request)
          ? session.processor.decodeHq({
              maxOutputPixels: boundedHqMaxOutputPixels,
            })
          : session.processor.decodePreview({
              maxOutputPixels:
                request.payload.maxOutputPixels ??
                session.maxOutputPixels ??
                defaultQuickMaxOutputPixels,
            })
        timer.mark('unpack')
        const heapAfter = captureHeap(nativeFactory)

        return createFramePayload(
          request,
          nativeMetadata,
          image,
          timer.finish(),
          heapStats(heapBefore, heapAfter),
        )
      },
    })
  }

  function handleProbeExportCapabilityFromSession(
    request: LumaRawWorkerRequest<'probeExportCapabilityFromSession'>,
  ): LumaRawWorkerResponse {
    return runSessionJob(sessionJobs, request, {
      run(session) {
        openProcessorWithSettings(
          session.processor,
          quickSettings,
          createTimer(),
        )

        return session.processor.probeExportCapability
          ? normalizeExportCapability(session.processor.probeExportCapability())
          : unsupportedRawWindowCapability()
      },
    })
  }

  function handleReadRawWindowFromSession(
    request: LumaRawWorkerRequest<'readRawWindowFromSession'>,
  ): LumaRawWorkerResponse {
    return runSessionJob(sessionJobs, request, {
      run(session) {
        if (!session.processor.readRawWindow) {
          throw new LumaRawRuntimeError(
            'RAW_UNSUPPORTED_FORMAT',
            'RAW runtime raw-window access is unavailable for this source.',
          )
        }

        return session.processor.readRawWindow(request.payload.rect)
      },
    })
  }

  function handleReadProcessedWindowFromSession(
    request: LumaRawWorkerRequest<'readProcessedWindowFromSession'>,
  ): LumaRawWorkerResponse {
    return runSessionJob(sessionJobs, request, {
      run(session) {
        if (!session.processor.readProcessedWindow) {
          throw new LumaRawRuntimeError(
            'RAW_RUNTIME_UNAVAILABLE',
            'RAW runtime processed-window access is unavailable for this source.',
          )
        }

        return session.processor.readProcessedWindow(request.payload.request)
      },
    })
  }

  function handleApplyCalibrationToSession(
    request: LumaRawWorkerRequest<'applyCalibrationToSession'>,
  ): LumaRawWorkerResponse {
    return runSessionJob(sessionJobs, request, {
      options: requireCalibrationPayload,
      run(session, calibration) {
        if (!session.processor.applyCalibration) {
          throw new LumaRawRuntimeError(
            'RAW_RUNTIME_UNAVAILABLE',
            'RAW runtime calibration application is unavailable for this source.',
          )
        }

        session.processor.applyCalibration(calibration)
        return { applied: true }
      },
    })
  }

  return {
    async handleRequest(
      request: LumaRawWorkerRequest,
    ): Promise<LumaRawWorkerResponse> {
      try {
        switch (request.type) {
          case 'init':
            return {
              id: request.id,
              ok: true,
              type: request.type,
              payload: getRuntimeInfo(
                request.payload.memoryProfile ?? memoryProfile,
              ),
            }
          case 'cancel':
            if (!disposeSessionForOpenRequest(request.payload.targetJobId)) {
              rememberCancellation(request.payload.targetJobId)
            }
            return {
              id: request.id,
              ok: true,
              type: request.type,
              payload: { cancelled: true },
            }
          case 'openSession':
            return handleOpenSession(request)
          case 'closeSession':
            return handleCloseSession(request)
          case 'extractEmbeddedPreviewFromSession':
            return handleExtractEmbeddedPreviewFromSession(request)
          case 'probeExportCapabilityFromSession':
            return handleProbeExportCapabilityFromSession(request)
          case 'readRawWindowFromSession':
            return handleReadRawWindowFromSession(request)
          case 'readProcessedWindowFromSession':
            return handleReadProcessedWindowFromSession(request)
          case 'applyCalibrationToSession':
            return handleApplyCalibrationToSession(request)
          case 'decodeQuickFromSession':
          case 'decodeBoundedHqFromSession':
            return handleDecodeFromSession(request)
          case 'probe':
          case 'extractEmbeddedPreview':
          case 'decodeQuick':
          case 'decodeBoundedHq':
            return handleFileRequest(request)
        }
      } catch (error) {
        return failureResponse(request, error)
      }
    },
  }
}

export type LumaRawRuntimeCore = ReturnType<typeof createRuntimeCore>
