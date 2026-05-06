import type { LUTData, ProcessingParams } from '@lumaforge/luma-color-runtime'

import { clsxm } from '~/lib/cn'
import type { PipelineStats, RawProcessingPipeline } from '~/lib/gl/pipeline'
import { useI18n } from '~/lib/i18n'
import type { DecodedImage } from '~/lib/raw/decoder'

import type { DisplaySource } from '../model/session'
import type { PreviewViewport } from '../services/preview-viewport'
import { CompareSplitHandle } from './CompareSplitHandle'
import { Dropzone, RAW_FILE_EXTENSIONS } from './Dropzone'
import { PreviewCanvas } from './PreviewCanvas'
import { ProgressOverlay } from './ProgressOverlay'

export interface ComparePreviewStageProps {
  hasImage: boolean
  imageRef: React.RefObject<DecodedImage | null>
  imageVersion: number
  params: ProcessingParams
  lutDataRef: React.RefObject<LUTData | null>
  lutDataVersion: number
  embeddedPreviewUrl?: string | null
  displaySource?: DisplaySource
  previewSuspended?: boolean
  previewViewport?: PreviewViewport
  split: number
  isProcessing: boolean
  progress: number
  phase: 'loading' | 'decoding' | 'processing' | 'exporting'
  recoveryHint?: string
  onRawDrop: (files: File[]) => void
  onSplitChange: (split: number) => void
  onSplitPreviewChange?: (split: number) => void
  onPreviewViewportChange?: (viewport: PreviewViewport) => void
  onStatsUpdate?: (stats: PipelineStats) => void
  onPipelineChange?: (pipeline: RawProcessingPipeline | null) => void
  className?: string
}

function EmptySampleCompare({ split }: { split: number }) {
  return (
    <div
      className="absolute inset-0 overflow-hidden"
      style={
        {
          '--raw-compare-split-committed': `${split * 100}%`,
        } as React.CSSProperties
      }
      aria-hidden="true"
    >
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_54%_28%,oklch(0.9_0.08_68)_0_5%,transparent_5.4%),linear-gradient(140deg,oklch(0.26_0.05_136),oklch(0.58_0.08_72)_46%,oklch(0.24_0.03_53)_47%_100%)] [filter:saturate(0.58)_contrast(0.92)_brightness(0.82)]" />
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_54%_28%,oklch(0.92_0.09_68)_0_5%,transparent_5.4%),linear-gradient(140deg,oklch(0.3_0.085_145),oklch(0.68_0.1_72)_46%,oklch(0.32_0.045_54)_47%_100%)] [filter:saturate(1.16)_contrast(1.06)_brightness(1.04)]" />
    </div>
  )
}

