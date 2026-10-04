/**
 * Main RAW Processor view component.
 * Combines all sub-components into a complete RAW editing interface.
 */

import './raw-lab.css'
import './raw-lab.surface.css'
import './raw-lab.effects.css'

import { useInRouterContext, useLocation } from 'react-router'

import { clsxm } from '~/lib/cn'

import {
  ErrorOverlay,
  RawToolSurface,
  UnsupportedState,
  WorkspaceHeader,
} from './components'
import type { CpuPreviewNotice } from './components/CpuPreviewBanner'
import { CpuPreviewBanner } from './components/CpuPreviewBanner'
import { RawPreviewStageSurface } from './components/RawPreviewStageSurface'
import { RawResetConfirmationDialog } from './components/RawResetConfirmationDialog'
import { useIsMobileRawSurface } from './components/RawToolSurface'
import { RawTransformOverlay } from './components/RawTransformOverlay'
import { RawWorkflowToolProvider } from './components/RawWorkflowToolProvider'
import { useRawWorkflow } from './hooks'
import { useRawProcessorViewController } from './hooks/useRawProcessorViewController'
import { useRawTransformFeature } from './hooks/useRawTransformFeature'

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
  const cpuPreviewNotice: CpuPreviewNotice | undefined =
    view.isCpuMode && !view.cpuPreviewBannerDismissed
      ? {
          reason: view.cpuPreviewReason,
          onDismiss: () => view.setCpuPreviewBannerDismissed(true),
        }
      : undefined
  const {
    status,
    error,
    hasImage,
    sourceFileName,
    supportLevel,
    dismissError,
  } = workflow

  if (
    view.capability.ready &&
    view.capability.supportStatus === 'unsupported'
  ) {
    return (
      <div
        className={clsxm('raw-lab', className)}
        data-raw-lab-shell="viewport"
        data-raw-lab-state="unsupported"
      >
        <UnsupportedState reason={view.unsupportedReason} />
      </div>
    )
  }

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
          onRecoverExportSource={view.handleRecoveryFileSelect}
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
      <input {...view.recoveryPicker.inputProps} />
    </div>
  )
}

export default RawProcessorView
