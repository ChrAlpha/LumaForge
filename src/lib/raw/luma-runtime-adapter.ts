import type {
  LumaEmbeddedPreview,
  LumaRawCameraCalibrationProfile,
  LumaRawErrorCode,
  LumaRawExportCapability,
  LumaRawExportUnsupportedReason,
  LumaRawRuntime,
} from '@lumaforge/luma-raw-runtime'
import type { ProcessedExportRefusal } from '@lumaforge/render-engine/export'
import {
  assessProcessedExport,
  JPEG_RUNTIME_UNAVAILABLE_MESSAGE,
} from '@lumaforge/render-engine/export'
import { deriveInteractivePolicy } from '@lumaforge/render-engine/policy'
import { QUICK_PREVIEW_MAX_PIXELS } from '@lumaforge/render-engine/preview'

import {
  detectCapabilityVector,
  getCapabilityVectorSnapshot,
} from '~/lib/runtime/capability-vector'
import type { RawDecodeBridge } from '~/lib/workers/raw-decode-bridge'

import { frameToDecodedImage } from './decoded-image'
import type {
  DecodedImage,
  DecodeExposureOptions,
  ProgressCallback,
} from './decoder'
import type {
  JpegRuntimeAvailabilityProbe,
  PrewarmOutcome,
  RawRuntimeSession,
} from './runtime-adapter'

/** The decode bridge operations a RAW stage runs on. */
export type RawDecodeBridgePort = Pick<
  RawDecodeBridge,
  | 'prewarm'
  | 'openSession'
  | 'decodeEmbedded'
  | 'decodeQuick'
  | 'decodeBoundedHq'
>

export class RawAdapterError extends Error {
  readonly code: LumaRawErrorCode

  constructor(code: LumaRawErrorCode, message: string, options?: ErrorOptions) {
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

export function createRuntimeSignal(signal?: AbortSignal) {
  return signal ?? new AbortController().signal
}

function getRawErrorCode(error: unknown): LumaRawErrorCode | undefined {
  if (typeof error !== 'object' || !error || !('code' in error)) {
    return undefined
  }

  const code = (error as { code?: unknown }).code
  if (typeof code === 'string' && code.startsWith('RAW_')) {
    return code as LumaRawErrorCode
  }

  return undefined
}

export function isAbortError(error: unknown) {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { name?: unknown }).name === 'AbortError'
  )
}

/**
 * The code a failed RAW request reports. Work its owner cancelled is
 * `RAW_JOB_CANCELLED` whatever the aborted or terminated worker answered, so
 * a cancellation never reads as a corrupt source or a failed stage. Otherwise
 * a published RAW code wins, an abort or termination without one is a
 * cancellation, and only the rest take the operation's fallback.
 */
function normalizeRawAdapterError(
  error: unknown,
  fallbackCode: LumaRawErrorCode,
  signal?: AbortSignal,
) {
  const code = signal?.aborted
    ? 'RAW_JOB_CANCELLED'
    : (getRawErrorCode(error) ??
      (isAbortError(error) ? 'RAW_JOB_CANCELLED' : fallbackCode))
  const message =
    error instanceof Error ? error.message : 'RAW runtime request failed.'

  return new RawAdapterError(code, message, { cause: error })
}

/** The error a RAW request ended by its owner rejects with. */
export function rawJobCancelledError(message: string) {
  return new RawAdapterError('RAW_JOB_CANCELLED', message)
}

/** The runtime reason each engine refusal is reported under. */
const EXPORT_REFUSAL_REASONS: Record<
  ProcessedExportRefusal,
  LumaRawExportUnsupportedReason
> = {
  'source-unsupported': 'unsupported-source',
  'invalid-dimensions': 'missing-dimensions',
  'strategy-not-processed-window': 'processed-window-unavailable',
  'processed-windows-unavailable': 'processed-window-unavailable',
  'color-facts-missing': 'missing-color-transform',
  'working-space-not-linear-prophoto': 'missing-color-transform',
  'white-balance-not-applied-by-runtime': 'missing-color-transform',
  'camera-matrix-not-applied-by-runtime': 'missing-color-transform',
}

/**
 * The runtime reasons engine refusals are reported under, each once, in the
 * order the assessment found them.
 */
export function toExportRefusalReasons(
  refusals: readonly ProcessedExportRefusal[],
): LumaRawExportUnsupportedReason[] {
  return [
    ...new Set(refusals.map((refusal) => EXPORT_REFUSAL_REASONS[refusal])),
  ]
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

  // The engine assessment is the full-resolution export's own admission
  // gate; a capability it refuses is reported unsupported before the JPEG
  // runtime is probed.
  const assessment = assessProcessedExport(rawCapability)
  if (!assessment.exportable) {
    return {
      ...rawCapability,
      supported: false,
      reasons: toExportRefusalReasons(assessment.reasons),
    }
  }

  await assertJpegRuntimeAvailable(jpegRuntimeAvailabilityProbe)

  return rawCapability
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
    return await bridge.decodeEmbedded(runtimeSignal, file, runtimeSignal)
  } catch (error) {
    throw normalizeRawAdapterError(
      error,
      'RAW_THUMBNAIL_UNAVAILABLE',
      runtimeSignal,
    )
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
    throw normalizeRawAdapterError(
      error,
      'RAW_QUICK_DECODE_FAILED',
      runtimeSignal,
    )
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
    throw normalizeRawAdapterError(error, 'RAW_HQ_DECODE_FAILED', runtimeSignal)
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
    throw normalizeRawAdapterError(error, 'RAW_OPEN_FAILED', runtimeSignal)
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
        throw normalizeRawAdapterError(
          error,
          'RAW_THUMBNAIL_UNAVAILABLE',
          signal,
        )
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
        throw normalizeRawAdapterError(error, 'RAW_QUICK_DECODE_FAILED', signal)
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
        throw normalizeRawAdapterError(error, 'RAW_HQ_DECODE_FAILED', signal)
      }
    },
    async applyCalibration(
      profile: LumaRawCameraCalibrationProfile,
      signal?: AbortSignal,
    ) {
      try {
        return await session.applyCalibration(profile, signal)
      } catch (error) {
        throw normalizeRawAdapterError(error, 'RAW_RUNTIME_UNAVAILABLE', signal)
      }
    },
    dispose() {
      session.dispose()
    },
  }
}

export function toRawAdapterError(error: unknown) {
  const code = getRawErrorCode(error)
  if (code) return code

  if (error instanceof Error) {
    return error.message
  }

  return 'RAW_RUNTIME_UNAVAILABLE'
}
