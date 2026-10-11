import type { LUTColorProfile } from '@lumaforge/luma-color-runtime'
import { AlertTriangle, Check, ChevronRight, CircleAlert } from 'lucide-react'
import { useId } from 'react'

import { clsxm } from '~/lib/cn'
import { useI18n } from '~/lib/i18n'

import type { LUTContractView } from '../../services/look/lut-contract'
import { formatLUTContractOutput } from '../../services/look/lut-contract-labels'
import type { PreviewLookReason } from '../../services/surface/raw-reason'
import {
  previewLookReasonContractSide,
  previewLookReasonMessageKey,
} from '../../services/surface/raw-reason'

export type LookContractStep = 'input' | 'output'

const footerTextButton =
  'inline-flex min-h-11 min-w-0 items-center gap-1.5 rounded-md text-left transition-[color,translate] duration-[120ms] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-lf-green/80 enabled:active:translate-y-[0.5px] disabled:cursor-not-allowed disabled:opacity-45'

/**
 * The Look deck's last row: on the left, what the applied LUT's colour
 * contract is (quiet once the preview draws it, amber while it needs a
 * choice or the preview leaves it out), or a load failure with Retry; on the
 * right, the way to the LUT sources.
 */
export function MobileLookFooter(props: {
  lutApplied: boolean
  contractView: LUTContractView
  /**
   * Why the preview does not draw the applied look; null when it does. The
   * look stays selected at its strength either way.
   */
  previewLookReason?: PreviewLookReason | null
  /** A tile failed to load: its title, and how to try again. */
  failure: { label: string; onRetry: () => void } | null
  /** The disabled Strength control was pressed: say why, for a moment. */
  strengthReasonShown: boolean
  /** Id carrying the Strength control's disabled reason. */
  strengthReasonId: string
  disabled: boolean
  onOpenContract: (
    step: LookContractStep,
    draft?: LUTColorProfile | null,
  ) => void
  onApplyRecommendation: (profile: LUTColorProfile) => void
  onOpenSources: () => void
}) {
  const { t } = useI18n()
  const view = props.contractView
  const reason = props.lutApplied ? (props.previewLookReason ?? null) : null
  const reasonText = reason ? t(previewLookReasonMessageKey(reason)) : null
  const reasonId = useId()

  const renderStatus = () => {
    if (props.failure) {
      return (
        <span
          role="status"
          data-look-footer="failure"
          className="flex min-w-0 items-center gap-1.5 text-lf-on-photo-ink/80"
        >
          <CircleAlert aria-hidden="true" className="size-3.5 shrink-0" />
          <span className="min-w-0 truncate">
            {t('raw.mobile.look.loadFailed', { label: props.failure.label })}
          </span>
          <button
            type="button"
            disabled={props.disabled}
            onClick={props.failure.onRetry}
            className={clsxm(
              footerTextButton,
              'shrink-0 px-1.5 font-semibold text-lf-on-photo-ink hover:text-lf-on-photo-ink',
            )}
          >
            {t('raw.mobile.lut.retry')}
          </button>
        </span>
      )
    }

    if (!props.lutApplied) {
      return (
        <span
          data-look-footer={props.strengthReasonShown ? 'strength' : 'no-lut'}
          className="min-w-0 truncate text-lf-on-photo-ink/62"
          aria-hidden={props.strengthReasonShown || undefined}
        >
          {props.strengthReasonShown
            ? t('raw.strength.reason')
            : t('raw.mobile.look.noLut')}
        </span>
      )
    }

    // A contract the preview draws reads as confirmed. One it leaves out
    // reads as that reason, and opens the side of the contract to change.
    if (reasonText && view.status !== 'recommended') {
      const side = previewLookReasonContractSide(reason)
      const step: LookContractStep | null =
        view.status === 'unknown' || view.status === 'unsupported-output'
          ? 'input'
          : view.status === 'incomplete-output'
            ? 'output'
            : side
      if (!step) {
        return (
          <span
            role="status"
            data-look-footer="preview-reason"
            className="flex min-w-0 items-center gap-1.5 text-lf-amber-soft"
          >
            <AlertTriangle aria-hidden="true" className="size-3.5 shrink-0" />
            <span className="min-w-0 truncate">{reasonText}</span>
          </span>
        )
      }
      return (
        <button
          type="button"
          data-look-footer="preview-reason"
          data-look-contract-button
          disabled={props.disabled}
          onClick={() => props.onOpenContract(step)}
          className={clsxm(
            footerTextButton,
            'text-lf-amber-soft hover:text-lf-on-photo-ink',
          )}
        >
          <AlertTriangle aria-hidden="true" className="size-3.5 shrink-0" />
          <span className="min-w-0 truncate">{reasonText}</span>
          <ChevronRight aria-hidden="true" className="size-3.5 shrink-0" />
        </button>
      )
    }

    if (view.status === 'confirmed') {
      return (
        <button
          type="button"
          data-look-footer="confirmed"
          data-look-contract-button
          disabled={props.disabled}
          aria-label={t('raw.mobile.lut.editContractAria', {
            label: view.profile.label,
          })}
          onClick={() => props.onOpenContract('input')}
          className={clsxm(
            footerTextButton,
            'text-lf-on-photo-ink/62 hover:text-lf-on-photo-ink/88',
          )}
        >
          <Check aria-hidden="true" className="size-3.5 shrink-0" />
          <span className="min-w-0 truncate">
            {view.profile.label}
            {` → ${formatLUTContractOutput(view.output)}`}
          </span>
        </button>
      )
    }

    if (view.status === 'recommended') {
      const { recommendation, completesContract } = view
      return (
        <span
          data-look-footer="recommended"
          className="flex min-w-0 items-center gap-0.5 text-lf-amber-soft"
        >
          <button
            type="button"
            data-look-contract-button
            disabled={props.disabled}
            aria-describedby={reasonText ? reasonId : undefined}
            onClick={() =>
              completesContract
                ? props.onOpenContract('input')
                : props.onOpenContract('output', recommendation)
            }
            className={clsxm(footerTextButton, 'hover:text-lf-on-photo-ink')}
          >
            <AlertTriangle aria-hidden="true" className="size-3.5 shrink-0" />
            <span className="min-w-0 truncate">
              {t('raw.mobile.look.recommended', {
                label: recommendation.label,
              })}
            </span>
          </button>
          {completesContract ? (
            <button
              type="button"
              data-raw-mobile-lut="apply-contract"
              disabled={props.disabled}
              onClick={() => props.onApplyRecommendation(recommendation)}
              className={clsxm(
                footerTextButton,
                'shrink-0 px-1.5 font-semibold text-lf-amber-soft hover:text-lf-on-photo-ink',
              )}
            >
              {' · '}
              {t('raw.mobile.look.apply')}
            </button>
          ) : (
            <ChevronRight aria-hidden="true" className="size-3.5 shrink-0" />
          )}
        </span>
      )
    }

    // Unknown input, a missing output, or an output this build cannot
    // deliver: the LUT needs its contract chosen before export.
    return (
      <button
        type="button"
        data-look-footer="needs-contract"
        data-look-contract-button
        disabled={props.disabled}
        onClick={() =>
          props.onOpenContract(
            view.status === 'incomplete-output' ? 'output' : 'input',
          )
        }
        className={clsxm(
          footerTextButton,
          'text-lf-amber-soft hover:text-lf-on-photo-ink',
        )}
      >
        <AlertTriangle aria-hidden="true" className="size-3.5 shrink-0" />
        <span className="min-w-0 truncate">
          {t('raw.mobile.look.chooseContract')}
        </span>
        <ChevronRight aria-hidden="true" className="size-3.5 shrink-0" />
      </button>
    )
  }

  return (
    <div
      data-mobile-look-footer
      className="-my-1.5 flex min-h-11 items-center justify-between gap-2 text-[0.72rem] leading-snug"
    >
      <div className="flex min-w-0 flex-1 items-center">{renderStatus()}</div>
      {!props.lutApplied && (
        <span id={props.strengthReasonId} className="sr-only">
          {t('raw.strength.reason')}
        </span>
      )}
      {reasonText && view.status === 'recommended' && (
        <span id={reasonId} className="sr-only">
          {reasonText}
        </span>
      )}
      <button
        type="button"
        data-mobile-look-sources
        onClick={props.onOpenSources}
        className={clsxm(
          footerTextButton,
          '-mr-1.5 shrink-0 px-1.5 font-semibold text-lf-on-photo-ink/72 hover:text-lf-on-photo-ink/92',
        )}
      >
        {t('raw.mobile.lut.title')}
        <ChevronRight aria-hidden="true" className="size-3.5" />
      </button>
    </div>
  )
}
