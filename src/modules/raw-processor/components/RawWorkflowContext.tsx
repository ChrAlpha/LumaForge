import type {
  HSLBandId,
  HSLBandShift,
  LUTColorProfile,
  LUTContractResolution,
  PreviewHistogramState,
} from '@lumaforge/luma-color-runtime'
import type { ComponentProps, ReactNode } from 'react'
import { createContext, useContext } from 'react'

import type { UseOnlineLutSourcesResult } from '../hooks/useOnlineLutSources'
import type {
  ExportResult,
  ExportShareCapability,
} from '../model/export-result'
import type {
  ExportRecoveryState,
  LUTContractSelectionState,
} from '../model/session'
import type { ColorValue } from './color-fields'
import type { RawRuntimeReadinessState } from './raw-runtime-readiness'
import type { ToneValue } from './tone-fields'
import type { FileFactsTool } from './tools/FileFactsTool'
import type { HSLToolValue } from './tools/HSLTool'
import type { StrengthLevel } from './tools/StrengthControl'

export interface RawToolSurfaceProps {
  activeIntensity: StrengthLevel
  tone: ToneValue
  color: ColorValue
  selectiveColor: HSLToolValue | undefined
  onIntensitySelect: (level: StrengthLevel) => void
  onToneChange: (value: Partial<ToneValue>) => void
  onToneReset: () => void
  onColorChange: (value: Partial<ColorValue>) => void
  onColorReset: () => void
  onSelectiveColorChange: (
    band: HSLBandId,
    shift: Partial<HSLBandShift>,
  ) => void
  onSelectiveColorReset: () => void
  onCompareReset: () => void
  viewMode: 'processed' | 'original' | 'compare'
  onViewModeChange: (mode: 'processed' | 'original' | 'compare') => void
  compareSplit: number
  onCompareSplitChange: (split: number) => void
  onLutLoad: (files: File[]) => void
  onLutClear: () => void
  onLutProfileSelect: (profile: LUTColorProfile) => void
  onExport: (options: {
    quality: 'standard' | 'high'
    fidelity: 'safe' | 'balanced' | 'max'
  }) => void
  canPreviewExport?: boolean
  previewExportDisabledReason?: string
  onPreviewExport?: () => void | Promise<void>
  canExport: boolean
  disabledReason?: string
  isProcessing: boolean
  isExporting?: boolean
  runtimeReadinessState?: RawRuntimeReadinessState
  onPrepareRuntime?: () => void
  previewSuspended?: boolean
  exportResult: ExportResult | null
  exportShareCapability: ExportShareCapability
  histogram: PreviewHistogramState
  recovery?: ExportRecoveryState
  onShareExport: () => void
  onDownloadExport: () => void
  onDownloadExportManifest?: () => void
  onCopyExport: () => void
  onRecoverExportSource?: () => void
  hasImage: boolean
  fileName: string
  onReplaceFile: () => void
  onResetSession: () => void
  currentLutName?: string | null
  lutProfileSelection?: LUTContractSelectionState | null
  lutProfileResolution?: LUTContractResolution | null
  onlineLutSources?: UseOnlineLutSourcesResult
  supportLevel: 'official' | 'experimental'
  metadata: ComponentProps<typeof FileFactsTool>['metadata']
  stats: ComponentProps<typeof FileFactsTool>['stats']
  previewFrameEl?: HTMLDivElement | null
}

const RawWorkflowContext = createContext<RawToolSurfaceProps | null>(null)

export function RawWorkflowProvider({
  value,
  children,
}: {
  value: RawToolSurfaceProps
  children: ReactNode
}) {
  return (
    <RawWorkflowContext.Provider value={value}>
      {children}
    </RawWorkflowContext.Provider>
  )
}

export function useRawWorkflowContext(
  override?: RawToolSurfaceProps,
): RawToolSurfaceProps {
  const value = useContext(RawWorkflowContext)

  if (override && Object.keys(override).length > 0) {
    return override
  }

  if (!value) {
    throw new Error('RawWorkflowProvider is missing')
  }

  return value
}
