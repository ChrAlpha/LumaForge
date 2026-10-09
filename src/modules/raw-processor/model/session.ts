import type {
  LUTColorProfile,
  LUTContractResolution,
} from '@lumaforge/luma-color-runtime'
import type { ExportGeometry } from '@lumaforge/render-engine/export'
import type { PerformancePreference } from '@lumaforge/render-engine/policy'

import type {
  ExportCheckpointMode,
  ExportExecutionProfileName,
  ExportOutputSink,
  ExportRuntimeMemoryProfile,
} from '~/lib/export/export-plan'
import type { PreviewViewMode } from '~/lib/preview/preview-view'
import type { ImageMetadata } from '~/lib/raw/decoder'
import type { UprightMode } from '~/lib/transform/geometry/types'
import type { ManualTransform } from '~/lib/transform/transform-types'

import type { ExportResult } from './export-result'

/**
 * The app certifies no camera, so a decodable source is experimental and only
 * a real runtime refusal is unsupported.
 */
export type SupportLevel = 'experimental' | 'unsupported'
export type PreviewStatus = 'idle' | 'loading' | 'ready' | 'failed' | 'skipped'
export type DisplaySource = 'embedded' | 'quick' | 'bounded-hq' | 'none'
export type FullResExportCapabilityState =
  | { status: 'unknown' }
  | { status: 'probing' }
  | { status: 'supported'; width: number; height: number }
  | { status: 'unsupported'; reason: string }

export type ActiveExportPlanState = {
  profileName: ExportExecutionProfileName
  preferredRows: number
  concurrency: number
  runtimeMemoryProfile: ExportRuntimeMemoryProfile
  outputSink: ExportOutputSink
  checkpointMode: ExportCheckpointMode
}

export type LUTContractSelectionState =
  | {
      status: 'confirmed'
      fingerprint: string
      profileId: string
      confidence: Extract<
        LUTContractResolution,
        { kind: 'confirmed' }
      >['confidence']
    }
  | {
      status: 'recommended'
      fingerprint: string
      title: string
      sourceName?: string
      recommendations: LUTColorProfile[]
    }
  | {
      status: 'unknown'
      fingerprint: string
      title: string
      sourceName?: string
    }
  | {
      status: 'unsupported-output'
      fingerprint: string
      title: string
      sourceName?: string
      recommendations: LUTColorProfile[]
    }

export type PreviewAsset = {
  status: PreviewStatus
  width?: number
  height?: number
  bitmap?: ImageBitmap | null
  objectUrl?: string
  mimeType?: string
  timings?: Record<string, number | undefined>
  errorCode?: string
}

export type PreviewBundle = {
  embeddedPreview: PreviewAsset
  quickDecodePreview: PreviewAsset
  boundedHqPreview: PreviewAsset
  displaySource: DisplaySource
  boundedHqRequiredForExport: false
}

export type StyleAsset = {
  kind: 'builtin' | 'custom'
  name: string
  /**
   * How much of the look reaches the photo, 0 (off) to 1 (all of it). The
   * preview, export and manifest all read this one continuous amount.
   */
  currentIntensity: number
  /** The amount a fresh look starts at and a Strength reset returns to. */
  defaultIntensity: number
  warning?: string
  lutAsset?: {
    format: 'cube'
    dimension: 17 | 33 | 65
    title?: string
    sourceName?: string
    fingerprint?: string
    /** SHA-256 of the .cube bytes; recorded in export manifests. */
    sha256?: string
    profileResolution?: LUTContractResolution
  }
  inputPrepProfile?: {
    profileId: string
    description: string
  }
}

/** What the Transform controls ask for. */
export type TransformIntent = {
  upright: UprightMode
  manual: ManualTransform
  constrainCrop: boolean
}

/**
 * The Transform of one source: the intent the controls set, and the answers
 * the preview gave for it. A capture is one frame of the photo, named by the
 * inputs it was read back with; a request is one render asked of that frame.
 * Only a render answering the newest request on the current capture is ever
 * accepted, so the accepted geometry always names the frame and request that
 * produced it. Overlay visibility and the worker are not part of it.
 */
export type TransformState = {
  sourceId: string
  intent: TransformIntent
  capture: { key: string; failed: boolean } | null
  /**
   * How many requests this state has taken. Request ids are numbered by the
   * client that posts them and start again with a new client, so each taken
   * request is also given the next of these as its `issued` number, which no
   * other request of this source ever holds.
   */
  issuedRequests: number
  /** The newest render asked of the current capture for this intent. */
  request: {
    captureKey: string
    requestId: number
    issued: number
    geometry: ExportGeometry
    failure: 'invalid' | 'unavailable' | null
  } | null
  /**
   * The last geometry a render answered for a non-neutral intent. It stays
   * held while a newer request is pending or failed; whether it still stands
   * for the intent is the derived status, not its presence. It answers the
   * newest request only while both hold the same `issued` number.
   */
  accepted: {
    captureKey: string
    requestId: number
    issued: number
    geometry: ExportGeometry
  } | null
}

export type ImageSession = {
  id: string
  createdAt: number
  sourceFile: {
    file?: File
    name: string
    extension: string
    sizeBytes: number
    metadata?: ImageMetadata
    rawFormat?: string
    cameraBrand?: string
    cameraModel?: string
    width?: number
    height?: number
    supportLevel: SupportLevel
  }
  previewBundle: PreviewBundle
  activeStyle: StyleAsset | null
  /**
   * Geometry the user committed in Transform, in source-normalized space.
   * Present means a geometry is applied; the full-resolution export reproduces
   * exactly this matrix, so it is the single source of truth rather than a
   * flag paired with state living somewhere else.
   */
  exportGeometry?: ExportGeometry | null
  /**
   * The Transform intent of this source and what the preview answered for it.
   * `exportGeometry` stays what the export reproduces until this state owns
   * it.
   */
  transform?: TransformState
  lutProfileSelection?: LUTContractSelectionState
  /**
   * The view of this source. The session is the only view owner while it
   * exists; mode and split never live in the color intent.
   */
  viewState: {
    mode: PreviewViewMode
    compareSplit: number
    zoom: number
    panX: number
    panY: number
    fitMode: 'screen' | 'custom'
  }
  renderState: {
    status: 'idle' | 'preparing' | 'rendering' | 'ready' | 'failed'
    lastRenderSource?: Extract<DisplaySource, 'quick' | 'bounded-hq'>
    lastErrorCode?: string
  }
  exportState: {
    status: 'idle' | 'preparing' | 'exporting' | 'ready' | 'failed'
    fullResCapability: FullResExportCapabilityState
    activePlan?: ActiveExportPlanState
    result?: ExportResult
    lastProgress?: {
      completedStrips: number
      totalStrips: number
    }
    recommendedRetryLevel?: Exclude<PerformancePreference, 'max'>
    lastSuccessfulSize?: { width: number; height: number }
    lastErrorCode?: string
    retryRecommended: boolean
  }
}
