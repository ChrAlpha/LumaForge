import type { ColorGraphIntent, LUTData } from '@lumaforge/luma-color-runtime'
import { pickColorGraphIntent } from '@lumaforge/luma-color-runtime'
import type {
  CpuPreviewFrame,
  CpuPreviewVariant,
} from '@lumaforge/render-engine/preview'
import { useEffect, useState } from 'react'

import { clsxm } from '~/lib/cn'
import { useI18n } from '~/lib/i18n'
import type { DecodedPreviewFrame } from '~/lib/preview/preview-frame'
import type { DecodedImage } from '~/lib/raw/decoder'

import { useCpuPreview } from '../hooks/useCpuPreview'
import { CpuPreviewCanvas } from './CpuPreviewCanvas'

export interface RawCpuPreviewStageProps {
  image: DecodedImage | null
  /** The descriptor the workflow accepted `image` under. */
  decodedFrame: DecodedPreviewFrame | null
  /** The processed frame's color; the neutral frame ignores it. */
  color: ColorGraphIntent
  lut: LUTData | null
  fallbackThumbnailUrl: string | null
  /**
   * The frame the stage shows while it shows the processed photo (null for
   * the original or a failed render), and whether the next one is still
   * rendering. Only a frame that is not rendering is the photo as it now
   * looks.
   */
  onProcessedFrame?: (frame: CpuPreviewFrame | null, rendering: boolean) => void
  previewFrameRef?: (element: HTMLDivElement | null) => void
  transformActive?: boolean
  /**
   * Set when the caller owns the original / processed choice (the mobile
   * compare lens). The stage then shows this variant and renders no toggle
   * row of its own, so the photo keeps the whole stage region.
   */
  variant?: CpuPreviewVariant
}

export function RawCpuPreviewStage({
  image,
  decodedFrame,
  color,
  lut,
  fallbackThumbnailUrl,
  onProcessedFrame,
  previewFrameRef,
  transformActive = false,
  variant: controlledVariant,
}: RawCpuPreviewStageProps) {
  const { t } = useI18n()
  const [localVariant, setVariant] = useState<CpuPreviewVariant>('processed')
  const variantControlled = controlledVariant !== undefined
  const variant = controlledVariant ?? localVariant
  const cpuPreview = useCpuPreview({
    enabled: Boolean(image),
    image,
    decodedFrame,
    params: {
      ...pickColorGraphIntent(color),
      lut,
      rawRenderExposure: image?.renderExposure ?? {
        ev: 0,
        multiplier: 1,
        source: 'identity',
      },
    },
    variant: transformActive ? 'processed' : variant,
  })

  useEffect(() => {
    onProcessedFrame?.(
      !cpuPreview.failureReason && (transformActive || variant === 'processed')
        ? cpuPreview.frame
        : null,
      cpuPreview.inFlight,
    )
  }, [
    cpuPreview.failureReason,
    cpuPreview.frame,
    cpuPreview.inFlight,
    onProcessedFrame,
    transformActive,
    variant,
  ])

  return (
    <section
      className="raw-lab-stage relative flex flex-col"
      aria-label={t('raw.stage.aria')}
    >
      <div ref={previewFrameRef} className="relative min-h-0 flex-1">
        <CpuPreviewCanvas
          frame={cpuPreview.frame}
          inFlight={cpuPreview.inFlight}
          failureReason={cpuPreview.failureReason}
          fallbackThumbnailUrl={fallbackThumbnailUrl}
          className="h-full min-h-0"
        />
      </div>
      {image && !transformActive && !variantControlled && (
        <div className="flex shrink-0 justify-center gap-2 px-3 py-2">
          <button
            type="button"
            onClick={() => setVariant('processed')}
            className={clsxm(
              'rounded-full border px-3 py-1 text-xs font-medium transition-colors',
              variant === 'processed'
                ? 'border-lf-green/60 bg-lf-green/10 text-lf-on-photo-ink'
                : 'border-lf-on-photo-bord-soft bg-lf-on-photo-bg-strong text-lf-on-photo-ink/60 hover:text-lf-on-photo-ink',
            )}
          >
            {t('raw.preview.cpuDegraded.showProcessed')}
          </button>
          <button
            type="button"
            onClick={() => setVariant('neutral')}
            className={clsxm(
              'rounded-full border px-3 py-1 text-xs font-medium transition-colors',
              variant === 'neutral'
                ? 'border-lf-green/60 bg-lf-green/10 text-lf-on-photo-ink'
                : 'border-lf-on-photo-bord-soft bg-lf-on-photo-bg-strong text-lf-on-photo-ink/60 hover:text-lf-on-photo-ink',
            )}
          >
            {t('raw.preview.cpuDegraded.showOriginal')}
          </button>
        </div>
      )}
    </section>
  )
}
