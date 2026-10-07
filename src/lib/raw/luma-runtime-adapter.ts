import type {
  LumaEmbeddedPreview,
  LumaRawCameraCalibrationProfile,
  LumaRawErrorCode,
  LumaRawExportCapability,
  LumaRawExportUnsupportedReason,
  LumaRawRuntime,
} from '@lumaforge/luma-raw-runtime'
import { JPEG_RUNTIME_UNAVAILABLE_MESSAGE } from '@lumaforge/render-engine/export'
import { deriveInteractivePolicy } from '@lumaforge/render-engine/policy'

import {
  detectCapabilityVector,
  getCapabilityVectorSnapshot,
} from '~/lib/runtime/capability-vector'
import { RawDecodeBridge } from '~/lib/workers/raw-decode-bridge'

import { frameToDecodedImage } from './decoded-image'
import type {
  DecodedImage,
  DecodeExposureOptions,
  ProgressCallback,
} from './decoder'
import { QUICK_PREVIEW_MAX_PIXELS } from './decoder'
import type {
  JpegRuntimeAvailabilityProbe,
  RawRuntimeSession,
} from './runtime-adapter'

export type PrewarmState = 'idle' | 'pending' | 'ready' | 'failed'

export interface PrewarmOutcome {
  status: 'ready' | 'failed'
  reason?: string
  recoverable?: boolean
}

let prewarmState: PrewarmState = 'idle'
let prewarmOutcome: PrewarmOutcome | null = null
let prewarmInFlight: Promise<PrewarmOutcome> | null = null

let singletonBridge = createDefaultRawDecodeBridge()
const runtimeFactoryBridges = new Map<() => LumaRawRuntime, RawDecodeBridge>()

/** The decode bridge operations a RAW stage runs on. */
export type RawDecodeBridgePort = Pick<
  RawDecodeBridge,
  | 'prewarm'
  | 'openSession'
  | 'decodeEmbedded'
  | 'decodeQuick'
  | 'decodeBoundedHq'
>

type RawAdapterErrorCode = LumaRawErrorCode | 'RAW_BOUNDED_HQ_DECODE_FAILED'

export class RawAdapterError extends Error {
  readonly code: RawAdapterErrorCode

  constructor(
    code: RawAdapterErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'RawAdapterError'
    this.code = code
  }
}

/** The preview RAW runtime sized by the interactive policy for this device. */
export async function createDefaultLumaRawRuntime(): Promise<LumaRawRuntime> {
  const { createLumaRawRuntime } = await import('@lumaforge/luma-raw-runtime')
  const capability =
    getCapabilityVectorSnapshot() ?? (await detectCapabilityVector())
  const policy = deriveInteractivePolicy(capability)

  return createLumaRawRuntime({
    memoryProfile: policy.previewWorkerMemoryProfile,
    requireCrossOriginIsolation:
      policy.previewWorkerMemoryProfile === 'desktop',
  })
}

function createDefaultRawDecodeBridge() {
  return new RawDecodeBridge({ runtimeFactory: createDefaultLumaRawRuntime })
}

function getRawDecodeBridge(runtimeFactory?: () => LumaRawRuntime) {
  if (runtimeFactory) {
    const existing = runtimeFactoryBridges.get(runtimeFactory)
    if (existing) return existing

    const bridge = new RawDecodeBridge({ runtimeFactory })
    runtimeFactoryBridges.set(runtimeFactory, bridge)
    return bridge
  }

  return singletonBridge
}

export function createRuntimeSignal(signal?: AbortSignal) {
  return signal ?? new AbortController().signal
}

async function resetRawDecodeBridges() {
  const bridges = [singletonBridge, ...runtimeFactoryBridges.values()]
  singletonBridge = createDefaultRawDecodeBridge()
  runtimeFactoryBridges.clear()
  await Promise.all(bridges.map((bridge) => bridge.terminate()))
}

function getRawErrorCode(error: unknown): RawAdapterErrorCode | undefined {
  if (typeof error !== 'object' || !error || !('code' in error)) {
    return undefined
  }

  const code = (error as { code?: unknown }).code
  if (typeof code === 'string' && code.startsWith('RAW_')) {
    return code as RawAdapterErrorCode
  }

  return undefined
}

