import type { ReactNode } from 'react'

import { useI18n } from '~/lib/i18n'

import type { UseOnlineLutSourcesResult } from '../hooks/useOnlineLutSources'
import type { RawTransformFeature } from '../hooks/useRawTransformFeature'
import type { UseRawWorkflowReturn } from '../hooks/useRawWorkflow.types'
import type { RawRuntimeReadinessState } from './raw-runtime-readiness'
import type { RawToolSurfaceProps } from './RawWorkflowContext'
import { RawWorkflowProvider } from './RawWorkflowContext'

interface RawWorkflowToolProviderProps {
  transform?: RawTransformFeature
  workflow: UseRawWorkflowReturn
  onlineLutSources: UseOnlineLutSourcesResult
  isCpuMode: boolean
  isProcessing: boolean
  runtimeReadinessState: RawRuntimeReadinessState
  previewFrameEl: HTMLDivElement | null
  onReplaceFile: () => void
  onResetSession: () => void
  onCompareReset: () => void
  onLutDrop: (files: File[]) => void
  onExport: RawToolSurfaceProps['onExport']
  onRecoverExportSource: () => void
  onPrepareRuntime: () => void
  children: ReactNode
}

export function RawWorkflowToolProvider({
  transform,
  workflow,
  onlineLutSources,
  isCpuMode,
  isProcessing,
  runtimeReadinessState,
  previewFrameEl,
  onReplaceFile,
  onResetSession,
  onCompareReset,
  onLutDrop,
  onExport,
  onRecoverExportSource,
  onPrepareRuntime,
  children,
}: RawWorkflowToolProviderProps) {
  const { t } = useI18n()
  const transformActive = transform?.active === true
  const compareDisabled = isCpuMode || transformActive
  const decodedPreviewSize = workflow.decodedImageRef.current
    ? {
        width: workflow.decodedImageRef.current.width,
        height: workflow.decodedImageRef.current.height,
      }
    : null
  const toolStats = workflow.stats
    ? {
        processTime: workflow.stats.processTime,
        inputSize: workflow.stats.inputSize,
        previewSize: decodedPreviewSize ?? workflow.stats.previewSize,
      }
    : null

  return (
    <RawWorkflowProvider
      value={{
        transform,
        activeIntensity: workflow.activeIntensity,
        tone: {
          userExposureEv: workflow.params.userExposureEv,
          userContrast: workflow.params.userContrast,
          userHighlights: workflow.params.userHighlights,
          userShadows: workflow.params.userShadows,
          userWhites: workflow.params.userWhites,
          userBlacks: workflow.params.userBlacks,
        },
        color: {
          userTemperature: workflow.params.userTemperature,
          userTint: workflow.params.userTint,
          userSaturation: workflow.params.userSaturation,
          userVibrance: workflow.params.userVibrance,
        },
        selectiveColor: workflow.params.selectiveColor,
        onIntensitySelect: workflow.selectIntensityLevel,
        onToneChange: workflow.setToneParams,
        onToneReset: workflow.resetTone,
        onColorChange: workflow.setColorParams,
        onColorReset: workflow.resetColor,
        onSelectiveColorChange: workflow.setSelectiveColorBand,
        onSelectiveColorReset: workflow.resetSelectiveColor,
        fileName: workflow.sourceFileName,
        onReplaceFile,
        onResetSession,
        onCompareReset: compareDisabled ? () => {} : onCompareReset,
        viewMode: compareDisabled ? 'processed' : workflow.viewMode,
        onViewModeChange: compareDisabled ? () => {} : workflow.setViewMode,
        compareSplit: workflow.compareSplit,
        onCompareSplitChange: compareDisabled
          ? () => {}
          : workflow.setCompareSplit,
        onLutLoad: onLutDrop,
        onLutClear: workflow.clearLUT,
        currentLutName: workflow.currentLutName,
        lutProfileSelection: workflow.lutProfileSelection,
        lutProfileResolution:
          workflow.activeStyle?.kind === 'custom'
            ? workflow.activeStyle.lutAsset?.profileResolution
            : null,
        onLutProfileSelect: workflow.selectLUTProfile,
        onlineLutSources,
        onExport: transformActive ? () => {} : onExport,
        onPreviewExport: transformActive
          ? () => {}
          : workflow.exportPreviewImage,
        canExport: !transformActive && workflow.canExport,
        disabledReason: transformActive
          ? t('raw.transform.exportReason')
          : workflow.exportDisabledReason,
        canPreviewExport: !transformActive && workflow.canPreviewExport,
        previewExportDisabledReason: transformActive
          ? t('raw.transform.exportReason')
          : workflow.previewExportDisabledReason,
        isProcessing,
        isExporting: workflow.status === 'exporting',
        runtimeReadinessState,
        onPrepareRuntime,
        previewSuspended: workflow.previewSuspended,
        exportResult: workflow.exportResult,
        exportShareCapability: workflow.exportShareCapability,
        recovery: workflow.exportRecovery,
        onShareExport: workflow.shareExportResult,
        onDownloadExport: workflow.downloadExportResult,
        onDownloadExportManifest: workflow.downloadExportManifest,
        onCopyExport: workflow.copyExportResult,
        onRecoverExportSource,
        hasImage: workflow.hasImage,
        supportLevel: workflow.supportLevel,
        metadata: workflow.loadedImage.metadata,
        stats: toolStats,
        histogram: transformActive
          ? {
              state: 'unsupported',
              reason: t('raw.transform.histogramUnavailable'),
            }
          : isCpuMode
            ? {
                state: 'unsupported',
                reason: t('raw.preview.cpuDegraded.banner'),
              }
            : (workflow.histogram ?? {
                state: 'unavailable',
                reason: 'no-image',
              }),
        previewFrameEl: transformActive ? null : previewFrameEl,
      }}
    >
      {children}
    </RawWorkflowProvider>
  )
}
