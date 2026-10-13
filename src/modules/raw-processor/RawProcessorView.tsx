/**
 * Main RAW Processor view component.
 * Combines all sub-components into a complete RAW editing interface.
 */

import './raw-lab.css'
import './raw-lab.surface.css'
import './raw-lab.effects.css'

import { useAtomValue, useSetAtom } from 'jotai'
import { useEffect, useMemo } from 'react'
import { useInRouterContext, useLocation } from 'react-router'

import { clsxm } from '~/lib/cn'
import { cpuPreviewVariantForViewMode } from '~/lib/preview/preview-view'

import type { CpuPreviewNotice } from './components/CpuPreviewBanner'
import { CpuPreviewBanner } from './components/CpuPreviewBanner'
import { PreviewHistogramRunner } from './components/PreviewHistogramRunner'
import { ErrorOverlay } from './components/ProgressOverlay'
import { RawPreviewStageSurface } from './components/RawPreviewStageSurface'
import { RawResetConfirmationDialog } from './components/RawResetConfirmationDialog'
import {
  RawToolSurface,
  useIsMobileRawSurface,
} from './components/RawToolSurface'
import { RawTransformOverlay } from './components/RawTransformOverlay'
import { RawWorkflowToolProvider } from './components/RawWorkflowToolProvider'
import { WorkspaceHeader } from './components/WorkspaceHeader'
import { useRawWorkflow } from './hooks'
import { useRawProcessorViewController } from './hooks/useRawProcessorViewController'
import { useRawTransformFeature } from './hooks/useRawTransformFeature'
import {
  isPreviewHistogramShown,
  mobileHistogramShownAtom,
  previewHistogramEnabledAtom,
} from './state/histogram.atoms'

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
  const view = useRawProcessorViewController({
    rawRouteLocation,
    workflow: useRawWorkflow(),
  })
  const { workflow } = view
  const transform = useRawTransformFeature(workflow, view.isCpuMode)
  const isMobileSurface = useIsMobileRawSurface()
  // The histogram runs only while a surface draws it.
  const mobileHistogramShown = useAtomValue(mobileHistogramShownAtom)
  const histogramEnabled = isPreviewHistogramShown({
    mobileSurface: isMobileSurface,
    mobileHistogramShown,
    cpuPreview: view.isCpuMode,
    transformActive: transform.active,
  })
  const setHistogramEnabled = useSetAtom(previewHistogramEnabledAtom)
  useEffect(() => {
    setHistogramEnabled(histogramEnabled)
  }, [histogramEnabled, setHistogramEnabled])
  const {
    isCpuMode,
    cpuPreviewBannerDismissed,
    cpuPreviewReason,
    setCpuPreviewBannerDismissed,
  } = view
  const cpuPreviewNotice = useMemo<CpuPreviewNotice | undefined>(
    () =>
      isCpuMode && !cpuPreviewBannerDismissed
        ? {
            reason: cpuPreviewReason,
            onDismiss: () => setCpuPreviewBannerDismissed(true),
          }
        : undefined,
    [
      cpuPreviewBannerDismissed,
      cpuPreviewReason,
      isCpuMode,
      setCpuPreviewBannerDismissed,
    ],
  )
  const {
    status,
    error,
    hasImage,
    sourceFileName,
    supportLevel,
    dismissError,
  } = workflow

  return (
    <div
      className={clsxm('raw-lab', className)}
      data-raw-lab-shell="viewport"
      data-raw-lab-state={hasImage ? 'loaded' : 'empty'}
    >
      {/* The CPU notice shares the header's grid row so it sits in flow
          above the stage. Mobile has no header row; its chrome shows the
          notice below the topbar instead, so only one copy is mounted. */}
      <div className="max-[640px]:hidden">
        <WorkspaceHeader
          fileName={sourceFileName}
          hasImage={hasImage}
          supportLevel={supportLevel}
          onReplaceFile={view.handleReplaceFile}
          onResetSession={view.requestSessionReset}
        />
        {cpuPreviewNotice && !isMobileSurface && (
          <CpuPreviewBanner {...cpuPreviewNotice} className="mx-3 mt-2" />
        )}
      </div>

      <div
        className="raw-lab-shell grid min-h-0 min-w-0 overflow-hidden [grid-template-columns:minmax(0,1fr)_minmax(332px,376px)] max-[980px]:[grid-template-columns:minmax(0,1fr)] max-[980px]:[grid-template-rows:minmax(0,1fr)_auto] max-[640px]:[grid-template-columns:minmax(0,1fr)] max-[640px]:[grid-template-rows:minmax(0,1fr)]"
        data-raw-lab-layout="stage-tools"
        data-raw-desktop-layout="photo-stage-command-rail"
      >
        <RawPreviewStageSurface
          workflow={workflow}
          isCpuMode={view.isCpuMode}
          isProcessing={view.isProcessing}
          runtimeReadinessState={view.runtimeReadinessState}
          onPrepareRuntime={view.triggerRawRuntimePrewarm}
          onRawDrop={view.handleFileDrop}
          onStatsUpdate={view.handleStatsUpdate}
          onPipelineChange={view.handlePipelineChange}
          onPreviewFrameChange={view.setPreviewFrameEl}
          onCpuProcessedFrame={transform.setCpuFrame}
          onCompareReset={view.handleCompareReset}
          transformActive={transform.active}
          viewportInteractionDisabled={transform.showOverlay}
          // Mobile has no room for the CPU stage's own toggle row under the
          // photo; its compare lens drives original / processed instead.
          cpuVariant={
            isMobileSurface
              ? cpuPreviewVariantForViewMode(workflow.viewMode)
              : undefined
          }
        />

        <PreviewHistogramRunner
          decodedImageRef={workflow.decodedImageRef}
          decodedFrame={workflow.decodedFrame}
          params={workflow.params}
          lutDataRef={workflow.lutDataRef}
          lutDataVersion={workflow.lutDataVersion}
          displaySource={workflow.displaySource}
        />

        <RawWorkflowToolProvider
          transform={transform}
          workflow={workflow}
          onlineLutSources={view.onlineLutSources}
          isCpuMode={view.isCpuMode}
          cpuPreviewNotice={cpuPreviewNotice}
          isProcessing={view.isProcessing}
          runtimeReadinessState={view.runtimeReadinessState}
          previewFrameEl={view.previewFrameEl}
          onReplaceFile={view.handleReplaceFile}
          onResetSession={view.requestSessionReset}
          onCompareReset={view.handleCompareReset}
          onLutDrop={view.handleLutDrop}
          onExport={view.handleExport}
          onPrepareRuntime={view.triggerRawRuntimePrewarm}
        >
          <RawToolSurface />
        </RawWorkflowToolProvider>
      </div>

      <RawTransformOverlay feature={transform} target={view.previewFrameEl} />

      <ErrorOverlay
        visible={status === 'error' && !!error}
        message={error || ''}
        onDismiss={dismissError}
      />

      <RawResetConfirmationDialog
        open={view.resetConfirmationOpen}
        onOpenChange={view.setResetConfirmationOpen}
        onConfirm={view.confirmSessionReset}
      />

      <input {...view.replacePicker.inputProps} />
    </div>
  )
}
