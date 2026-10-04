import {
  AlertTriangle,
  Check,
  ChevronRight,
  SlidersHorizontal,
} from 'lucide-react'

import { useI18n } from '~/lib/i18n'

import { useLutContractSummary } from '../tools/lut/useLutContractSummary'
import { getProfileOutputLabel } from '../tools/lut-contract'
import type { MobileLutBrowserProps } from './MobileLutBrowser'

export interface MobileLookPanelProps {
  lutBrowser: Omit<MobileLutBrowserProps, 'open' | 'onClose'>
  onOpenLutBrowser: () => void
  onOpenLutContractBrowser: () => void
}

// "Add LUT" and "Change LUT" are plain actions, so they take the neutral lift
// (DESIGN.md §6 Cool Lift Rule). Amber stays on the contract cards below,
// where it explains what the LUT expects.
const lookActionClass =
  'inline-flex min-h-10 shrink-0 items-center gap-1.5 rounded-lf-pill bg-[oklch(0.96_0.006_255/0.06)] px-3 text-lf-label font-semibold text-lf-on-photo-ink transition-colors hover:bg-[oklch(0.96_0.006_255/0.10)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-lf-green/80'

export function MobileLookPanel({
  lutBrowser,
  onOpenLutBrowser,
  onOpenLutContractBrowser,
}: MobileLookPanelProps) {
  const { t } = useI18n()
  const {
    resolvedProfile: resolvedLutProfile,
    outputRequired: lutNeedsOutput,
    displayOutputLabel: displayLutOutputLabel,
    contractView: lutContractView,
    needsUserSelection: lutNeedsUserSelection,
  } = useLutContractSummary({
    lutProfileSelection: lutBrowser.lutProfileSelection,
    lutProfileResolution: lutBrowser.lutProfileResolution,
  })
  const lutContractWarningLabel = lutNeedsUserSelection
    ? t('raw.mobile.lut.chooseContract')
    : lutNeedsOutput
      ? t('raw.mobile.lut.chooseOutput')
      : null

  return (
    <div className="grid gap-2.5">
      {lutBrowser.currentLutName ? (
        <div className="grid gap-2 rounded-lf-panel border border-lf-on-photo-bord-soft bg-lf-on-photo-bg p-3">
          <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2">
            <span className="min-w-0 truncate text-lf-control font-semibold text-lf-on-photo-ink">
              {lutBrowser.currentLutName}
            </span>
            <button
              type="button"
              aria-label={t('raw.mobile.lut.changeAria')}
              onClick={onOpenLutBrowser}
              className={lookActionClass}
            >
              {t('raw.mobile.lut.change')}
              <ChevronRight aria-hidden="true" className="size-3" />
            </button>
          </div>

          {lutContractView.status === 'recommended' ? (
            <button
              type="button"
              onClick={onOpenLutContractBrowser}
              aria-label={t('raw.mobile.lut.chooseContract')}
              className="grid gap-1.5 rounded-lf-control border border-lf-amber/35 bg-lf-amber/10 px-2.5 py-2 text-left transition-colors hover:border-lf-amber/60"
            >
              <span className="flex items-center justify-between gap-2 text-lf-eyebrow font-semibold uppercase tracking-wide text-lf-amber-soft">
                {t('raw.lutContract.recommendedBadge')}
                <span className="inline-flex items-center gap-1">
                  {t('raw.mobile.lut.chooseContract')}
                  <ChevronRight aria-hidden="true" className="size-3" />
                </span>
              </span>
              <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                <span className="inline-flex max-w-full items-center gap-1.5 rounded-lf-pill border border-lf-on-photo-bord-soft bg-lf-on-photo-bg px-2.5 py-1 text-lf-eyebrow font-semibold text-lf-on-photo-ink/86">
                  <span className="min-w-0 truncate">
                    {lutContractView.recommendation.label}
                  </span>
                </span>
                <ChevronRight
                  aria-hidden="true"
                  className="size-3 shrink-0 text-lf-on-photo-ink/35"
                />
                <span className="inline-flex max-w-full items-center gap-1.5 rounded-lf-pill border border-lf-on-photo-bord-soft bg-lf-on-photo-bg px-2.5 py-1 text-lf-eyebrow font-semibold text-lf-on-photo-ink/86">
                  <span className="min-w-0 truncate">
                    {lutContractView.completesContract
                      ? getProfileOutputLabel(lutContractView.recommendation)
                      : t('raw.lutContract.chooseOutput')}
                  </span>
                </span>
              </div>
              <span className="text-xs leading-relaxed text-lf-amber-soft">
                {lutContractView.completesContract
                  ? t('raw.lutContract.recommendedNote')
                  : t('raw.lutContract.recommendedInputOnlyNote')}
              </span>
            </button>
          ) : lutNeedsUserSelection ? (
            <button
              type="button"
              onClick={onOpenLutContractBrowser}
              aria-label={lutContractWarningLabel ?? undefined}
              className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 rounded-lf-control border border-lf-amber/35 bg-lf-amber/10 px-2.5 py-2 text-left text-xs leading-relaxed text-lf-amber-soft transition-colors hover:border-lf-amber/60 hover:text-lf-on-photo-ink"
            >
              <span className="inline-flex min-w-0 items-start gap-1.5">
                <AlertTriangle
                  aria-hidden="true"
                  className="mt-0.5 size-3 shrink-0"
                />
                <span className="min-w-0">{t('raw.lutContract.unknown')}</span>
              </span>
              <span className="inline-flex shrink-0 items-center gap-1 text-lf-eyebrow font-semibold uppercase tracking-wide text-lf-amber-soft">
                {lutContractWarningLabel}
                <ChevronRight aria-hidden="true" className="size-3" />
              </span>
            </button>
          ) : resolvedLutProfile ? (
            <button
              type="button"
              onClick={onOpenLutContractBrowser}
              aria-label={t('raw.mobile.lut.editContractAria', {
                label: resolvedLutProfile.label,
              })}
              className="grid gap-1.5 rounded-lf-control border border-lf-on-photo-bord-soft bg-lf-on-photo-bg px-2.5 py-2 text-left transition-colors hover:bg-[oklch(0.96_0.006_255/0.06)]"
            >
              <span className="flex items-center justify-between gap-2 text-lf-eyebrow font-semibold uppercase tracking-wide text-lf-on-photo-ink/45">
                {t('raw.mobile.lut.contractHeading')}
                <span className="inline-flex items-center gap-1 text-lf-on-photo-ink/72">
                  <SlidersHorizontal aria-hidden="true" className="size-3" />
                  {t('raw.mobile.lut.editContract')}
                </span>
              </span>
              <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                <span className="inline-flex max-w-full items-center gap-1.5 rounded-lf-pill border border-lf-on-photo-bord-soft bg-lf-on-photo-bg px-2.5 py-1 text-lf-eyebrow font-semibold text-lf-on-photo-ink/86">
                  <Check aria-hidden="true" className="size-3 shrink-0" />
                  <span className="min-w-0 truncate">
                    {resolvedLutProfile.label}
                  </span>
                </span>
                <ChevronRight
                  aria-hidden="true"
                  className="size-3 shrink-0 text-lf-on-photo-ink/35"
                />
                <span
                  className={[
                    'inline-flex max-w-full items-center gap-1.5 rounded-lf-pill border px-2.5 py-1 text-lf-eyebrow font-semibold',
                    lutNeedsOutput
                      ? 'border-lf-amber/45 bg-lf-amber/12 text-lf-amber-soft'
                      : 'border-lf-on-photo-bord-soft bg-lf-on-photo-bg text-lf-on-photo-ink/86',
                  ].join(' ')}
                >
                  {lutNeedsOutput ? (
                    <AlertTriangle
                      aria-hidden="true"
                      className="size-3 shrink-0"
                    />
                  ) : (
                    <Check aria-hidden="true" className="size-3 shrink-0" />
                  )}
                  <span className="min-w-0 truncate">
                    {displayLutOutputLabel ??
                      t('raw.mobile.lut.outputRequired')}
                  </span>
                </span>
              </div>
              {lutNeedsOutput && lutContractWarningLabel && (
                <span className="inline-flex items-center gap-1 text-lf-eyebrow font-semibold text-lf-amber-soft">
                  {lutContractWarningLabel}
                  <ChevronRight aria-hidden="true" className="size-3" />
                </span>
              )}
            </button>
          ) : (
            <button
              type="button"
              onClick={onOpenLutContractBrowser}
              aria-label={t('raw.mobile.lut.chooseContract')}
              className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 rounded-lf-control border border-lf-on-photo-bord-soft bg-lf-on-photo-bg px-2.5 py-2 text-left text-xs leading-relaxed text-lf-on-photo-ink/68 transition-colors hover:bg-[oklch(0.96_0.006_255/0.06)] hover:text-lf-on-photo-ink"
            >
              <span className="min-w-0">{t('raw.mobile.lut.noContract')}</span>
              <span className="inline-flex shrink-0 items-center gap-1 text-lf-eyebrow font-semibold uppercase tracking-wide text-lf-amber-soft">
                {t('raw.mobile.lut.chooseContract')}
                <ChevronRight aria-hidden="true" className="size-3" />
              </span>
            </button>
          )}
        </div>
      ) : (
        <div className="flex items-center justify-between gap-2 rounded-lf-panel border border-lf-on-photo-bord-soft bg-lf-on-photo-bg p-3">
          <span className="text-lf-control font-semibold text-lf-on-photo-ink/76">
            {t('raw.mobile.lut.noCurrent')}
          </span>
          <button
            type="button"
            aria-label={t('raw.mobile.lut.title')}
            onClick={onOpenLutBrowser}
            className={lookActionClass}
          >
            {t('raw.mobile.lut.add')}
            <ChevronRight aria-hidden="true" className="size-3" />
          </button>
        </div>
      )}
    </div>
  )
}
