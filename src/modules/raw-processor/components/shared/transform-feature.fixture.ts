import { vi } from 'vitest'

import { identityMatrix } from '~/lib/transform/geometry/matrix'
import type { ManualTransform } from '~/lib/transform/transform-types'
import { NEUTRAL_TRANSFORM } from '~/lib/transform/transform-types'

import type { RawTransformFeature } from '../../hooks/useRawTransformFeature'
import type { ProcessingStatus } from '../../model/workflow'
import type {
  ToolAvailability,
  ToolSurface,
  TransformPreviewObservation,
} from '../../services/surface/derive-tool-availability'
import { deriveToolAvailability } from '../../services/surface/derive-tool-availability'

export function transformFeatureFixture(
  overrides: Partial<RawTransformFeature> = {},
): RawTransformFeature {
  return {
    preview: {
      source: null,
      analysis: null,
      result: null,
      mode: 'off',
      manual: NEUTRAL_TRANSFORM,
      constrainCrop: true,
      loading: false,
      rendering: false,
      error: null,
      loadSource: vi.fn(),
      clearSource: vi.fn(),
      solveUpright: vi.fn(),
      retireFailure: vi.fn(),
      requestRender: vi.fn(),
      ready: false,
      solution: {
        matrix: identityMatrix(),
        confidence: 0,
        status: 'unchanged',
        reason: '',
        rotationDegrees: 0,
      },
    },
    active: false,
    available: false,
    previewSuspended: false,
    hasImage: false,
    observe: vi.fn(() => vi.fn()),
    busy: false,
    captureError: false,
    current: false,
    // A neutral Transform holds no geometry, so nothing blocks export.
    exportBlock: null,
    showLines: false,
    setShowLines: vi.fn(),
    showGrid: false,
    setShowGrid: vi.fn(),
    setMode: vi.fn(),
    setManual: vi.fn(),
    setConstrainCrop: vi.fn(),
    reset: vi.fn(),
    setCpuFrame: vi.fn(),
    showOverlay: false,
    ...overrides,
  }
}

/** What a Transform feature shows, with the intent the session holds. */
export type TransformPreviewState = RawTransformFeature['preview']

/**
 * A change to what a feature shows. `manual` merges over the feature's
 * current manual geometry, so a test names only the fields it moves.
 */
export type TransformPreviewPatch = Partial<
  Omit<TransformPreviewState, 'manual'>
> & { manual?: Partial<ManualTransform> }

/**
 * What the feature shows. Tests read the preview through this, and change it
 * only through the two helpers below, so the feature property has one name
 * the fixture owns.
 */
export function transformPreviewOf(
  feature: RawTransformFeature,
): TransformPreviewState {
  return feature.preview
}

function patchedPreview(
  feature: RawTransformFeature,
  { manual, ...patch }: TransformPreviewPatch,
): TransformPreviewState {
  const preview = transformPreviewOf(feature)
  return {
    ...preview,
    ...patch,
    manual: { ...preview.manual, ...manual },
  }
}

/** A copy of the feature showing the patch; the feature itself is unchanged. */
export function withTransformPreview(
  feature: RawTransformFeature,
  patch: TransformPreviewPatch,
): RawTransformFeature {
  return { ...feature, preview: patchedPreview(feature, patch) }
}

/**
 * Changes what the feature shows in place, for a fixture already handed to a
 * render that will read it again. Returns the same feature.
 */
export function patchTransformPreview(
  feature: RawTransformFeature,
  patch: TransformPreviewPatch,
): RawTransformFeature {
  feature.preview = patchedPreview(feature, patch)
  return feature
}

/**
 * A Transform state stated the way the tool provider reads it: the stage the
 * workflow is in, whether export released the preview, and what the
 * Transform preview observes of its frame.
 */
export interface TransformToolState {
  hasImage: boolean
  status: ProcessingStatus
  previewSuspended: boolean
  preview: TransformPreviewObservation
}

const NO_FRAME: TransformPreviewObservation = {
  canCapture: false,
  workerReady: false,
  captureFailed: false,
  current: false,
}
const READY_FRAME: TransformPreviewObservation = {
  canCapture: true,
  workerReady: true,
  captureFailed: false,
  current: true,
}

/** The states a Transform panel has to answer, by name. */
export const TRANSFORM_TOOL_STATES = {
  ready: {
    hasImage: true,
    status: 'ready',
    previewSuspended: false,
    preview: READY_FRAME,
  },
  noSource: {
    hasImage: false,
    status: 'idle',
    previewSuspended: false,
    preview: NO_FRAME,
  },
  noFrame: {
    hasImage: true,
    status: 'ready',
    previewSuspended: false,
    preview: NO_FRAME,
  },
  workerPending: {
    hasImage: true,
    status: 'ready',
    previewSuspended: false,
    preview: { ...NO_FRAME, canCapture: true },
  },
  captureFailed: {
    hasImage: true,
    status: 'ready',
    previewSuspended: false,
    preview: { ...READY_FRAME, captureFailed: true, current: false },
  },
  loading: {
    hasImage: true,
    status: 'loading',
    previewSuspended: false,
    preview: READY_FRAME,
  },
  decoding: {
    hasImage: true,
    status: 'decoding',
    previewSuspended: false,
    preview: READY_FRAME,
  },
  exporting: {
    hasImage: true,
    status: 'exporting',
    previewSuspended: false,
    preview: READY_FRAME,
  },
  released: {
    hasImage: true,
    status: 'ready',
    previewSuspended: true,
    preview: { ...NO_FRAME, workerReady: true },
  },
  warming: {
    hasImage: true,
    status: 'warming',
    previewSuspended: false,
    preview: READY_FRAME,
  },
  processing: {
    hasImage: true,
    status: 'processing',
    previewSuspended: false,
    preview: READY_FRAME,
  },
} satisfies Record<string, TransformToolState>

export type TransformToolStateName = keyof typeof TRANSFORM_TOOL_STATES

/**
 * The Transform feature for a state, and the surface's availability the
 * provider derives from the same facts through the shared selector.
 */
export function transformToolStateFixture(
  surface: ToolSurface,
  state: TransformToolState,
  overrides: Partial<RawTransformFeature> = {},
): { feature: RawTransformFeature; availability: ToolAvailability } {
  const { hasImage, status, previewSuspended, preview } = state
  const feature = transformFeatureFixture({
    hasImage,
    previewSuspended,
    available: preview.canCapture,
    captureError: preview.captureFailed,
    current: preview.current,
    ...overrides,
  })
  patchTransformPreview(feature, { ready: preview.workerReady })
  const availability = deriveToolAvailability({
    surface,
    hasImage,
    status,
    executor: 'webgpu',
    previewSuspended,
    transformActive: feature.active,
    transformExportBlock: feature.exportBlock,
    hasAppliedLut: false,
    canExport: false,
    lutContractBlocksExport: false,
    canPreviewExport: false,
    hasExportResult: false,
    transformPreview: preview,
  })
  return { feature, availability }
}
