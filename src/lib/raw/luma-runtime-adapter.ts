import { resolveRawRenderExposure } from '@lumaforge/luma-color-runtime'
import type {
  LumaEmbeddedPreview,
  LumaRawCameraCalibrationProfile,
  LumaRawErrorCode,
  LumaRawExportCapability,
  LumaRawExportUnsupportedReason,
  LumaRawFrame,
  LumaRawRuntime,
} from '@lumaforge/luma-raw-runtime'
import { JPEG_RUNTIME_UNAVAILABLE_MESSAGE } from '@lumaforge/render-engine/export'
import { deriveInteractivePolicy } from '@lumaforge/render-engine/policy'

import {
  detectCapabilityVector,
  getCapabilityVectorSnapshot,
} from '~/lib/runtime/capability-vector'
import { RawDecodeBridge } from '~/lib/workers/raw-decode-bridge'

import type { DecodedImage, ImageMetadata, ProgressCallback } from './decoder'
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

function createDefaultRawDecodeBridge() {
  return new RawDecodeBridge({
    runtimeFactory: async () => {
      const { createLumaRawRuntime } =
        await import('@lumaforge/luma-raw-runtime')
      const capability =
        getCapabilityVectorSnapshot() ?? (await detectCapabilityVector())
      const policy = deriveInteractivePolicy(capability)

      return createLumaRawRuntime({
        memoryProfile: policy.previewWorkerMemoryProfile,
        requireCrossOriginIsolation:
          policy.previewWorkerMemoryProfile === 'desktop',
      })
    },
  })
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

function createRuntimeSignal(signal?: AbortSignal) {
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

function formatLumaShutter(shutter?: number) {
  return typeof shutter === 'number' ? `${shutter}s` : undefined
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

export function metadataToImageMetadata(frame: LumaRawFrame): ImageMetadata {
  return {
    make: frame.metadata.make,
    model: frame.metadata.model,
    lens: frame.metadata.lens,
    iso: frame.metadata.iso,
    aperture: frame.metadata.aperture,
    focalLength: frame.metadata.focalLength,
    shutterSpeed: formatLumaShutter(frame.metadata.shutter),
    timestamp:
      typeof frame.metadata.timestamp === 'number'
        ? new Date(frame.metadata.timestamp * 1000)
        : undefined,
    width: frame.metadata.width ?? frame.width,
    height: frame.metadata.height ?? frame.height,
    orientation: frame.metadata.orientation ?? frame.orientation,
    baselineExposure: frame.metadata.baselineExposure,
  }
}

export function frameToDecodedImage(frame: LumaRawFrame): DecodedImage {
  const metadata = metadataToImageMetadata(frame)

  return {
    width: frame.width,
    height: frame.height,
    channels: 3,
    bitsPerChannel: 16,
    data: frame.data,
    layout: 'rgb-u16',
    colorSpace: 'linear-prophoto-rgb',
    source: frame.source,
    timings: { ...frame.timings },
    metadata,
    renderExposure: resolveRawRenderExposure({
      metadata,
      image: {
        data: frame.data,
        width: frame.width,
        height: frame.height,
      },
    }),
  }
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
      const classification = classifyPrewarmFailure(error)
      const outcome: PrewarmOutcome = {
        status: 'failed',
        reason: classification.reason,
        recoverable: classification.recoverable,
      }
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

function classifyPrewarmFailure(error: unknown): {
  reason: string
  recoverable: boolean
} {
  const code = getRawErrorCode(error)
  if (code === 'RAW_CROSS_ORIGIN_ISOLATION_REQUIRED') {
    return {
      reason: error instanceof Error ? error.message : code,
      recoverable: false,
    }
  }
  const reason =
    error instanceof Error ? error.message : 'RAW runtime prewarm failed.'
  return { reason, recoverable: true }
}

export async function extractEmbeddedPreviewWithLuma(
  file: File,
  runtimeFactory?: () => LumaRawRuntime,
  signal?: AbortSignal,
): Promise<LumaEmbeddedPreview | null> {
  const runtimeSignal = createRuntimeSignal(signal)
  try {
    const bridge = getRawDecodeBridge(runtimeFactory)
    await bridge.prewarm(runtimeSignal)
    return bridge.decodeEmbedded(runtimeSignal, file, runtimeSignal)
  } catch (error) {
    throw normalizeRawAdapterError(error, 'RAW_THUMBNAIL_UNAVAILABLE')
  }
}

export async function decodeQuickRawWithLuma(
  file: File,
  onProgress?: ProgressCallback,
  runtimeFactory?: () => LumaRawRuntime,
  signal?: AbortSignal,
): Promise<DecodedImage> {
  const runtimeSignal = createRuntimeSignal(signal)
  try {
    onProgress?.({ phase: 'loading', progress: 0 })

    const bridge = getRawDecodeBridge(runtimeFactory)
    await bridge.prewarm(runtimeSignal)

    onProgress?.({ phase: 'decoding', progress: 50 })

    const frame = await bridge.decodeQuick(runtimeSignal, file, runtimeSignal)

    onProgress?.({ phase: 'complete', progress: 100 })

    return frameToDecodedImage(frame)
  } catch (error) {
    throw normalizeRawAdapterError(error, 'RAW_QUICK_DECODE_FAILED')
  }
}

export async function decodeBoundedHqRawWithLuma(
  file: File,
  options: { maxOutputPixels: number },
  onProgress?: ProgressCallback,
  runtimeFactory?: () => LumaRawRuntime,
  signal?: AbortSignal,
): Promise<DecodedImage> {
  const runtimeSignal = createRuntimeSignal(signal)
  try {
    onProgress?.({ phase: 'decoding', progress: 0 })
    const bridge = getRawDecodeBridge(runtimeFactory)
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

export async function openRawSessionWithLuma(
  file: File,
  runtimeFactory?: () => LumaRawRuntime,
  signal?: AbortSignal,
  jpegRuntimeAvailabilityProbe?: JpegRuntimeAvailabilityProbe,
): Promise<RawRuntimeSession> {
  let session: Awaited<ReturnType<LumaRawRuntime['openSession']>>
  const runtimeSignal = createRuntimeSignal(signal)
  try {
    const bridge = getRawDecodeBridge(runtimeFactory)
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
    async decodeQuickRaw(onProgress?: ProgressCallback, signal?: AbortSignal) {
      try {
        onProgress?.({ phase: 'decoding', progress: 50 })
        const frame = await session.decodeQuick(
          {
            maxOutputPixels: QUICK_PREVIEW_MAX_PIXELS,
          },
          signal,
        )
        onProgress?.({ phase: 'complete', progress: 100 })
        return frameToDecodedImage(frame)
      } catch (error) {
        throw normalizeRawAdapterError(error, 'RAW_QUICK_DECODE_FAILED')
      }
    },
    async decodeBoundedHqRaw(
      options: { maxOutputPixels: number },
      onProgress?: ProgressCallback,
      signal?: AbortSignal,
    ) {
      try {
        onProgress?.({ phase: 'decoding', progress: 0 })
        const frame = await session.decodeBoundedHq(options, signal)
        onProgress?.({ phase: 'complete', progress: 100 })
        return frameToDecodedImage(frame)
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