function UploadDock({
  onOpenFilePicker,
  disabled,
}: {
  onOpenFilePicker: () => void
  disabled: boolean
}) {
  const { t } = useI18n()

  return (
    <button
      type="button"
      className="absolute left-1/2 bottom-[clamp(52px,7vw,78px)] z-[5] flex min-w-[min(320px,calc(100%-36px))] items-center gap-3 rounded-lg border border-[color:oklch(0.96_0.012_86_/_0.36)] px-[13px] py-[11px] bg-[color:oklch(0.16_0.018_76_/_0.84)] text-[color:--color-raw-hero-ink] cursor-pointer -translate-x-1/2 focus-visible:outline-2 focus-visible:outline-[color:--color-raw-green] focus-visible:outline-offset-2 disabled:cursor-not-allowed disabled:opacity-60"
      onClick={(event) => {
        event.stopPropagation()
        onOpenFilePicker()
      }}
      disabled={disabled}
    >
      <span
        className="grid size-[34px] shrink-0 place-items-center rounded-[5px] bg-[color:--color-raw-green] text-[color:--color-raw-ink] font-extrabold"
        aria-hidden="true"
      >
        ↑
      </span>
      <span className="block">
        <strong className="block text-[0.86rem] leading-tight">
          {t('raw.stage.uploadTitle')}
        </strong>
        <span className="mt-[3px] block text-[0.72rem] leading-snug text-[color:oklch(0.9_0.016_86)]">
          {t('raw.stage.uploadCopy')}
        </span>
      </span>
    </button>
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
  previewSuspended = false,
  previewViewport,
  split,
  isProcessing,
  progress,
  phase,
  recoveryHint,
  onRawDrop,
  onSplitChange,
  onSplitPreviewChange,
  onPreviewViewportChange,
  onStatsUpdate,
  onPipelineChange,
  className,
}: ComparePreviewStageProps) {
  const { t } = useI18n()

  return (
    <section
      className={clsxm(
        'relative min-w-0 min-h-0 overflow-hidden p-[clamp(12px,2vw,22px)]',
        className,
      )}
      aria-label={t('raw.stage.aria')}
    >
      <Dropzone
        variant="stage"
        aria-label={
          hasImage ? t('raw.stage.replaceAria') : t('raw.stage.loadAria')
        }
        onFileDrop={onRawDrop}
        accept={RAW_FILE_EXTENSIONS}
        disabled={isProcessing}
        clickToOpen={false}
        className="relative w-full h-full min-h-0 overflow-hidden rounded-lg border border-[color:oklch(0.96_0.012_86_/_0.36)] bg-gradient-to-br from-[color:oklch(0.23_0.026_76)] to-[color:oklch(0.16_0.02_76)] shadow-[0_24px_80px_oklch(0.18_0.018_76_/_0.18)]"
      >
        {({ openFilePicker, disabled }) => (
          <>
            {hasImage ? (
              <PreviewCanvas
                imageRef={imageRef}
                imageVersion={imageVersion}
                params={params}
                lutDataRef={lutDataRef}
                lutDataVersion={lutDataVersion}
                embeddedPreviewUrl={embeddedPreviewUrl}
                displaySource={displaySource}
                suspended={previewSuspended}
                interactionDisabled={isProcessing}
                previewViewport={previewViewport}
                onPreviewViewportChange={onPreviewViewportChange}
                onStatsUpdate={onStatsUpdate}
                onPipelineChange={onPipelineChange}
              />
            ) : (
              <EmptySampleCompare split={split} />
            )}

            <span className="absolute bottom-[18px] z-[4] max-w-[calc(50%-32px)] rounded-full border border-[color:oklch(0.96_0.012_86_/_0.18)] px-2.5 py-1.5 bg-[color:oklch(0.16_0.018_76_/_0.76)] text-[0.72rem] font-semibold leading-tight text-[color:--color-raw-hero-ink] opacity-0 transition-opacity duration-200 ease-out pointer-events-none group-data-[raw-compare-dragging]:opacity-100 left-[18px]">
              {t('raw.stage.leftLabel')}
            </span>
            <span className="absolute bottom-[18px] z-[4] max-w-[calc(50%-32px)] rounded-full border border-[color:oklch(0.96_0.012_86_/_0.18)] px-2.5 py-1.5 bg-[color:oklch(0.16_0.018_76_/_0.76)] text-[0.72rem] font-semibold leading-tight text-[color:--color-raw-hero-ink] opacity-0 transition-opacity duration-200 ease-out pointer-events-none group-data-[raw-compare-dragging]:opacity-100 right-[18px]">
              {t('raw.stage.rightLabel')}
            </span>

            <CompareSplitHandle
              value={split}
              onChange={onSplitChange}
              onPreviewChange={onSplitPreviewChange}
              disabled={isProcessing}
            />

            {!hasImage && (
              <UploadDock
                onOpenFilePicker={openFilePicker}
                disabled={disabled}
              />
            )}

            <ProgressOverlay
              visible={isProcessing}
              phase={phase}
              progress={progress}
              recoveryHint={recoveryHint}
            />
          </>
        )}
      </Dropzone>
    </section>
  )
}