function normalizeRawAdapterError(
  error: unknown,
  fallbackCode: RawAdapterErrorCode,
) {
  const code = getRawErrorCode(error) ?? fallbackCode
  const message =
    error instanceof Error ? error.message : 'RAW runtime request failed.'

  return new RawAdapterError(code, message, { cause: error })
}

function getUnsupportedExportFactReasons(capability: LumaRawExportCapability) {
  const reasons: LumaRawExportUnsupportedReason[] = []

  if (
    capability.strategy !== 'libraw-processed-window' ||
    capability.windows.librawProcessed !== true
  ) {
    reasons.push('processed-window-unavailable')
  }

  const color = capability.color
  const hasRuntimeColorProcessingFacts =
    color !== undefined &&
    'cameraWhiteBalanceAppliedByRuntime' in color &&
    'cameraMatrixAppliedByRuntime' in color

  if (
    !hasRuntimeColorProcessingFacts ||
    color.workingSpace !== 'linear-prophoto-rgb' ||
    color.cameraWhiteBalanceAppliedByRuntime !== true ||
    color.cameraMatrixAppliedByRuntime !== true
  ) {
    reasons.push('missing-color-transform')
  }

  return reasons
}

function createJpegRuntimeUnavailableProbeError(cause?: unknown) {
  return new Error(JPEG_RUNTIME_UNAVAILABLE_MESSAGE, { cause })
}

async function assertJpegRuntimeAvailable(
  probe?: JpegRuntimeAvailabilityProbe,
) {
  if (!probe) {
    return
  }

  try {
    if (await probe()) {
      return
    }
  } catch (error) {
    throw createJpegRuntimeUnavailableProbeError(error)
  }

  throw createJpegRuntimeUnavailableProbeError(
    new Error('JPEG runtime readiness probe returned unavailable.'),
  )
}

async function resolveExportCapability(
  rawCapability: LumaRawExportCapability,
  jpegRuntimeAvailabilityProbe?: JpegRuntimeAvailabilityProbe,
): Promise<LumaRawExportCapability> {
  if (!rawCapability.supported) {
    return rawCapability
  }

  const unsupportedFactReasons = getUnsupportedExportFactReasons(rawCapability)
  if (unsupportedFactReasons.length > 0) {
    return {
      ...rawCapability,
      supported: false,
      reasons: unsupportedFactReasons,
    }
  }

  await assertJpegRuntimeAvailable(jpegRuntimeAvailabilityProbe)

  return rawCapability
}

export function prewarmLumaRawRuntime(
  runtimeFactory?: () => LumaRawRuntime,
  signal?: AbortSignal,
): Promise<PrewarmOutcome> {
  if (prewarmState === 'ready' && prewarmOutcome) {
    return Promise.resolve(prewarmOutcome)
  }
  // Only an irrecoverable failure stays cached until dispose; after a
  // recoverable one the next explicit call starts a fresh attempt.
  if (prewarmState === 'failed' && prewarmOutcome?.recoverable === false) {
    return Promise.resolve(prewarmOutcome)
  }
  if (prewarmInFlight) {
    return prewarmInFlight
  }
  prewarmState = 'pending'
  prewarmInFlight = (async () => {
    try {
      const bridge = getRawDecodeBridge(runtimeFactory)
      await bridge.prewarm(createRuntimeSignal(signal))
      const outcome: PrewarmOutcome = { status: 'ready' }
      prewarmOutcome = outcome
      prewarmState = 'ready'
      return outcome
    } catch (error) {
      const outcome = toPrewarmFailureOutcome(error)
      prewarmOutcome = outcome
      prewarmState = 'failed'
      return outcome
    } finally {
      prewarmInFlight = null
    }
  })()
  return prewarmInFlight
}

export function getPrewarmStateForLuma(): PrewarmState {
  return prewarmState
}

/**
 * A missing cross-origin isolation cannot change without a reload, so it is
 * the one prewarm failure a later attempt cannot recover from.
 */
