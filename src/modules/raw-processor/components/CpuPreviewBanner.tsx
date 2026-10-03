/**
 * Dismissible degraded-GPU notice shown when the CPU preview safety net
 * is active because WebGPU is unavailable or the GPU preview failed.
 */

import { clsxm } from '~/lib/cn'
import { useI18n } from '~/lib/i18n'
import type { CpuPreviewReason } from '~/lib/preview/gpu-backend'

export interface CpuPreviewBannerProps {
  reason: CpuPreviewReason
  onDismiss?: () => void
  className?: string
}

/** The notice while it is showing: what to say and how to dismiss it. */
export interface CpuPreviewNotice {
  reason: CpuPreviewReason
  onDismiss: () => void
}

export function CpuPreviewBanner({
  reason: _reason,
  onDismiss,
  className,
}: CpuPreviewBannerProps) {
  const { t } = useI18n()

  return (
    <div
      role="status"
      data-cpu-preview-banner
      className={clsxm(
        'flex items-start gap-3 rounded-md border border-[var(--color-stage-hairline,theme(colors.lf-on-photo-bord-soft))]',
        'bg-[var(--color-stage-field,theme(colors.lf-surface/80))] px-3 py-2.5',
        className,
      )}
    >
      <i
        className="i-mingcute-warning-line mt-0.5 shrink-0 text-base text-[var(--color-progress,theme(colors.lf-amber))]"
        aria-hidden="true"
      />

      <p className="flex-1 text-xs leading-relaxed text-[var(--color-on-stage-soft,theme(colors.lf-on-photo-ink/72))]">
        {t('raw.preview.cpuDegraded.banner')}
      </p>

      {onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          aria-label={t('raw.preview.cpuDegraded.dismiss')}
          className={clsxm(
            'shrink-0 rounded p-0.5 text-[var(--color-on-stage-soft,theme(colors.lf-on-photo-ink/56))]',
            'transition-colors duration-100',
            'hover:text-[var(--color-on-stage,theme(colors.lf-on-photo-ink))]',
            'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-lf-green/80',
          )}
        >
          <i className="i-mingcute-close-line text-base" aria-hidden="true" />
        </button>
      )}
    </div>
  )
}
