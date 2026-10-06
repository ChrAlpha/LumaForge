import type {
  LumaEmbeddedPreview,
  LumaRawCameraCalibrationProfile,
  LumaRawExportCapability,
  LumaRawRuntime,
} from '@lumaforge/luma-raw-runtime'
import { isWasmJpegRuntimeAvailable } from '@lumaforge/render-engine/export'

import type {
  DecodedImage,
  DecodeExposureOptions,
  ProgressCallback,
} from './decoder'
import {
  decodeBoundedHqRawWithLuma,
  decodeQuickRawWithLuma,
  extractEmbeddedPreviewWithLuma,
  getPrewarmStateForLuma,
  openRawSessionWithLuma,
  prewarmLumaRawRuntime,
  terminateLumaRawDecodeBridge,
} from './luma-runtime-adapter'
export type { PrewarmOutcome, PrewarmState } from './luma-runtime-adapter'

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

export type RawRuntimeAdapter = {
  prewarm: () => Promise<import('./luma-runtime-adapter').PrewarmOutcome>
  getPrewarmState: () => import('./luma-runtime-adapter').PrewarmState
  openSession: (file: File, signal?: AbortSignal) => Promise<RawRuntimeSession>
  extractEmbeddedPreview: (file: File) => Promise<LumaEmbeddedPreview | null>
  decodeQuickRaw: (
    file: File,
    onProgress?: ProgressCallback,
  ) => Promise<DecodedImage>
  decodeBoundedHqRaw: (
    file: File,
    options: { maxOutputPixels: number },
    onProgress?: ProgressCallback,
  ) => Promise<DecodedImage>
  terminateDecodeBridge: () => Promise<void>
}

export type JpegRuntimeAvailabilityProbe = () => boolean | Promise<boolean>

export function createRawRuntimeAdapter({
  lumaRuntimeFactory,
  jpegRuntimeAvailabilityProbe = isWasmJpegRuntimeAvailable,
}: {
  lumaRuntimeFactory?: () => LumaRawRuntime
  jpegRuntimeAvailabilityProbe?: JpegRuntimeAvailabilityProbe
} = {}): RawRuntimeAdapter {
  return {
    prewarm() {
      return prewarmLumaRawRuntime(lumaRuntimeFactory)
    },
    getPrewarmState() {
      return getPrewarmStateForLuma()
    },
    openSession(file, signal) {
      return openRawSessionWithLuma(
        file,
        lumaRuntimeFactory,
        signal,
        jpegRuntimeAvailabilityProbe,
      )
    },
    extractEmbeddedPreview(file) {
      return extractEmbeddedPreviewWithLuma(file, lumaRuntimeFactory)
    },
    decodeQuickRaw(file, onProgress) {
      return decodeQuickRawWithLuma(file, onProgress, lumaRuntimeFactory)
    },
    decodeBoundedHqRaw(file, options, onProgress) {
      return decodeBoundedHqRawWithLuma(
        file,
        options,
        onProgress,
        lumaRuntimeFactory,
      )
    },
    terminateDecodeBridge() {
      return terminateLumaRawDecodeBridge()
    },
  }
}

export const rawRuntimeAdapter = createRawRuntimeAdapter()
