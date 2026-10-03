import { getPreviewBackendSnapshot } from '~/lib/preview/gpu-backend'
import {
  BOUNDED_HQ_PREVIEW_LOW_MEMORY_MAX_PIXELS,
  BOUNDED_HQ_PREVIEW_MAX_PIXELS,
  QUICK_PREVIEW_MAX_PIXELS,
} from '~/lib/raw/decoder'

import type { CapabilityVector } from './capability-vector'

export interface PreviewGpuCapabilitySnapshot {
  readonly webgl2: boolean
  readonly maxTextureSize: number
  readonly maxRenderbufferSize: number
}

export interface PreviewGpuBudget {
  readonly boundedHqMaxPixels: number
  readonly dualWebglAllowed: boolean
  readonly originalReferenceSnapshotMaxPixels: number
}

const DESKTOP_PERFORMANCE_PREVIEW_MAX_PIXELS = 16_000_000
const DUAL_WEBGL_MIN_DIMENSION = 4096

function hasKnownLowMemory(capability: CapabilityVector) {
  return capability.deviceMemoryGB != null && capability.deviceMemoryGB <= 4
}

function getPreviewTargetPixels(capability: CapabilityVector) {
  if (hasKnownLowMemory(capability)) {
    return BOUNDED_HQ_PREVIEW_LOW_MEMORY_MAX_PIXELS
  }

  if (
    capability.webKitClass === 'chromium' &&
    capability.deviceFormFactor === 'desktop' &&
    capability.pthread
  ) {
    return DESKTOP_PERFORMANCE_PREVIEW_MAX_PIXELS
  }

  return BOUNDED_HQ_PREVIEW_MAX_PIXELS
}

function getSourceAspectRatio(sourceWidth: number, sourceHeight: number) {
  if (
    !Number.isFinite(sourceWidth) ||
    !Number.isFinite(sourceHeight) ||
    sourceWidth <= 0 ||
    sourceHeight <= 0
  ) {
    return 1
  }

  return (
    Math.max(sourceWidth, sourceHeight) / Math.min(sourceWidth, sourceHeight)
  )
}

function getDimensionLimitedPixels({
  sourceWidth,
  sourceHeight,
  maxDimension,
}: {
  sourceWidth: number
  sourceHeight: number
  maxDimension: number
}) {
  if (!Number.isFinite(maxDimension) || maxDimension <= 0) {
    return QUICK_PREVIEW_MAX_PIXELS
  }

  const aspectRatio = getSourceAspectRatio(sourceWidth, sourceHeight)
  return Math.max(
    QUICK_PREVIEW_MAX_PIXELS,
    Math.floor((maxDimension * maxDimension) / aspectRatio),
  )
}

export function derivePreviewGpuBudget({
  capability,
  gpu,
  sourceWidth,
  sourceHeight,
}: {
  capability: CapabilityVector
  gpu: PreviewGpuCapabilitySnapshot
  sourceWidth: number
  sourceHeight: number
}): PreviewGpuBudget {
  if (!gpu.webgl2) {
    return Object.freeze({
      boundedHqMaxPixels: QUICK_PREVIEW_MAX_PIXELS,
      dualWebglAllowed: false,
      originalReferenceSnapshotMaxPixels: QUICK_PREVIEW_MAX_PIXELS,
    })
  }

  const maxDimension = Math.min(gpu.maxTextureSize, gpu.maxRenderbufferSize)
  const targetPixels = getPreviewTargetPixels(capability)
  const dimensionLimitedPixels = getDimensionLimitedPixels({
    sourceWidth,
    sourceHeight,
    maxDimension,
  })

  const boundedHqMaxPixels = Math.min(targetPixels, dimensionLimitedPixels)
  const dualWebglAllowed =
    !hasKnownLowMemory(capability) &&
    maxDimension >= DUAL_WEBGL_MIN_DIMENSION &&
    boundedHqMaxPixels >= BOUNDED_HQ_PREVIEW_LOW_MEMORY_MAX_PIXELS

  return Object.freeze({
    boundedHqMaxPixels,
    dualWebglAllowed,
    originalReferenceSnapshotMaxPixels: boundedHqMaxPixels,
  })
}

/** GPU facts come from the resolved preview backend; there is no second probe. */
export function detectPreviewGpuCapabilitySnapshot(): PreviewGpuCapabilitySnapshot | null {
  const backend = getPreviewBackendSnapshot()
  if (!backend) return null
  return Object.freeze({
    webgl2: backend.backend !== 'cpu',
    maxTextureSize: backend.maxTextureSize,
    maxRenderbufferSize: backend.maxTextureSize,
  })
}
