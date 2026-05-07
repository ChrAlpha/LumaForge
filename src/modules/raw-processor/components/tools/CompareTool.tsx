import { RotateCcw } from 'lucide-react'

import { useI18n } from '~/lib/i18n'

import { ToolSection } from './ToolSection'

export function CompareTool({
  disabled,
  onCompareReset,
}: {
  disabled: boolean
  onCompareReset: () => void
}) {
  const { t } = useI18n()

  return (
    <ToolSection
      title={t('raw.compare.title')}
      eyebrow={t('raw.compare.eyebrow')}
    >
      <p className="m-0 mt-1.5 text-[0.72rem] leading-snug text-[color:--color-raw-ink-soft]">
        {t('raw.compare.note')}
      </p>
      <button
        type="button"
        className="mt-2.5 inline-flex h-[34px] w-fit max-w-full items-center justify-center gap-1.5 rounded-lg border border-[color:oklch(0.68_0.042_78_/_0.74)] bg-[color:oklch(0.902_0.034_82_/_0.9)] px-[11px] py-1.5 text-[0.72rem] font-semibold leading-tight text-[color:--color-raw-ink-soft] transition-all duration-150 ease-[cubic-bezier(0.22,1,0.36,1)] hover:not-disabled:-translate-y-px hover:not-disabled:border-[color:oklch(0.56_0.12_153_/_0.42)] hover:not-disabled:bg-[color:oklch(0.882_0.046_82)] hover:not-disabled:text-[color:--color-raw-green-deep] focus-visible:outline-2 focus-visible:outline-[color:--color-raw-green] focus-visible:outline-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
        disabled={disabled}
        onClick={onCompareReset}
      >
        <RotateCcw aria-hidden="true" />
        {t('raw.compare.reset')}
      </button>
    </ToolSection>
  )
}
