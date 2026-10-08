import type {
  ColorGraphIntent,
  HSLBandId,
  HSLBandShift,
  LUTColorProfile,
  LUTData,
  PreviewHistogramState,
} from '@lumaforge/luma-color-runtime'
import type { ExportGeometry } from '@lumaforge/render-engine/export'
import type { RefObject } from 'react'

import type { ParsedLUT } from '~/lib/lut/cube-parser'
import type { PreviewViewMode } from '~/lib/preview/preview-view'
import type { OnlineLUTEntry } from '~/lib/profiles/catalog'
import type { DecodedImage, ImageMetadata } from '~/lib/raw/decoder'
import type { RawRuntimeHost } from '~/lib/raw/raw-runtime-host'
import type {
  PipelineStats,
  RawProcessingPipeline,
} from '~/lib/webgpu/raw-processing-pipeline'

import type {
  ExportResult,
  ExportShareCapability,
  FullResExportReason,
  HqPreviewExportReasonCode,
} from '../model/export-result'
import type {
  DisplaySource,
  LUTContractSelectionState,
  StyleAsset,
  SupportLevel,
  TransformState,
} from '../model/session'
import type { ProcessingStatus } from '../model/workflow'
import type { OriginalReferenceSnapshot } from '../services/compare/original-reference-snapshot'
import type { DeliveredExportSize } from '../services/export/delivered-export-size'
import type { LutLoadOutcome } from '../services/look/orchestrate-lut-load'
import type { PreviewViewport } from '../services/preview/preview-viewport'
import type { TransformEvent } from '../services/transform/transform-state'
import type { PreviewPipelineHandle } from './preview/usePreviewPipelineLifecycle'

export interface UseRawWorkflowReturn {
  previewTransform?: {
    sourceId: string | null
    active: boolean
    /**
     * Geometry the export reproduces at full resolution; null when neutral.
     * It is the geometry `transform` holds, and moves only through it.
     */
    geometry: ExportGeometry | null
  }
  /**
   * The loaded source's Transform intent and the answers accepted for it;
   * null without a source. `dispatch` applies one event to that source's
   * state, and an event raised for any other source changes nothing.
   */
  transform?: {
    state: TransformState | null
    dispatch: (event: TransformEvent) => void
  }
  /**
   * The color the photo renders with: the user's color and the look, with
   * the session look projected over it. View state is never part of it; it
   * is published as `viewMode` and `compareSplit`.
   */
  params: ColorGraphIntent
  loadedImage: { file: File | null; metadata: ImageMetadata | null }
  decodedImageRef: RefObject<DecodedImage | null>
  decodedImageVersion: number
  status: ProcessingStatus
  error: string | null
  progress: number
  lut: ParsedLUT | null
  lutData: LUTData | null
  lutDataRef: RefObject<LUTData | null>
  lutDataVersion: number
  stats: PipelineStats | null
  hasImage: boolean
  canExport: boolean
  /** Why a full-resolution export cannot start; unset while it can. */
  exportRefusal?: FullResExportReason
  /**
   * The frame a full-resolution export will write (Transform included);
   * null while unknown.
   */
  deliveredExportSize?: DeliveredExportSize | null
  canPreviewExport: boolean
  /** Why an HQ preview export cannot start, when the workflow names it. */
  previewExportRefusal?: HqPreviewExportReasonCode
  exportResult: ExportResult | null
  exportShareCapability: ExportShareCapability
  /**
   * Whether the loaded source's previous export was interrupted. The next
   * explicit export uses a safer plan for it; nothing starts one on its own.
   */
  exportInterrupted: boolean
  activeStyle: StyleAsset | null
  lutProfileSelection: LUTContractSelectionState | null
  /** How much of the look reaches the photo, 0..1. */
  activeIntensity: number
  viewMode: PreviewViewMode
  /** Frame-anchored compare split in 0..1. */
  compareSplit: number
  previewViewport: PreviewViewport
  currentLutName: string | null
  sourceFileName: string
  supportLevel: SupportLevel
  progressRecoveryHint?: string
  embeddedPreviewUrl: string | null
  displaySource: DisplaySource
  originalReferenceSnapshot: OriginalReferenceSnapshot | null
  originalReferenceFallbackReason: string | null
  dualGpuAllowed: boolean
  histogram: PreviewHistogramState
  previewSuspended: boolean
  loadFile: (file: File) => Promise<void>
  loadLUT: (file: File) => Promise<LutLoadOutcome>
  loadOnlineLUT: (
    entry: OnlineLUTEntry,
    options?: {
      signal?: AbortSignal
      onProgress?: (receivedBytes: number, totalBytes?: number) => void
    },
  ) => Promise<LutLoadOutcome>
  selectLUTProfile: (profile: LUTColorProfile | string) => void
  /** Set how much of the look reaches the photo, 0..1. */
  setIntensity: (value: number) => void
  setViewMode: (mode: PreviewViewMode) => void
  setCompareSplit: (split: number) => void
  /**
   * Put the split back at its centre and the photo at fit in one write, or
   * change nothing when the split is refused.
   */
  resetCompareView: () => void
  setPreviewViewport: (viewport: PreviewViewport) => void
  resetPreviewViewport: () => void
  clearLUT: () => void
  /** Write color fields; the view has its own setters. */
  setParams: (params: Partial<ColorGraphIntent>) => void
  setToneParams: (
    params: Partial<
      Pick<
        ColorGraphIntent,
        | 'userExposureEv'
        | 'userContrast'
        | 'userHighlights'
        | 'userShadows'
        | 'userWhites'
        | 'userBlacks'
      >
    >,
  ) => void
  resetTone: () => void
  setColorParams: (
    params: Partial<Pick<ColorGraphIntent, 'userTemperature' | 'userTint'>>,
  ) => void
  resetColor: () => void
  setSelectiveColorBand: (band: HSLBandId, shift: Partial<HSLBandShift>) => void
  resetSelectiveColor: () => void
  /** Starts the explicit full-resolution export; it takes no choices. */
  exportImage: () => Promise<void>
  exportPreviewImage: () => Promise<void>
  downloadExportResult: () => Promise<void>
  downloadExportManifest: () => Promise<void>
  shareExportResult: () => Promise<void>
  copyExportResult: () => Promise<void>
  restorePreviewAfterExport: () => Promise<void>
  requestOriginalReferenceFallback: () => void
  /** Receives the handle the original GPU layer's owner publishes. */
  setOriginalPreviewPipeline: (handle: PreviewPipelineHandle | null) => void
  reset: () => void
  dismissError: () => void
  updateStats: (stats: PipelineStats) => void
  pipelineRef: RefObject<RawProcessingPipeline | null>
  /** The workflow's RAW host; stable for the life of the workflow. */
  rawRuntimeHost: RawRuntimeHost
}
