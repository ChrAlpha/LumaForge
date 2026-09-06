import type { LUTData, ProcessingParams } from '@lumaforge/luma-color-runtime'

import { clsxm } from '~/lib/cn'
import type { PipelineStats, RawProcessingPipeline } from '~/lib/gl/pipeline'
import { useI18n } from '~/lib/i18n'
import type { DecodedImage } from '~/lib/raw/decoder'

import type { DisplaySource } from '../model/session'
import type { OriginalReferenceSnapshot } from '../services/compare/original-reference-snapshot'
import type { PreviewViewport } from '../services/preview/preview-viewport'
import { CompareSplitHandle } from './CompareSplitHandle'
import { Dropzone, RAW_FILE_ACCEPT } from './Dropzone'
import type { OriginalWebglPipelineHandle } from './OriginalWebglLayer'
import { PreviewCanvas } from './PreviewCanvas'
import { ProgressOverlay } from './ProgressOverlay'
import type { RawRuntimeReadinessState } from './raw-runtime-readiness'
import { getRawRuntimeReadinessCopy } from './raw-runtime-readiness'

export interface ComparePreviewStageProps {
  hasImage: boolean
  imageRef: React.RefObject<DecodedImage | null>
  imageVersion: number
  params: ProcessingParams
  lutDataRef: React.RefObject<LUTData | null>
  lutDataVersion: number
  embeddedPreviewUrl?: string | null
  displaySource?: DisplaySource
  originalReferenceSnapshot?: OriginalReferenceSnapshot | null
  originalReferenceFallbackReason?: string | null
  dualWebglAllowed?: boolean
  previewSuspended?: boolean
  previewViewport?: PreviewViewport
  split: number
  splitEnabled?: boolean
  isProcessing: boolean
  progress: number
  phase: 'warming' | 'loading' | 'decoding' | 'processing' | 'exporting'
  runtimeReadinessState?: RawRuntimeReadinessState
  recoveryHint?: string
  onRawDrop: (files: File[]) => void
  onPrepareRuntime?: () => void
  onSplitChange: (split: number) => void
  onSplitPreviewChange?: (split: number) => void
  onPreviewViewportChange?: (viewport: PreviewViewport) => void
  onStatsUpdate?: (stats: PipelineStats) => void
  onPipelineChange?: (pipeline: RawProcessingPipeline | null) => void
  onOriginalPreviewPipelineChange?: (
    pipeline: OriginalWebglPipelineHandle | null,
  ) => void
  onRequestOriginalReferenceFallback?: () => void
  onRestorePreview?: () => void | Promise<void>
  previewFrameRef?: (element: HTMLDivElement | null) => void
  className?: string
}

function EmptySampleCompare({ split }: { split: number }) {
  return (
    <div
      className="raw-lab-sample"
      style={
        {
          '--raw-compare-split-committed': `${split * 100}%`,
        } as React.CSSProperties
      }
      aria-hidden="true"
    >
      <div className="raw-lab-sample-photo" />
      <div className="raw-lab-sample-finish" />
    </div>
  )
}

