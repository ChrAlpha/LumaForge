/**
 * Dismissible degraded-GPU notice shown when the CPU preview safety net
 * is active because WebGPU is unavailable or the GPU preview failed.
 */

import type { CSSProperties } from 'react'

import { clsxm } from '~/lib/cn'
import { useI18n } from '~/lib/i18n'
import type { CpuPreviewReason } from '~/lib/preview/gpu-backend'

export interface CpuPreviewBannerProps {
  reason: CpuPreviewReason
  onDismiss?: () => void
  /**
   * `compact` is the mobile glass notice that sits on the photo: one or two
   * lines at 0.72rem, its dismiss hit area kept at 44px without growing the
   * notice. `default` is the desktop strip above the stage.
   */
  density?: 'default' | 'compact'
  className?: string
  style?: CSSProperties
  /** Where the mobile chrome placed the notice relative to the lens. */
  placement?: string
}

/** The notice while it is showing: what to say and how to dismiss it. */
export interface CpuPreviewNotice {
  reason: CpuPreviewReason
  onDismiss: () => void
}

export function CpuPreviewBanner({
  reason: _reason,
  onDismiss,
  density = 'default',
  className,
  style,
  placement,
}: CpuPreviewBannerProps) {
  const { t } = useI18n()
  const compact = density === 'compact'

  return (
    <div
      role="status"
      data-cpu-preview-banner
      data-density={density}
      data-placement={placement}
      style={style}
      className={clsxm(
        compact
          ? // Glass on the photo, like the lens and its hints.
            'flex items-center gap-2 rounded-md bg-[oklch(0.1_0.006_255/0.84)] py-1.5 pl-2.5 pr-1 shadow-[inset_0_0_0_1px_oklch(0.96_0.006_255/0.16)] backdrop-blur-background'
          : clsxm(
              'flex items-start gap-3 rounded-md border border-[var(--color-stage-hairline,theme(colors.lf-on-photo-bord-soft))]',
              'bg-[var(--color-stage-field,theme(colors.lf-surface/80))] px-3 py-2.5',
            ),
        className,
      )}
    >
      {/* A degraded preview is a state to explain, not a colour contract:
          neutral ink plus the icon and the words, never amber. */}
      <i
        className={clsxm(
          'i-mingcute-warning-line shrink-0 text-lf-on-photo-ink/72',
          compact ? 'text-sm' : 'mt-0.5 text-base',
        )}
        aria-hidden="true"
      />

      <p
        className={clsxm(
          'flex-1',
          compact
            ? 'm-0 text-[0.72rem] leading-snug text-lf-on-photo-ink/88'
            : 'text-xs leading-relaxed text-[var(--color-on-stage-soft,theme(colors.lf-on-photo-ink/72))]',
        )}
      >
        {t('raw.preview.cpuDegraded.banner')}
      </p>

      {onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          aria-label={t('raw.preview.cpuDegraded.dismiss')}
          className={clsxm(
            'shrink-0 text-[var(--color-on-stage-soft,theme(colors.lf-on-photo-ink/56))]',
            'transition-colors duration-100',
            'hover:text-[var(--color-on-stage,theme(colors.lf-on-photo-ink))]',
            'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-lf-green/80',
            compact
              ? // 44px to the finger, folded into the notice's own height.
                '-my-2.5 grid size-11 place-items-center rounded-md transition-[translate,color] duration-[120ms] active:translate-y-[0.5px]'
              : 'rounded p-0.5',
          )}
        >
          <i className="i-mingcute-close-line text-base" aria-hidden="true" />
        </button>
      )}
    </div>
  )
}
