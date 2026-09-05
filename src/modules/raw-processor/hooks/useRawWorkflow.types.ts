import type {
  HSLBandId,
  HSLBandShift,
  LUTColorProfile,
  LUTData,
  PreviewHistogramState,
  ProcessingParams,
} from '@lumaforge/luma-color-runtime'
import type { RefObject } from 'react'

import type { PipelineStats, RawProcessingPipeline } from '~/lib/gl/pipeline'
import type { ParsedLUT } from '~/lib/lut/cube-parser'
import type { OnlineLUTEntry } from '~/lib/profiles/catalog'
import type { DecodedImage, ImageMetadata } from '~/lib/raw/decoder'

import type {
  ExportResult,
  ExportShareCapability,
} from '../model/export-result'
import type {
  DisplaySource,
  ExportRecoveryState,
  LUTContractSelectionState,
  StyleAsset,
} from '../model/session'
import type { ProcessingStatus } from '../model/workflow'
import type { OriginalReferenceSnapshot } from '../services/compare/original-reference-snapshot'
import type { LutLoadOutcome } from '../services/look/orchestrate-lut-load'
import type { PreviewViewport } from '../services/preview/preview-viewport'
import type { UseRawCalibrationStageReturn } from './stages/calibration/useRawCalibrationStage'
import type { FullResExportOptions } from './stages/export/useFullResExportAction'
import type { PreviewPipelineEvacuationHandle } from './stages/preview/usePreviewPipelineEvacuation'

export interface UseRawWorkflowReturn {
  params: ProcessingParams
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
  exportDisabledReason?: string
  canPreviewExport: boolean
  previewExportDisabledReason?: string
  exportResult: ExportResult | null
  exportShareCapability: ExportShareCapability
  exportRecovery: ExportRecoveryState
  activeStyle: StyleAsset | null
  lutProfileSelection: LUTContractSelectionState | null
  activeIntensity: 'off' | 'light' | 'standard' | 'strong'
  viewMode: ProcessingParams['viewMode']
  compareSplit: number
  previewViewport: PreviewViewport
  currentLutName: string | null
  sourceFileName: string
  supportLevel: 'official' | 'experimental'
  progressRecoveryHint?: string
  embeddedPreviewUrl: string | null
  displaySource: DisplaySource
  originalReferenceSnapshot: OriginalReferenceSnapshot | null
  originalReferenceFallbackReason: string | null
  dualWebglAllowed: boolean
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
  selectIntensityLevel: (level: 'off' | 'light' | 'standard' | 'strong') => void
  setViewMode: (mode: ProcessingParams['viewMode']) => void
  setCompareSplit: (split: number) => void
  setPreviewViewport: (viewport: PreviewViewport) => void
  resetPreviewViewport: () => void
  clearLUT: () => void
  setParams: (params: Partial<ProcessingParams>) => void
  setToneParams: (
    params: Partial<
      Pick<
        ProcessingParams,
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
    params: Partial<Pick<ProcessingParams, 'userTemperature' | 'userTint'>>,
  ) => void
  resetColor: () => void
  setSelectiveColorBand: (band: HSLBandId, shift: Partial<HSLBandShift>) => void
  resetSelectiveColor: () => void
  exportImage: (options: FullResExportOptions) => Promise<void>
  exportPreviewImage: () => Promise<void>
  recoverInterruptedExport: (file: File) => Promise<void>
  downloadExportResult: () => Promise<void>
  downloadExportManifest: () => Promise<void>
  shareExportResult: () => Promise<void>
  copyExportResult: () => Promise<void>
  restorePreviewAfterExport: () => Promise<void>
  requestOriginalReferenceFallback: () => void
  setOriginalPreviewPipeline: (
    pipeline: PreviewPipelineEvacuationHandle | null,
  ) => void
  reset: () => void
  dismissError: () => void
  updateStats: (stats: PipelineStats) => void
  pipelineRef: RefObject<RawProcessingPipeline | null>
  /**
   * Camera-calibration stage surface. UI components consume this object in
   * the next PR; the workflow does not act on selection here beyond the
   * stage's own effects.
   */
  calibrationStage: UseRawCalibrationStageReturn
}
