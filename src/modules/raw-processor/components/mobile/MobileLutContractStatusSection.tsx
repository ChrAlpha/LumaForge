import type { LUTColorProfile } from '@lumaforge/luma-color-runtime'
import { AlertTriangle, Check } from 'lucide-react'

import { Chip } from '~/components/ui/chip'
import { useI18n } from '~/lib/i18n'

import type { deriveLUTContractView } from '../tools/lut-contract'
import { getProfileOutputLabel } from '../tools/lut-contract'

type ContractStep = 'input' | 'output'
type ContractView = ReturnType<typeof deriveLUTContractView>

function ContractChip({
  label,
  tone = 'neutral',
}: {
  label: string
  tone?: 'neutral' | 'warning'
}) {
  return (
    <Chip
      tone={tone === 'warning' ? 'amber' : 'neutral'}
      surface="on-photo"
      size="sm"
      className="min-w-0 max-w-full"
    >
      {tone === 'warning' ? (
        <AlertTriangle aria-hidden="true" className="size-3 shrink-0" />
      ) : (
        <Check aria-hidden="true" className="size-3 shrink-0" />
      )}
      <span className="min-w-0 truncate">{label}</span>
    </Chip>
  )
}

export function MobileLutContractStatusSection({
  visible,
  contractView,
  displayOutputLabel,
  disabled,
  onLutProfileSelect,
  onOpenContractView,
}: {
  visible: boolean
  contractView: ContractView
  displayOutputLabel?: string
  disabled: boolean
  onLutProfileSelect: (profile: LUTColorProfile) => void
  onOpenContractView: (
    step?: ContractStep,
    draftOverride?: LUTColorProfile | null,
  ) => void
}) {
  const { t } = useI18n()

  if (!visible) return null

  const contractActionLabel =
    contractView.status === 'recommended' ||
    contractView.status === 'unknown' ||
    contractView.status === 'unsupported-output'
      ? t('raw.mobile.lut.chooseContract')
      : contractView.status === 'incomplete-output'
        ? t('raw.mobile.lut.chooseOutput')
        : t('raw.mobile.lut.changeContract')

  const renderStatusContent = () => {
    if (contractView.status === 'unknown') {
      return (
        <p className="m-0 rounded-md border border-lf-amber/45 bg-lf-amber/10 px-2.5 py-2 text-xs leading-relaxed text-lf-amber-soft">
          {t('raw.lutContract.unknown')}
        </p>
      )
    }

    if (contractView.status === 'unsupported-output') {
      return (
        <p className="m-0 rounded-md border border-lf-amber/45 bg-lf-amber/10 px-2.5 py-2 text-xs leading-relaxed text-lf-amber-soft">
          {t('raw.lutContract.unsupportedOutput')}
        </p>
      )
    }

    if (contractView.status === 'recommended') {
      const { recommendation, completesContract } = contractView
      const outputLabel = completesContract
        ? getProfileOutputLabel(recommendation)
        : t('raw.lutContract.chooseOutput')

      return (
        <div className="grid gap-2">
          <div className="grid gap-1">
            <span className="text-[0.66rem] font-semibold uppercase tracking-normal text-lf-on-photo-ink/50">
              {t('raw.lutContract.inputTerm')}
            </span>
            <ContractChip
              label={`${recommendation.label} · ${t('raw.lutContract.recommendedBadge')}`}
            />
          </div>
          <div className="grid gap-1">
            <span className="text-[0.66rem] font-semibold uppercase tracking-normal text-lf-on-photo-ink/50">
              {t('raw.lutContract.outputTerm')}
            </span>
            <ContractChip
              label={outputLabel ?? t('raw.lutContract.chooseOutput')}
              tone={completesContract ? 'neutral' : 'warning'}
            />
          </div>
          <p className="m-0 rounded-md border border-lf-amber/45 bg-lf-amber/10 px-2.5 py-2 text-xs leading-relaxed text-lf-amber-soft">
            {completesContract
              ? t('raw.lutContract.recommendedNote')
              : t('raw.lutContract.recommendedInputOnlyNote')}
          </p>
          {completesContract ? (
            <button
              type="button"
              data-raw-mobile-lut="apply-contract"
              className="inline-flex min-h-[44px] items-center justify-center rounded-md border border-lf-on-photo-bord-soft bg-lf-on-photo-bg-strong px-3 text-lf-control font-semibold text-lf-on-photo-ink/82 transition-colors hover:bg-[oklch(0.96_0.006_255/0.08)] hover:text-lf-on-photo-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-lf-green disabled:cursor-not-allowed disabled:opacity-50"
              disabled={disabled}
              onClick={() => onLutProfileSelect(recommendation)}
            >
              {t('raw.lutContract.applyContract')}
            </button>
          ) : (
            <button
              type="button"
              data-raw-mobile-lut="choose-output"
              className="inline-flex min-h-[44px] items-center justify-center rounded-md border border-lf-on-photo-bord-soft bg-lf-on-photo-bg-strong px-3 text-lf-control font-semibold text-lf-on-photo-ink/82 transition-colors hover:bg-[oklch(0.96_0.006_255/0.08)] hover:text-lf-on-photo-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-lf-green disabled:cursor-not-allowed disabled:opacity-50"
              disabled={disabled}
              onClick={() => onOpenContractView('output', recommendation)}
            >
              {t('raw.lutContract.chooseOutput')}
            </button>
          )}
        </div>
      )
    }

    if (
      contractView.status === 'confirmed' ||
      contractView.status === 'incomplete-output'
    ) {
      const profile = contractView.profile
      const outLabel =
        contractView.status === 'confirmed'
          ? (contractView.outputLabel ?? displayOutputLabel)
          : displayOutputLabel
      const needsOutput = contractView.status === 'incomplete-output'

      return (
        <div className="grid gap-2">
          <div className="grid gap-1">
            <span className="text-[0.66rem] font-semibold uppercase tracking-normal text-lf-on-photo-ink/50">
              {t('raw.lutContract.inputTerm')}
            </span>
            <ContractChip label={profile.label} />
          </div>
          <div className="grid gap-1">
            <span className="text-[0.66rem] font-semibold uppercase tracking-normal text-lf-on-photo-ink/50">
              {t('raw.lutContract.outputTerm')}
            </span>
            <ContractChip
              label={outLabel ?? t('raw.mobile.lut.outputRequired')}
              tone={needsOutput ? 'warning' : 'neutral'}
            />
          </div>
          {needsOutput && (
            <p className="m-0 rounded-md border border-lf-amber/45 bg-lf-amber/10 px-2.5 py-2 text-xs leading-relaxed text-lf-amber-soft">
              {t('raw.lutContract.needsOutput')}
            </p>
          )}
        </div>
      )
    }

    return (
      <p className="m-0 text-xs leading-relaxed text-lf-on-photo-ink/64">
        {t('raw.mobile.lut.noContract')}
      </p>
    )
  }

  return (
    <section className="grid gap-2">
      <div className="flex items-center justify-between gap-2">
        <h3 className="m-0 text-lf-body font-semibold text-lf-on-photo-ink">
          {t('raw.mobile.lut.contractHeading')}
        </h3>
        <span
          className={[
            'rounded-lf-pill border px-2 py-0.5 text-lf-eyebrow font-semibold',
            contractView.status !== 'confirmed'
              ? 'border-lf-amber/55 bg-lf-amber/12 text-lf-amber-soft'
              : 'border-lf-green/55 bg-lf-on-photo-bg-strong text-lf-green-soft',
          ].join(' ')}
        >
          {contractView.status !== 'confirmed'
            ? t('raw.mobile.lut.contractNeedsReview')
            : t('raw.mobile.lut.contractResolved')}
        </span>
      </div>

      <div className="grid gap-2.5 rounded-md border border-lf-on-photo-bord-soft bg-lf-on-photo-bg px-3 py-2.5">
        {renderStatusContent()}

        <button
          type="button"
          className="inline-flex min-h-[44px] items-center justify-center rounded-md border border-lf-on-photo-bord-soft bg-lf-on-photo-bg-strong px-3 text-lf-control font-semibold text-lf-on-photo-ink/82 transition-colors hover:bg-[oklch(0.96_0.006_255/0.08)] hover:text-lf-on-photo-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-lf-green disabled:cursor-not-allowed disabled:opacity-50"
          disabled={disabled}
          onClick={() =>
            onOpenContractView(
              contractView.status === 'incomplete-output' ? 'output' : 'input',
            )
          }
        >
          {contractActionLabel}
        </button>
      </div>
    </section>
  )
}