function UploadDock({
  onOpenFilePicker,
  onPrepareRuntime,
  disabled,
  runtimeReadinessState,
}: {
  onOpenFilePicker: () => void
  onPrepareRuntime?: () => void
  disabled: boolean
  runtimeReadinessState?: RawRuntimeReadinessState
}) {
  const { t } = useI18n()
  const runtimeReadiness = runtimeReadinessState
    ? getRawRuntimeReadinessCopy(t, runtimeReadinessState)
    : null

  return (
    <button
      type="button"
      data-raw-upload-dock
      className="absolute bottom-[clamp(52px,7vw,78px)] left-1/2 z-[7] flex min-w-[min(320px,calc(100%-36px))] max-w-[min(420px,calc(100%-36px))] -translate-x-1/2 items-start gap-3 rounded-md border border-[var(--color-stage-hairline)] bg-[var(--color-stage-panel)] px-3 py-2.5 text-left text-[var(--color-on-stage)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-50 max-[640px]:bottom-[18px] max-[640px]:min-w-[min(300px,calc(100%-28px))]"
      onPointerEnter={onPrepareRuntime}
      onFocus={onPrepareRuntime}
      onClick={(event) => {
        event.stopPropagation()
        onPrepareRuntime?.()
        onOpenFilePicker()
      }}
      disabled={disabled}
    >
      <span
        className="grid size-[34px] shrink-0 place-items-center rounded-[5px] bg-accent font-bold text-background"
        aria-hidden="true"
      >
        ↑
      </span>
      <span className="grid min-w-0 gap-1">
        <strong className="block text-sm leading-tight">
          {t('raw.onboarding.slogan')}
        </strong>
        <span className="mt-0.5 block text-xs leading-snug text-[var(--color-on-stage-soft)]">
          {t('raw.stage.uploadCopy')}
        </span>
        {runtimeReadiness && (
          <span
            aria-live="polite"
            data-raw-runtime-readiness
            data-state={runtimeReadinessState}
            className="mt-1 grid gap-0.5 rounded-[5px] border border-[var(--color-stage-hairline)] bg-[oklch(0.11_0.018_76/0.48)] px-2 py-1.5 text-left"
          >
            <span className="inline-flex min-w-0 items-center gap-1.5 text-[0.69rem] font-semibold leading-snug text-[var(--color-on-stage)]">
              <span
                className={clsxm(
                  'size-1.5 shrink-0 rounded-full',
                  runtimeReadinessState === 'ready'
                    ? 'bg-accent'
                    : 'bg-[var(--color-progress)]',
                )}
                aria-hidden="true"
              />
              <span className="min-w-0">{runtimeReadiness.label}</span>
            </span>
            <span className="block text-[0.68rem] leading-snug text-[var(--color-on-stage-soft)]">
              {runtimeReadiness.detail}
            </span>
          </span>
        )}
      </span>
    </button>
  )
}

