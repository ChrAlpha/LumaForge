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
let cachedPreviewGpuCapability: PreviewGpuCapabilitySnapshot | null | undefined

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

function toPositiveInteger(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : 0
}

function shouldSkipDefaultCanvasWebgl2Probe(canvas: HTMLCanvasElement) {
  return (
    typeof WebGL2RenderingContext === 'undefined' &&
    typeof HTMLCanvasElement !== 'undefined' &&
    canvas instanceof HTMLCanvasElement &&
    canvas.getContext === HTMLCanvasElement.prototype.getContext
  )
}

function requestPreviewWebGL2Context(
  canvas: HTMLCanvasElement,
): WebGL2RenderingContext | null {
  try {
    const strictContext = canvas.getContext('webgl2', {
      alpha: false,
      depth: false,
      stencil: false,
      antialias: false,
      premultipliedAlpha: false,
      preserveDrawingBuffer: false,
      powerPreference: 'high-performance',
    })
    if (strictContext) return strictContext
  } catch {
    // Plain WebGL2 is still enough to size preview resources.
  }

  try {
    return canvas.getContext('webgl2')
  } catch {
    return null
  }
}

export function detectPreviewGpuCapabilitySnapshot(): PreviewGpuCapabilitySnapshot | null {
  const backend = getPreviewBackendSnapshot()
  if (backend) {
    return Object.freeze({
      // Preserve the existing policy ABI; this flag means a usable GPU preview.
      webgl2: backend.backend !== 'cpu',
      maxTextureSize: backend.maxTextureSize,
      maxRenderbufferSize: backend.maxRenderbufferSize,
    })
  }
  if (cachedPreviewGpuCapability !== undefined) {
    return cachedPreviewGpuCapability
  }

  if (typeof document === 'undefined') {
    return null
  }

  const canvas = document.createElement('canvas')
  if (shouldSkipDefaultCanvasWebgl2Probe(canvas)) {
    return null
  }

  const gl = requestPreviewWebGL2Context(canvas)

  if (!gl) {
    cachedPreviewGpuCapability = Object.freeze({
      webgl2: false,
      maxTextureSize: 0,
      maxRenderbufferSize: 0,
    })
    return cachedPreviewGpuCapability
  }

  try {
    cachedPreviewGpuCapability = Object.freeze({
      webgl2: true,
      maxTextureSize: toPositiveInteger(gl.getParameter(gl.MAX_TEXTURE_SIZE)),
      maxRenderbufferSize: toPositiveInteger(
        gl.getParameter(gl.MAX_RENDERBUFFER_SIZE),
      ),
    })
    return cachedPreviewGpuCapability
  } finally {
    gl.getExtension('WEBGL_lose_context')?.loseContext()
  }
}

export function resetPreviewGpuCapabilityForTest() {
  cachedPreviewGpuCapability = undefined
}
