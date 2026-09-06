import { Download, RotateCcw } from 'lucide-react'
import { useEffect } from 'react'

import { Button } from '~/components/ui/button'
import { clsxm } from '~/lib/cn'
import { useI18n } from '~/lib/i18n'
import { TransformControls } from '~/modules/transform-demo/TransformControls'

import type { RawTransformFeature } from '../../hooks/useRawTransformFeature'
import {
  SEGMENTED_FOCUS_RING,
  SEGMENTED_ITEM_TEXT,
  SEGMENTED_THUMB_BG,
  SEGMENTED_TRACK,
} from './segmented-chrome'

export function TransformTool({ feature }: { feature: RawTransformFeature }) {
  const { t } = useI18n()
  const { demo, observe } = feature
  useEffect(() => observe(), [observe])
  const failed = feature.captureError || Boolean(demo.error)
  const controlsDisabled =
    !feature.available ||
    !demo.ready ||
    feature.captureError ||
    feature.isProcessing
  const viewDisabled = !feature.current || feature.isProcessing
  const message = !feature.hasImage
    ? t('raw.transform.awaitImage')
    : failed || !feature.available
      ? demo.error === 'transform'
        ? t('transform.error.transform')
        : t('raw.transform.unavailable')
      : feature.busy && !demo.result
        ? t('raw.transform.preparing')
        : demo.mode !== 'off' && demo.solution.status === 'insufficient'
          ? t('transform.insufficient')
          : demo.mode !== 'off'
            ? t('raw.transform.modeResult', {
                mode: t(`transform.mode.${demo.mode}`),
                result: t(
                  demo.solution.status === 'unchanged'
                    ? 'transform.unchanged'
                    : 'transform.applied',
                ),
              })
            : null

  return (
    <div data-raw-transform-tool className="min-w-0 text-lf-on-photo-ink">
      {message && (
        <p
          role={failed ? 'alert' : 'status'}
          className="mb-3 text-xs leading-relaxed text-lf-on-photo-ink/72"
        >
          {message}
        </p>
      )}
      <div
        role="group"
        aria-label={t('transform.compare')}
        className={clsxm('mb-3 grid grid-cols-2 gap-1', SEGMENTED_TRACK)}
      >
        {[true, false].map((before) => (
          <Button
            key={String(before)}
            variant="ghost"
            aria-pressed={feature.before === before}
            disabled={viewDisabled}
            onClick={() => feature.setBefore(before)}
            className={clsxm(
              'h-11 px-1 text-xs',
              SEGMENTED_ITEM_TEXT,
              SEGMENTED_FOCUS_RING,
              feature.before === before && SEGMENTED_THUMB_BG,
            )}
          >
            {t(before ? 'raw.transform.before' : 'raw.transform.after')}
          </Button>
        ))}
      </div>
      <div className="mb-3 flex gap-2">
        <Button
          variant="ghost"
          className={clsxm(
            'h-11 min-w-0 flex-1 whitespace-normal px-2 text-xs',
            SEGMENTED_FOCUS_RING,
            feature.showLines && SEGMENTED_THUMB_BG,
          )}
          aria-pressed={feature.showLines}
          disabled={viewDisabled}
          onClick={() => feature.setShowLines(!feature.showLines)}
        >
          {t('transform.lines')}
        </Button>
        <Button
          variant="ghost"
          className={clsxm(
            'h-11 min-w-0 flex-1 whitespace-normal px-2 text-xs',
            SEGMENTED_FOCUS_RING,
            feature.showGrid && SEGMENTED_THUMB_BG,
          )}
          aria-pressed={feature.showGrid}
          disabled={viewDisabled}
          onClick={() => feature.setShowGrid(!feature.showGrid)}
        >
          {t('transform.grid')}
        </Button>
        <Button
          variant="ghost"
          className="h-11 min-w-0 flex-1 whitespace-normal px-2 text-xs"
          disabled={
            feature.isProcessing || (!feature.hasImage && !feature.active)
          }
          onClick={feature.reset}
        >
          <RotateCcw size={14} aria-hidden />
          {t('transform.reset')}
        </Button>
      </div>
      <TransformControls
        embedded
        mode={demo.mode}
        manual={demo.manual}
        constrainCrop={demo.constrainCrop}
        onModeChange={feature.setMode}
        onManualChange={feature.setManual}
        onCropChange={feature.setConstrainCrop}
        onReset={feature.reset}
        disabled={controlsDisabled}
      />
      <p className="mt-4 text-xs leading-relaxed text-lf-on-photo-ink/72">
        {t('raw.transform.previewNotice')}
      </p>
      {feature.current && demo.result && (
        <p className="mt-2 text-xs tabular-nums text-lf-on-photo-ink/90">
          {t('raw.transform.outputSize', {
            width: demo.result.frame.width,
            height: demo.result.frame.height,
          })}
        </p>
      )}
      <Button
        variant="light"
        className="mt-4 h-11 w-full"
        disabled={viewDisabled || feature.downloading}
        isLoading={feature.downloading}
        loadingText={t('raw.progress.exporting')}
        aria-label={t('transform.download')}
        aria-busy={feature.downloading}
        onClick={() => void feature.download()}
      >
        <Download size={14} aria-hidden />
        {t('transform.download')}
      </Button>
      {feature.downloadError && (
        <p role="alert" className="mt-2 text-xs text-lf-on-photo-ink/72">
          {t('transform.error.download')}
        </p>
      )}
    </div>
  )
}
