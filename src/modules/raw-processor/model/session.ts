import type {
  LUTColorProfile,
  LUTContractResolution,
  LUTInputProfile,
} from '@lumaforge/luma-color-runtime'

import type { ExportCheckpointManifest } from '~/lib/export/checkpoint-store'
import type {
  ExportCheckpointMode,
  ExportExecutionProfileName,
  ExportOutputSink,
  ExportRuntimeMemoryProfile,
} from '~/lib/export/execution-profile'
import type { ImageMetadata } from '~/lib/raw/decoder'

import type { ExportResult } from './export-result'

export type SupportLevel = 'official' | 'experimental' | 'unsupported'
export type PreviewStatus = 'idle' | 'loading' | 'ready' | 'failed' | 'skipped'
export type DisplaySource = 'embedded' | 'quick' | 'bounded-hq' | 'none'
export type IntensityLevel = 'off' | 'light' | 'standard' | 'strong'
export type ExportFidelity = 'safe' | 'balanced' | 'max'
export type FullResExportCapabilityState =
  | { status: 'unknown' }
  | { status: 'probing' }
  | { status: 'supported'; width: number; height: number }
  | { status: 'unsupported'; reason: string }

export type ExportRecoveryState =
  | { status: 'none' }
  | {
      status: 'source-required'
      exportId: string
      message: string
      expectedFileName: string
      manifest: ExportCheckpointManifest
    }
  | {
      status: 'ready-to-retry'
      exportId: string
      message: string
    }

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
  defaultIntensityLevel: Exclude<IntensityLevel, 'off'>
  currentIntensityLevel: IntensityLevel
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
  lutProfileSelection?: LUTContractSelectionState
  viewState: {
    mode: 'processed' | 'original' | 'compare'
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
    qualityPreset: 'standard' | 'high'
    fidelityLevel: ExportFidelity
    fullResCapability: FullResExportCapabilityState
    activePlan?: ActiveExportPlanState
    recovery: ExportRecoveryState
    checkpointDurable: boolean
    result?: ExportResult
    lastProgress?: {
      completedStrips: number
      totalStrips: number
    }
    recommendedRetryLevel?: Extract<ExportFidelity, 'safe' | 'balanced'>
    lastSuccessfulSize?: { width: number; height: number }
    lastErrorCode?: string
    retryRecommended: boolean
  }
}