function ExportReadyHandoff({
  onRestorePreview,
}: {
  onRestorePreview?: () => void | Promise<void>
}) {
  const { t } = useI18n()

  return (
    <div
      className="absolute inset-0 z-[60] grid place-items-center bg-[var(--color-stage-background)] px-6 text-center"
      data-raw-export-ready-handoff
    >
      <div className="grid max-w-[22rem] gap-3">
        <span
          className="mx-auto grid size-12 place-items-center rounded-[8px] border border-[var(--color-stage-hairline)] bg-[var(--color-stage-panel)] text-[1.35rem] font-semibold text-[var(--color-progress)]"
          aria-hidden="true"
        >
          ✓
        </span>
        <div className="grid gap-2">
          <h2 className="m-0 text-base font-semibold text-[var(--color-on-stage)]">
            {t('raw.export.ready')}
          </h2>
          <p className="m-0 text-sm leading-relaxed text-[var(--color-on-stage-soft)]">
            {t('raw.progress.readyPreviewReleasedDetail')}
          </p>
          {onRestorePreview && (
            <button
              type="button"
              onClick={onRestorePreview}
              className="mx-auto mt-2 inline-flex min-h-[42px] items-center justify-center rounded-[8px] border border-[oklch(0.54_0.14_153)] bg-accent px-4 text-sm font-semibold text-background transition-colors hover:bg-[oklch(0.66_0.16_153)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            >
              {t('raw.progress.restorePreview')}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

function ExportProcessingHandoffBackdrop() {
  return (
    <div
      className="absolute inset-0 bg-[var(--color-stage-background)]"
      data-raw-export-processing-handoff
      aria-hidden="true"
    />
  )
}

export function ComparePreviewStage({
  hasImage,
  imageRef,
  imageVersion,
  params,
  lutDataRef,
  lutDataVersion,
  embeddedPreviewUrl,
  displaySource = 'none',
  originalReferenceSnapshot,
  originalReferenceFallbackReason,
  dualWebglAllowed = false,
  previewSuspended = false,
  previewViewport,
  split,
  splitEnabled = true,
  isProcessing,
  progress,
  phase,
  runtimeReadinessState,
  recoveryHint,
  onRawDrop,
  onPrepareRuntime,
  onSplitChange,
  onSplitPreviewChange,
  onPreviewViewportChange,
  onStatsUpdate,
  onPipelineChange,
  onOriginalPreviewPipelineChange,
  onRequestOriginalReferenceFallback,
  onRestorePreview,
  previewFrameRef,
  className,
}: ComparePreviewStageProps) {
  const { t } = useI18n()
  const blockStageInteraction = phase === 'exporting'
  const isPreviewEvacuated = previewSuspended && hasImage
  const isEvacuatedProcessingHandoff = isPreviewEvacuated && isProcessing
  const isExportProcessingHandoff =
    isEvacuatedProcessingHandoff && phase === 'exporting'
  const isExportReadyHandoff = isPreviewEvacuated && !isProcessing
  const showSplit = splitEnabled && !isPreviewEvacuated
  const showBlockingProgress =
    isProcessing &&
    (!hasImage || blockStageInteraction || isEvacuatedProcessingHandoff)

  return (
    <section
      className={clsxm('raw-lab-stage', className)}
      aria-label={t('raw.stage.aria')}
      data-preview-state={
        isExportProcessingHandoff
          ? 'exporting-released'
          : isEvacuatedProcessingHandoff
            ? 'restoring-released'
            : isExportReadyHandoff
              ? 'ready-released'
              : undefined
      }
    >
      <Dropzone
        variant="stage"
        aria-label={
          hasImage ? t('raw.stage.replaceAria') : t('raw.stage.loadAria')
        }
        onFileDrop={onRawDrop}
        accept={RAW_FILE_ACCEPT}
        disabled={isProcessing}
        clickToOpen={false}
        className="raw-lab-stage-frame"
      >
        {({ openFilePicker, disabled }) => (
          <>
            {isExportReadyHandoff ? (
              <ExportReadyHandoff onRestorePreview={onRestorePreview} />
            ) : isEvacuatedProcessingHandoff ? (
              <ExportProcessingHandoffBackdrop />
            ) : hasImage ? (
              <PreviewCanvas
                imageRef={imageRef}
                imageVersion={imageVersion}
                params={params}
                lutDataRef={lutDataRef}
                lutDataVersion={lutDataVersion}
                embeddedPreviewUrl={embeddedPreviewUrl}
                displaySource={displaySource}
                originalReferenceSnapshot={originalReferenceSnapshot}
                originalReferenceFallbackReason={
                  originalReferenceFallbackReason
                }
                dualWebglAllowed={dualWebglAllowed}
                suspended={previewSuspended}
                interactionDisabled={blockStageInteraction}
                previewViewport={previewViewport}
                onPreviewViewportChange={onPreviewViewportChange}
                onStatsUpdate={onStatsUpdate}
                onPipelineChange={onPipelineChange}
                onOriginalPreviewPipelineChange={
                  onOriginalPreviewPipelineChange
                }
                onRequestOriginalReferenceFallback={
                  onRequestOriginalReferenceFallback
                }
                frameRef={previewFrameRef}
              />
            ) : (
              <EmptySampleCompare split={split} />
            )}

            {showSplit && (
              <>
                <span className="raw-lab-compare-label pointer-events-none absolute bottom-[calc(var(--raw-compare-track-bottom,0px)+18px)] left-[18px] z-[7] max-w-[calc(50%-32px)] rounded-full border border-[var(--color-stage-hairline)] bg-[var(--color-stage-panel)] px-2.5 py-1.5 text-xs font-medium leading-tight text-[var(--color-on-stage)] opacity-0 transition-opacity duration-[180ms] ease-[cubic-bezier(0.22,1,0.36,1)] max-[640px]:max-w-[calc(50%-22px)]">
                  {t('raw.stage.leftLabel')}
                </span>
                <span className="raw-lab-compare-label absolute bottom-[calc(var(--raw-compare-track-bottom,0px)+18px)] right-[18px] left-auto z-[7] max-w-[calc(50%-32px)] rounded-full border border-[var(--color-stage-hairline)] bg-[var(--color-stage-panel)] px-2.5 py-1.5 pointer-events-none text-xs font-medium leading-tight text-[var(--color-on-stage)] opacity-0 transition-opacity duration-[180ms] ease-[cubic-bezier(0.22,1,0.36,1)] max-[640px]:max-w-[calc(50%-22px)]">
                  {t('raw.stage.rightLabel')}
                </span>

                <CompareSplitHandle
                  value={split}
                  onChange={onSplitChange}
                  onPreviewChange={onSplitPreviewChange}
                  disabled={blockStageInteraction}
                />
              </>
            )}

            {!hasImage && (
              <UploadDock
                onOpenFilePicker={openFilePicker}
                onPrepareRuntime={onPrepareRuntime}
                disabled={disabled}
                runtimeReadinessState={runtimeReadinessState}
              />
            )}

            <ProgressOverlay
              visible={showBlockingProgress}
              phase={phase}
              progress={progress}
              recoveryHint={recoveryHint}
              variant={
                isEvacuatedProcessingHandoff ? 'flat-handoff' : undefined
              }
            />
          </>
        )}
      </Dropzone>
    </section>
  )
}
