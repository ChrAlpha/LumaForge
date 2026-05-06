/**
 * Main RAW Processor view component.
 * Combines all sub-components into a complete RAW editing interface.
 */

import './raw-lab.css'

import { useCallback } from 'react'
import { useInRouterContext, useLocation } from 'react-router'

import { clsxm } from '~/lib/cn'
import type { PipelineStats, RawProcessingPipeline } from '~/lib/gl/pipeline'
import { useI18n } from '~/lib/i18n'

import {
  ComparePreviewStage,
  ErrorOverlay,
  RawToolSurface,
  UnsupportedState,
  WorkspaceHeader,
} from './components'
import { useRawProcessor } from './hooks'
import { useCapabilityGate } from './hooks/useCapabilityGate'
import { useOnlineLutSources } from './hooks/useOnlineLutSources'
import { clampCompareSplit } from './services/compare-split'

export interface RawProcessorViewProps {
  className?: string
}

interface RawRouteLocation {
  search: string
  pathname: string
}

interface RawProcessorViewInnerProps extends RawProcessorViewProps {
  rawRouteLocation: RawRouteLocation
}

const fallbackRawRouteLocation: RawRouteLocation = {
  pathname: '/raw',
  search: '',
}

function RawProcessorViewWithRouterLocation(props: RawProcessorViewProps) {
  const location = useLocation()

  return (
    <RawProcessorViewInner
      {...props}
      rawRouteLocation={{
        pathname: location.pathname,
        search: location.search,
      }}
    />
  )
}

export function RawProcessorView(props: RawProcessorViewProps) {
  const inRouterContext = useInRouterContext()

  if (inRouterContext) {
    return <RawProcessorViewWithRouterLocation {...props} />
  }

  return (
    <RawProcessorViewInner
      {...props}
      rawRouteLocation={fallbackRawRouteLocation}
    />
  )
}

