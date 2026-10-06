import type {
  LUTColorProfile,
  LUTContractResolution,
} from '@lumaforge/luma-color-runtime'
import { SlidersHorizontal } from 'lucide-react'
import { useCallback, useId, useRef, useState } from 'react'

import { Button } from '~/components/ui/button'
import { useI18n } from '~/lib/i18n'

import type { LUTContractSelectionState } from '../../../model/session'
import { deriveLUTContractView } from '../../../services/look/lut-contract'
import type { PreviewLookReason } from '../../../services/surface/raw-reason'
import { previewLookReasonMessageKey } from '../../../services/surface/raw-reason'
import {
  formatLUTContractOutput,
  getProfileOutputLabel,
} from '../lut-contract-labels'
import { LUTContractBrowser } from './LUTContractBrowser'

export function LUTProfileStatus({
  selection,
  resolution,
  previewLookReason,
  onSelect,
}: {
  selection?: LUTContractSelectionState | null
  resolution?: LUTContractResolution | null
  /** Why the preview does not draw this LUT; null when it does. */
  previewLookReason?: PreviewLookReason | null
  onSelect: (profile: LUTColorProfile) => void
}) {
  const { t } = useI18n()
  const view = deriveLUTContractView(selection, resolution)

  const recommendations =
    view.status === 'recommended' || view.status === 'unsupported-output'
      ? view.recommendations
      : []

  const [browserOpen, setBrowserOpen] = useState(false)
  const [browserInitialStep, setBrowserInitialStep] = useState<
    'input' | 'output'
  >('input')
  const [browserInitialDraft, setBrowserInitialDraft] =
    useState<LUTColorProfile | null>(null)

  const browserId = useId()
  const triggerRef = useRef<HTMLButtonElement | null>(null)

  const handleClose = useCallback((options?: { restoreFocus?: boolean }) => {
    setBrowserOpen(false)
    setBrowserInitialStep('input')
    setBrowserInitialDraft(null)

    if (options?.restoreFocus) {
      queueMicrotask(() => triggerRef.current?.focus())
    }
  }, [])

  const openBrowser = useCallback(
    (step: 'input' | 'output', draft?: LUTColorProfile | null) => {
      setBrowserInitialStep(step)
      setBrowserInitialDraft(draft ?? null)
      setBrowserOpen(true)
    },
    [],
  )

  if (!selection && !resolution) return null

  const currentProfile =
    view.status === 'confirmed' || view.status === 'incomplete-output'
      ? view.profile
      : undefined

  return (
    <div className="space-y-2 pt-1">
      {view.status === 'confirmed' ? (
        <div className="grid min-w-0 gap-1.5 text-[0.78rem] leading-snug">
          <p className="m-0 grid min-w-0 grid-cols-[4.2rem_minmax(0,1fr)] items-baseline gap-2">
            <span className="text-[0.72rem] tracking-tight text-lf-on-surface/62">
              {t('raw.lutContract.inputTerm')}
            </span>
            <span className="min-w-0 break-words font-medium text-lf-on-surface/85">
              {view.profile.label}
            </span>
          </p>
          <p className="m-0 grid min-w-0 grid-cols-[4.2rem_minmax(0,1fr)] items-baseline gap-2">
            <span className="text-[0.72rem] tracking-tight text-lf-on-surface/62">
              {t('raw.lutContract.outputTerm')}
            </span>
            <span className="min-w-0 break-words font-medium text-lf-on-surface/85">
              {formatLUTContractOutput(view.output)}
            </span>
          </p>
          {/* A confirmed contract the preview still leaves out says why,
              rather than reading as applied. */}
          {previewLookReason && (
            <p
              className="m-0 inline-flex w-full items-start gap-2 rounded-md bg-[oklch(from_var(--color-lf-amber)_l_c_h_/_0.10)] px-2.5 py-2 text-lf-body leading-relaxed text-lf-on-surface/80"
              data-raw-lut="preview-reason"
            >
              {t(previewLookReasonMessageKey(previewLookReason))}
            </p>
          )}
        </div>
      ) : view.status === 'incomplete-output' ? (
        <div className="grid min-w-0 gap-1.5 text-[0.78rem] leading-snug">
          <p className="m-0 grid min-w-0 grid-cols-[4.2rem_minmax(0,1fr)] items-baseline gap-2">
            <span className="text-[0.72rem] tracking-tight text-lf-on-surface/62">
              {t('raw.lutContract.inputTerm')}
            </span>
            <span className="min-w-0 break-words font-medium text-lf-on-surface/85">
              {view.profile.label}
            </span>
          </p>
          <p className="m-0 grid min-w-0 grid-cols-[4.2rem_minmax(0,1fr)] items-baseline gap-2">
            <span className="text-[0.72rem] tracking-tight text-lf-on-surface/62">
              {t('raw.lutContract.outputTerm')}
            </span>
            <span className="min-w-0 break-words font-medium text-lf-on-surface/85">
              {getProfileOutputLabel(view.profile)}
            </span>
          </p>
          <p
            className="m-0 inline-flex w-full items-start gap-2 rounded-md bg-[oklch(from_var(--color-lf-amber)_l_c_h_/_0.10)] px-2.5 py-2 text-lf-body leading-relaxed text-lf-on-surface/80"
            data-raw-lut="contract-status"
          >
            {t('raw.lutContract.needsOutput')}
          </p>
        </div>
      ) : view.status === 'recommended' ? (
        <div className="grid min-w-0 gap-1.5 text-[0.78rem] leading-snug">
          <p className="m-0 grid min-w-0 grid-cols-[4.2rem_minmax(0,1fr)] items-baseline gap-2">
            <span className="text-[0.72rem] tracking-tight text-lf-on-surface/62">
              {t('raw.lutContract.inputTerm')}
            </span>
            <span className="min-w-0 break-words font-medium text-lf-on-surface/85">
              {view.recommendation.label}
              <span className="ml-1 font-normal text-lf-on-surface/55">
                · {t('raw.lutContract.recommendedBadge')}
              </span>
            </span>
          </p>
          <p className="m-0 grid min-w-0 grid-cols-[4.2rem_minmax(0,1fr)] items-baseline gap-2">
            <span className="text-[0.72rem] tracking-tight text-lf-on-surface/62">
              {t('raw.lutContract.outputTerm')}
            </span>
            <span className="min-w-0 break-words font-medium text-lf-on-surface/85">
              {view.completesContract
                ? getProfileOutputLabel(view.recommendation)
                : t('raw.lutContract.chooseOutput')}
              {view.completesContract && (
                <span className="ml-1 font-normal text-lf-on-surface/55">
                  · {t('raw.lutContract.recommendedBadge')}
                </span>
              )}
            </span>
          </p>
          <p
            className="m-0 inline-flex w-full items-start gap-2 rounded-md bg-[oklch(from_var(--color-lf-amber)_l_c_h_/_0.10)] px-2.5 py-2 text-lf-body leading-relaxed text-lf-on-surface/80"
            data-raw-lut="contract-status"
          >
            {view.completesContract
              ? t('raw.lutContract.recommendedNote')
              : t('raw.lutContract.recommendedInputOnlyNote')}
          </p>
          {previewLookReason && (
            <p
              className="m-0 text-[0.72rem] leading-relaxed text-lf-on-surface/72"
              data-raw-lut="preview-reason"
            >
              {t(previewLookReasonMessageKey(previewLookReason))}
            </p>
          )}
          {view.completesContract ? (
            <Button
              type="button"
              variant="primary"
              size="sm"
              data-raw-lut="apply-contract"
              onClick={() => onSelect(view.recommendation)}
            >
              {t('raw.lutContract.applyContract')}
            </Button>
          ) : (
            <Button
              type="button"
              variant="light"
              size="sm"
              data-raw-lut="choose-output"
              onClick={() => openBrowser('output', view.recommendation)}
            >
              {t('raw.lutContract.chooseOutput')}
            </Button>
          )}
        </div>
      ) : view.status === 'unsupported-output' ? (
        <p
          className="m-0 inline-flex w-full items-start gap-2 rounded-md bg-[oklch(from_var(--color-lf-amber)_l_c_h_/_0.10)] px-2.5 py-2 text-lf-body leading-relaxed text-lf-on-surface/80"
          data-raw-lut="contract-status"
        >
          {t('raw.lutContract.unsupportedOutput')}
        </p>
      ) : (
        <p
          className="m-0 inline-flex w-full items-start gap-2 rounded-md bg-[oklch(from_var(--color-lf-amber)_l_c_h_/_0.10)] px-2.5 py-2 text-lf-body leading-relaxed text-lf-on-surface/80"
          data-raw-lut="contract-status"
        >
          {t('raw.lutContract.unknown')}
        </p>
      )}

      <Button
        ref={triggerRef}
        type="button"
        variant="light"
        size="sm"
        className="self-start [&_svg]:size-3.5"
        data-raw-lut="contract-change-button"
        aria-controls={browserId}
        aria-expanded={browserOpen}
        aria-haspopup="dialog"
        onClick={() => {
          if (browserOpen) {
            handleClose({ restoreFocus: true })
          } else {
            openBrowser('input')
          }
        }}
      >
        <SlidersHorizontal aria-hidden="true" />
        {t('raw.lutContract.change')}
      </Button>

      <LUTContractBrowser
        open={browserOpen}
        onClose={handleClose}
        suggestions={recommendations}
        currentProfile={currentProfile}
        onSelect={onSelect}
        triggerRef={triggerRef}
        browserId={browserId}
        initialStep={browserInitialStep}
        initialInputDraft={browserInitialDraft}
      />
    </div>
  )
}
