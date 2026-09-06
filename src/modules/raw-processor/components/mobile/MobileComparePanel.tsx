import { Eye, RotateCcw, SplitSquareHorizontal } from 'lucide-react'
import { m, useReducedMotion } from 'motion/react'

import { useI18n } from '~/lib/i18n'
import { surfaceFade } from '~/lib/spring'

import { TAP_SPRING } from '../../motion'

export function MobileComparePanel({
  splitOpen,
  onCompareReset,
  onSplitOpenChange,
}: {
  splitOpen: boolean
  onCompareReset: () => void
  onSplitOpenChange: (open: boolean) => void
}) {
  const { t } = useI18n()
  const prefersReduced = useReducedMotion() ?? false
  const enterY = prefersReduced ? 0 : 6

  if (splitOpen) {
    return (
      <m.section
        key="split"
        initial={{ opacity: 0, y: enterY }}
        animate={{ opacity: 1, y: 0 }}
        transition={surfaceFade}
        aria-label={t('raw.compare.title')}
        className="grid gap-3 rounded-md border border-lf-on-photo-bord-soft bg-lf-on-photo-bg p-3.5 text-lf-on-photo-ink"
        data-mobile-compare-panel="split"
      >
        <div className="grid grid-cols-[auto_minmax(0,1fr)] gap-3">
          <span className="grid size-9 place-items-center rounded-md border border-lf-amber/35 bg-lf-amber/12 text-lf-amber-soft">
            <SplitSquareHorizontal aria-hidden="true" className="size-4" />
          </span>
          <div className="min-w-0">
            <h2 className="m-0 text-sm font-semibold text-lf-on-photo-ink">
              {t('raw.mobile.compare.split')}
            </h2>
            <p className="m-0 mt-1 text-xs leading-relaxed text-lf-on-photo-ink/68">
              {t('raw.mobile.compare.splitHint')}
            </p>
          </div>
        </div>
        <div className="grid gap-2">
          <m.button
            type="button"
            whileTap={{ y: 0.5 }}
            transition={TAP_SPRING}
            onClick={() => onSplitOpenChange(false)}
            className="inline-flex min-h-[44px] items-center justify-center gap-2 rounded-md border border-lf-on-photo-bord-soft bg-lf-on-photo-bg-strong px-3 text-sm font-semibold text-lf-on-photo-ink transition-colors hover:border-lf-amber/55 hover:text-lf-amber-soft"
          >
            <Eye aria-hidden="true" className="size-4" />
            {t('raw.mobile.compare.holdMode')}
          </m.button>
          <m.button
            type="button"
            whileTap={{ y: 0.5 }}
            transition={TAP_SPRING}
            onClick={onCompareReset}
            className="inline-flex min-h-[44px] items-center justify-center gap-2 rounded-md border border-lf-on-photo-bord-soft bg-lf-on-photo-bg-strong px-3 text-sm font-semibold text-lf-on-photo-ink transition-colors hover:border-lf-amber/55 hover:text-lf-amber-soft"
          >
            <RotateCcw aria-hidden="true" className="size-4" />
            {t('raw.compare.reset')}
          </m.button>
        </div>
      </m.section>
    )
  }

  return (
    <m.section
      key="peek"
      initial={{ opacity: 0, y: enterY }}
      animate={{ opacity: 1, y: 0 }}
      transition={surfaceFade}
      aria-label={t('raw.compare.title')}
      className="grid gap-3 rounded-md border border-lf-on-photo-bord-soft bg-lf-on-photo-bg p-3.5 text-lf-on-photo-ink"
      data-mobile-compare-panel="peek"
    >
      <div className="grid grid-cols-[auto_minmax(0,1fr)] gap-3">
        <span className="grid size-9 place-items-center rounded-md border border-lf-amber/35 bg-lf-amber/12 text-lf-amber-soft">
          <Eye aria-hidden="true" className="size-4" />
        </span>
        <div className="min-w-0">
          <h2 className="m-0 text-sm font-semibold text-lf-on-photo-ink">
            {t('raw.mobile.compare.touchHold')}
          </h2>
          <p className="m-0 mt-1 text-xs leading-relaxed text-lf-on-photo-ink/68">
            {t('raw.mobile.compare.copy')}
          </p>
        </div>
      </div>
      <m.button
        type="button"
        whileTap={{ y: 0.5 }}
        transition={TAP_SPRING}
        onClick={() => onSplitOpenChange(true)}
        className="inline-flex min-h-[44px] items-center justify-center gap-2 rounded-md border border-lf-on-photo-bord-soft bg-lf-on-photo-bg-strong px-3 text-sm font-semibold text-lf-on-photo-ink transition-colors hover:border-lf-amber/55 hover:text-lf-amber-soft"
      >
        <SplitSquareHorizontal aria-hidden="true" className="size-4" />
        {t('raw.mobile.compare.split')}
      </m.button>
    </m.section>
  )
}