export function toPrewarmFailureOutcome(error: unknown): PrewarmOutcome {
  const code = getRawErrorCode(error)
  if (code === 'RAW_CROSS_ORIGIN_ISOLATION_REQUIRED') {
    return {
      status: 'failed',
      reason: error instanceof Error ? error.message : code,
      recoverable: false,
    }
  }
  const reason =
    error instanceof Error ? error.message : 'RAW runtime prewarm failed.'
  return { status: 'failed', reason, recoverable: true }
}

export async function extractEmbeddedPreviewOnBridge(
  bridge: RawDecodeBridgePort,
  file: File,
  signal?: AbortSignal,
): Promise<LumaEmbeddedPreview | null> {
  const runtimeSignal = createRuntimeSignal(signal)
  try {
    await bridge.prewarm(runtimeSignal)
    return bridge.decodeEmbedded(runtimeSignal, file, runtimeSignal)
  } catch (error) {
    throw normalizeRawAdapterError(error, 'RAW_THUMBNAIL_UNAVAILABLE')
  }
}

export async function decodeQuickRawOnBridge(
  bridge: RawDecodeBridgePort,
  file: File,
  onProgress?: ProgressCallback,
  signal?: AbortSignal,
): Promise<DecodedImage> {
  const runtimeSignal = createRuntimeSignal(signal)
  try {
    onProgress?.({ phase: 'loading', progress: 0 })

    await bridge.prewarm(runtimeSignal)

    onProgress?.({ phase: 'decoding', progress: 50 })

    const frame = await bridge.decodeQuick(runtimeSignal, file, runtimeSignal)

    onProgress?.({ phase: 'complete', progress: 100 })

    return frameToDecodedImage(frame)
  } catch (error) {
    throw normalizeRawAdapterError(error, 'RAW_QUICK_DECODE_FAILED')
  }
}

export async function decodeBoundedHqRawOnBridge(
  bridge: RawDecodeBridgePort,
  file: File,
  options: { maxOutputPixels: number },
  onProgress?: ProgressCallback,
  signal?: AbortSignal,
): Promise<DecodedImage> {
  const runtimeSignal = createRuntimeSignal(signal)
  try {
    onProgress?.({ phase: 'decoding', progress: 0 })
    await bridge.prewarm(runtimeSignal)
    const frame = await bridge.decodeBoundedHq(
      runtimeSignal,
      file,
      options,
      runtimeSignal,
    )
    onProgress?.({ phase: 'complete', progress: 100 })
    return frameToDecodedImage(frame)
  } catch (error) {
    throw normalizeRawAdapterError(error, 'RAW_BOUNDED_HQ_DECODE_FAILED')
  }
}

