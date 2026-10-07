import type {
  LUTColorProfile,
  LUTContractResolution,
  LUTInputProfile,
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

/**
 * A session holds no export recovery: an interrupted export is only a hint in
 * the page's markers for the next explicit export of the same source.
 */
export type ExportRecoveryState = { status: 'none' }

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
    inputProfile?: LUTInputProfile
    profileResolution?: LUTContractResolution
  }
  inputPrepProfile?: {
    profileId: string
    description: string
  }
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
    /**
     * Always `none`. The interruption hint lives in the page's marker state
     * and reaches surfaces only as a note for the loaded source.
     */
    recovery: ExportRecoveryState
    /**
     * Always false: no export state outlives the tab, whatever the sink. The
     * engine's checkpoint hooks are compatibility surface, not an app promise.
     */
    checkpointDurable: boolean
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