function RawProcessorViewInner({
  className,
  rawRouteLocation,
}: RawProcessorViewInnerProps) {
  const { t } = useI18n()
  const {
    params,
    loadedImage,
    status,
    error,
    progress,
    decodedImageRef,
    decodedImageVersion,
    lutDataRef,
    lutDataVersion,
    stats,
    hasImage,
    canExport,
    exportDisabledReason,
    exportResult,
    exportShareCapability,
    exportRecovery,
    activeStyle,
    lutProfileSelection,
    activeIntensity,
    currentLutName,
    sourceFileName,
    supportLevel,
    progressRecoveryHint,
    previewSuspended,
    compareSplit,
    previewViewport,
    embeddedPreviewUrl,
    displaySource,
    histogram,
    loadFile,
    loadLUT,
    loadOnlineLUT,
    selectLUTProfile,
    selectIntensityLevel,
    setToneParams,
    setViewMode,
    setCompareSplit,
    setPreviewViewport,
    setParams,
    clearLUT,
    exportImage,
    recoverInterruptedExport,
    downloadExportResult,
    shareExportResult,
    copyExportResult,
    reset,
    resetTone,
    dismissError,
    updateStats,
    pipelineRef,
  } = useRawProcessor()
  const onlineLutSources = useOnlineLutSources({
    search: rawRouteLocation.search,
    pathname: rawRouteLocation.pathname,
    loadOnlineLUT,
  })

  // Handle file drop
  const handleFileDrop = useCallback(
    (files: File[]) => {
      if (files.length > 0) {
        loadFile(files[0])
      }
    },
    [loadFile],
  )

  // Handle LUT drop
  const handleLutDrop = useCallback(
    (files: File[]) => {
      if (files.length > 0) {
        loadLUT(files[0])
      }
    },
    [loadLUT],
  )

  // Handle export
  const handleExport = useCallback(
    (options: {
      quality: 'standard' | 'high'
      fidelity: 'safe' | 'balanced' | 'max'
    }) => {
      exportImage(options)
    },
    [exportImage],
  )

  const handleReplaceFile = useCallback(() => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept =
      '.cr2,.cr3,.nef,.arw,.raf,.rw2,.orf,.dng,.pef,.srw,.3fr,.fff,.iiq,.raw'
    input.onchange = () => {
      const nextFile = input.files?.[0]
      if (nextFile) {
        loadFile(nextFile)
      }
    }
    input.click()
  }, [loadFile])

  const handleRecoveryFileSelect = useCallback(() => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept =
      '.cr2,.cr3,.nef,.arw,.raf,.rw2,.orf,.dng,.pef,.srw,.3fr,.fff,.iiq,.raw'
    input.onchange = () => {
      const nextFile = input.files?.[0]
      if (nextFile) {
        void recoverInterruptedExport(nextFile)
      }
    }
    input.click()
  }, [recoverInterruptedExport])

  // Handle stats update from canvas
  const handleStatsUpdate = useCallback(
    (newStats: PipelineStats) => {
      updateStats(newStats)
    },
    [updateStats],
  )

  const handlePipelineChange = useCallback(
    (pipeline: RawProcessingPipeline | null) => {
      pipelineRef.current = pipeline
    },
    [pipelineRef],
  )

  const handleCompareReset = useCallback(() => {
    setViewMode('compare')
    setCompareSplit(0.5)
  }, [setCompareSplit, setViewMode])

  const handleCompareSplitPreviewChange = useCallback(
    (split: number) => {
      setParams({ compareSplit: clampCompareSplit(split) })
    },
    [setParams],
  )

  const isProcessing =
    status === 'loading' ||
    status === 'decoding' ||
    status === 'processing' ||
    status === 'exporting'
  const toolMetadata = loadedImage.metadata
  const decodedPreviewSize = decodedImageRef.current
    ? {
        width: decodedImageRef.current.width,
        height: decodedImageRef.current.height,
      }
    : null

  const toolStats = stats
    ? {
        processTime: stats.processTime,
        inputSize: stats.inputSize,
        previewSize: decodedPreviewSize ?? stats.previewSize,
      }
    : null
  const capability = useCapabilityGate()

  if (capability.ready && capability.supportStatus === 'unsupported') {
    return (
      <div
        className={clsxm(
          'grid grid-rows-[auto_minmax(0,1fr)] h-svh min-h-0 overflow-hidden bg-[color:--color-raw-paper] text-[color:--color-raw-ink]',
          className,
        )}
        data-raw-lab-shell="viewport"
        data-raw-lab-state="unsupported"
      >
        <UnsupportedState
          reason={capability.reason || t('raw.unsupported.webgl2')}
        />
      </div>
    )
  }

  return (
    <div
      className={clsxm(
        'grid grid-rows-[auto_minmax(0,1fr)] h-svh min-h-0 overflow-hidden bg-[color:--color-raw-paper] text-[color:--color-raw-ink]',
        className,
      )}
      data-raw-lab-shell="viewport"
      data-raw-lab-state={hasImage ? 'loaded' : 'empty'}
    >
      <WorkspaceHeader
        fileName={sourceFileName}
        hasImage={hasImage}
        supportLevel={supportLevel}
        canExport={canExport}
        disabledReason={exportDisabledReason}
        onReplaceFile={handleReplaceFile}
        onResetSession={reset}
        onOpenExport={() =>
          handleExport({ quality: 'high', fidelity: 'balanced' })
        }
      />

      <div
        className="grid grid-cols-[minmax(0,1fr)_minmax(var(--spacing-raw-panel-width),var(--spacing-raw-panel-max-width))] min-w-0 min-h-0 overflow-hidden"
        data-raw-lab-layout="stage-tools"
      >
        <ComparePreviewStage
          hasImage={hasImage}
          imageRef={decodedImageRef}
          imageVersion={decodedImageVersion}
          params={params}
          lutDataRef={lutDataRef}
          lutDataVersion={lutDataVersion}
          embeddedPreviewUrl={embeddedPreviewUrl}
          displaySource={displaySource}
          previewSuspended={previewSuspended}
          previewViewport={previewViewport}
          split={compareSplit}
          onSplitChange={setCompareSplit}
          onSplitPreviewChange={handleCompareSplitPreviewChange}
          onPreviewViewportChange={setPreviewViewport}
          isProcessing={isProcessing}
          phase={
            status === 'loading'
              ? 'loading'
              : status === 'decoding'
                ? 'decoding'
                : status === 'exporting'
                  ? 'exporting'
                  : 'processing'
          }
          progress={progress}
          recoveryHint={progressRecoveryHint}
          onRawDrop={handleFileDrop}
          onStatsUpdate={handleStatsUpdate}
          onPipelineChange={handlePipelineChange}
        />

        <RawToolSurface
          activeIntensity={activeIntensity}
          tone={{
            userExposureEv: params.userExposureEv,
            userContrast: params.userContrast,
            userHighlights: params.userHighlights,
            userShadows: params.userShadows,
            userWhites: params.userWhites,
            userBlacks: params.userBlacks,
          }}
          onIntensitySelect={selectIntensityLevel}
          onToneChange={setToneParams}
          onToneReset={resetTone}
          onCompareReset={handleCompareReset}
          onLutLoad={handleLutDrop}
          onLutClear={clearLUT}
          currentLutName={currentLutName}
          lutProfileSelection={lutProfileSelection}
          lutProfileResolution={
            activeStyle?.kind === 'custom'
              ? activeStyle.lutAsset?.profileResolution
              : null
          }
          onLutProfileSelect={selectLUTProfile}
          onlineLutSources={onlineLutSources}
          onExport={handleExport}
          canExport={canExport}
          disabledReason={exportDisabledReason}
          isProcessing={isProcessing}
          exportResult={exportResult}
          exportShareCapability={exportShareCapability}
          recovery={exportRecovery}
          onShareExport={shareExportResult}
          onDownloadExport={downloadExportResult}
          onCopyExport={copyExportResult}
          onRecoverExportSource={handleRecoveryFileSelect}
          hasImage={hasImage}
          supportLevel={supportLevel}
          metadata={toolMetadata}
          stats={toolStats}
          histogram={histogram}
        />
      </div>

      <ErrorOverlay
        visible={status === 'error' && !!error}
        message={error || ''}
        onDismiss={dismissError}
      />
    </div>
  )
}

export default RawProcessorView