export async function openRawSessionOnBridge(
  bridge: RawDecodeBridgePort,
  file: File,
  signal?: AbortSignal,
  jpegRuntimeAvailabilityProbe?: JpegRuntimeAvailabilityProbe,
): Promise<RawRuntimeSession> {
  let session: Awaited<ReturnType<LumaRawRuntime['openSession']>>
  const runtimeSignal = createRuntimeSignal(signal)
  try {
    await bridge.prewarm(runtimeSignal)
    session = await bridge.openSession(
      runtimeSignal,
      file,
      {
        maxOutputPixels: QUICK_PREVIEW_MAX_PIXELS,
      },
      runtimeSignal,
    )
  } catch (error) {
    throw normalizeRawAdapterError(error, 'RAW_OPEN_FAILED')
  }

  return {
    sourceDimensions: {
      width: session.probe.width,
      height: session.probe.height,
    },
    async extractEmbeddedPreview(signal?: AbortSignal) {
      try {
        return await session.extractEmbeddedPreview(signal)
      } catch (error) {
        throw normalizeRawAdapterError(error, 'RAW_THUMBNAIL_UNAVAILABLE')
      }
    },
    async probeExportCapability(
      signal?: AbortSignal,
    ): Promise<LumaRawExportCapability> {
      const rawCapability = await session.probeExportCapability(signal)
      return resolveExportCapability(
        rawCapability,
        jpegRuntimeAvailabilityProbe,
      )
    },
    async decodeQuickRaw(
      onProgress?: ProgressCallback,
      signal?: AbortSignal,
      exposureOptions?: DecodeExposureOptions,
    ) {
      try {
        onProgress?.({ phase: 'decoding', progress: 50 })
        const frame = await session.decodeQuick(
          {
            maxOutputPixels: QUICK_PREVIEW_MAX_PIXELS,
          },
          signal,
        )
        onProgress?.({ phase: 'complete', progress: 100 })
        return frameToDecodedImage(frame, exposureOptions)
      } catch (error) {
        throw normalizeRawAdapterError(error, 'RAW_QUICK_DECODE_FAILED')
      }
    },
    async decodeBoundedHqRaw(
      {
        maxOutputPixels,
        pinnedExposure,
      }: { maxOutputPixels: number } & DecodeExposureOptions,
      onProgress?: ProgressCallback,
      signal?: AbortSignal,
    ) {
      try {
        onProgress?.({ phase: 'decoding', progress: 0 })
        // The pin is resolved on this side; the runtime request only carries
        // the decode bound.
        const frame = await session.decodeBoundedHq({ maxOutputPixels }, signal)
        onProgress?.({ phase: 'complete', progress: 100 })
        return frameToDecodedImage(frame, { pinnedExposure })
      } catch (error) {
        throw normalizeRawAdapterError(error, 'RAW_BOUNDED_HQ_DECODE_FAILED')
      }
    },
    async applyCalibration(
      profile: LumaRawCameraCalibrationProfile,
      signal?: AbortSignal,
    ) {
      try {
        return await session.applyCalibration(profile, signal)
      } catch (error) {
        throw normalizeRawAdapterError(error, 'RAW_RUNTIME_UNAVAILABLE')
      }
    },
    dispose() {
      session.dispose()
    },
  }
}

export function extractEmbeddedPreviewWithLuma(
  file: File,
  runtimeFactory?: () => LumaRawRuntime,
  signal?: AbortSignal,
): Promise<LumaEmbeddedPreview | null> {
  return extractEmbeddedPreviewOnBridge(
    getRawDecodeBridge(runtimeFactory),
    file,
    signal,
  )
}

export function decodeQuickRawWithLuma(
  file: File,
  onProgress?: ProgressCallback,
  runtimeFactory?: () => LumaRawRuntime,
  signal?: AbortSignal,
): Promise<DecodedImage> {
  return decodeQuickRawOnBridge(
    getRawDecodeBridge(runtimeFactory),
    file,
    onProgress,
    signal,
  )
}

export function decodeBoundedHqRawWithLuma(
  file: File,
  options: { maxOutputPixels: number },
  onProgress?: ProgressCallback,
  runtimeFactory?: () => LumaRawRuntime,
  signal?: AbortSignal,
): Promise<DecodedImage> {
  return decodeBoundedHqRawOnBridge(
    getRawDecodeBridge(runtimeFactory),
    file,
    options,
    onProgress,
    signal,
  )
}

export function openRawSessionWithLuma(
  file: File,
  runtimeFactory?: () => LumaRawRuntime,
  signal?: AbortSignal,
  jpegRuntimeAvailabilityProbe?: JpegRuntimeAvailabilityProbe,
): Promise<RawRuntimeSession> {
  return openRawSessionOnBridge(
    getRawDecodeBridge(runtimeFactory),
    file,
    signal,
    jpegRuntimeAvailabilityProbe,
  )
}

export function disposeLumaRawRuntime() {
  void resetRawDecodeBridges()
  prewarmState = 'idle'
  prewarmOutcome = null
  prewarmInFlight = null
}

export function terminateLumaRawDecodeBridge() {
  return resetRawDecodeBridges()
}

export function toRawAdapterError(error: unknown) {
  const code = getRawErrorCode(error)
  if (code) return code

  if (error instanceof Error) {
    return error.message
  }

  return 'RAW_RUNTIME_UNAVAILABLE'
}
