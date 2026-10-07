import type {
  LumaEmbeddedPreview,
  LumaRawCameraCalibrationProfile,
  LumaRawExportCapability,
} from '@lumaforge/luma-raw-runtime'

import type {
  DecodedImage,
  DecodeExposureOptions,
  ProgressCallback,
} from './decoder'

export type PrewarmState = 'idle' | 'pending' | 'ready' | 'failed'

export interface PrewarmOutcome {
  status: 'ready' | 'failed'
  reason?: string
  recoverable?: boolean
}

export type RawRuntimeSession = {
  sourceDimensions: {
    width?: number
    height?: number
  }
  extractEmbeddedPreview: (
    signal?: AbortSignal,
  ) => Promise<LumaEmbeddedPreview | null>
  probeExportCapability?: (
    signal?: AbortSignal,
  ) => Promise<LumaRawExportCapability>
  decodeQuickRaw: (
    onProgress?: ProgressCallback,
    signal?: AbortSignal,
    exposureOptions?: DecodeExposureOptions,
  ) => Promise<DecodedImage>
  decodeBoundedHqRaw: (
    options: { maxOutputPixels: number } & DecodeExposureOptions,
    onProgress?: ProgressCallback,
    signal?: AbortSignal,
  ) => Promise<DecodedImage>
  applyCalibration: (
    profile: LumaRawCameraCalibrationProfile,
    signal?: AbortSignal,
  ) => Promise<{ applied: true }>
  dispose: () => void
}

export type JpegRuntimeAvailabilityProbe = () => boolean | Promise<boolean>
