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
import { QUICK_PREVIEW_MAX_PIXELS } from './decoder'
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

export function createRuntimeSignal(signal?: AbortSignal) {
  return signal ?? new AbortController().signal
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
      reasons: [
        ...new Set(
          assessment.reasons.map((refusal) => EXPORT_REFUSAL_REASONS[refusal]),
        ),
      ],
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

export function toRawAdapterError(error: unknown) {
  const code = getRawErrorCode(error)
  if (code) return code

  if (error instanceof Error) {
    return error.message
  }

  return 'RAW_RUNTIME_UNAVAILABLE'
}
