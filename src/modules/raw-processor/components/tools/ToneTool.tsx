import { RotateCcw } from 'lucide-react'
import { useId } from 'react'
import { useForm } from 'react-hook-form'
import { z } from 'zod'

import { useI18n } from '~/lib/i18n'

import { ToolSection } from './ToolSection'

export const ToneValueSchema = z.object({
  userExposureEv: z.number().min(-5).max(5),
  userContrast: z.number().min(-100).max(100),
  userHighlights: z.number().min(-100).max(100),
  userShadows: z.number().min(-100).max(100),
  userWhites: z.number().min(-100).max(100),
  userBlacks: z.number().min(-100).max(100),
})

export type ToneValue = z.infer<typeof ToneValueSchema>

const TONE_DEFAULTS: ToneValue = {
  userExposureEv: 0,
  userContrast: 0,
  userHighlights: 0,
  userShadows: 0,
  userWhites: 0,
  userBlacks: 0,
}

export function ToneTool({
  value,
  disabled,
  onChange,
  onReset,
}: {
  value: ToneValue
  disabled: boolean
  onChange: (value: Partial<ToneValue>) => void
  onReset: () => void
}) {
  const { t } = useI18n()
  const { register, watch, reset } = useForm<ToneValue>({
    values: value,
    defaultValues: TONE_DEFAULTS,
  })

  const exposureId = useId()
  const contrastId = useId()
  const highlightsId = useId()
  const shadowsId = useId()
  const whitesId = useId()
  const blacksId = useId()

  const currentValues = watch()
  const isNeutral = Object.entries(currentValues).every(
    ([key, val]) => val === TONE_DEFAULTS[key as keyof ToneValue],
  )

  const handleReset = () => {
    reset(TONE_DEFAULTS)
    onReset()
  }

  const registerRange = (field: keyof ToneValue) =>
    register(field, {
      valueAsNumber: true,
      onChange: (event) =>
        onChange({ [field]: Number(event.currentTarget.value) }),
    })

  return (
    <ToolSection title={t('raw.tone.title')} eyebrow={t('raw.tone.eyebrow')}>
      <div className="grid gap-2.5">
        <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-2.5 gap-y-1.5">
          <label
            className="text-[0.76rem] font-semibold text-[color:--color-raw-ink]"
            htmlFor={exposureId}
          >
            {t('raw.tone.exposure')}
          </label>
          <output
            className="text-[color:--color-raw-ink-soft] tabular-nums"
            aria-hidden="true"
          >
            {value.userExposureEv.toFixed(2)} EV
          </output>
          <input
            className="col-span-full w-full accent-[color:--color-raw-green]"
            id={exposureId}
            type="range"
            min={-5}
            max={5}
            step={0.01}
            disabled={disabled}
            {...registerRange('userExposureEv')}
          />
        </div>
        <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-2.5 gap-y-1.5">
          <label
            className="text-[0.76rem] font-semibold text-[color:--color-raw-ink]"
            htmlFor={contrastId}
          >
            {t('raw.tone.contrast')}
          </label>
          <output
            className="text-[color:--color-raw-ink-soft] tabular-nums"
            aria-hidden="true"
          >
            {Math.round(value.userContrast)}
          </output>
          <input
            className="col-span-full w-full accent-[color:--color-raw-green]"
            id={contrastId}
            type="range"
            min={-100}
            max={100}
            step={1}
            disabled={disabled}
            {...registerRange('userContrast')}
          />
        </div>
        <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-2.5 gap-y-1.5">
          <label
            className="text-[0.76rem] font-semibold text-[color:--color-raw-ink]"
            htmlFor={highlightsId}
          >
            {t('raw.tone.highlights')}
          </label>
          <output
            className="text-[color:--color-raw-ink-soft] tabular-nums"
            aria-hidden="true"
          >
            {Math.round(value.userHighlights)}
          </output>
          <input
            className="col-span-full w-full accent-[color:--color-raw-green]"
            id={highlightsId}
            type="range"
            min={-100}
            max={100}
            step={1}
            disabled={disabled}
            {...registerRange('userHighlights')}
          />
        </div>
        <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-2.5 gap-y-1.5">
          <label
            className="text-[0.76rem] font-semibold text-[color:--color-raw-ink]"
            htmlFor={shadowsId}
          >
            {t('raw.tone.shadows')}
          </label>
          <output
            className="text-[color:--color-raw-ink-soft] tabular-nums"
            aria-hidden="true"
          >
            {Math.round(value.userShadows)}
          </output>
          <input
            className="col-span-full w-full accent-[color:--color-raw-green]"
            id={shadowsId}
            type="range"
            min={-100}
            max={100}
            step={1}
            disabled={disabled}
            {...registerRange('userShadows')}
          />
        </div>
        <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-2.5 gap-y-1.5">
          <label
            className="text-[0.76rem] font-semibold text-[color:--color-raw-ink]"
            htmlFor={whitesId}
          >
            {t('raw.tone.whites')}
          </label>
          <output
            className="text-[color:--color-raw-ink-soft] tabular-nums"
            aria-hidden="true"
          >
            {Math.round(value.userWhites)}
          </output>
          <input
            className="col-span-full w-full accent-[color:--color-raw-green]"
            id={whitesId}
            type="range"
            min={-100}
            max={100}
            step={1}
            disabled={disabled}
            {...registerRange('userWhites')}
          />
        </div>
        <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-2.5 gap-y-1.5">
          <label
            className="text-[0.76rem] font-semibold text-[color:--color-raw-ink]"
            htmlFor={blacksId}
          >
            {t('raw.tone.blacks')}
          </label>
          <output
            className="text-[color:--color-raw-ink-soft] tabular-nums"
            aria-hidden="true"
          >
            {Math.round(value.userBlacks)}
          </output>
          <input
            className="col-span-full w-full accent-[color:--color-raw-green]"
            id={blacksId}
            type="range"
            min={-100}
            max={100}
            step={1}
            disabled={disabled}
            {...registerRange('userBlacks')}
          />
        </div>
      </div>
      <p className="m-0 mt-1.5 text-[0.72rem] leading-snug text-[color:--color-raw-ink-soft]">
        {t('raw.tone.note')}
      </p>
      {!isNeutral && (
        <p className="m-0 mt-1.5 text-[0.72rem] leading-snug text-[color:--color-raw-ink-soft]">
          {t('raw.tone.preserved')}
        </p>
      )}
      <button
        type="button"
        className="mt-2.5 inline-flex h-[34px] w-fit max-w-full items-center justify-center gap-1.5 rounded-lg border border-[color:oklch(0.68_0.042_78_/_0.74)] bg-[color:oklch(0.902_0.034_82_/_0.9)] px-[11px] py-1.5 text-[0.72rem] font-semibold leading-tight text-[color:--color-raw-ink-soft] transition-all duration-150 ease-[cubic-bezier(0.22,1,0.36,1)] hover:not-disabled:-translate-y-px hover:not-disabled:border-[color:oklch(0.56_0.12_153_/_0.42)] hover:not-disabled:bg-[color:oklch(0.882_0.046_82)] hover:not-disabled:text-[color:--color-raw-green-deep] focus-visible:outline-2 focus-visible:outline-[color:--color-raw-green] focus-visible:outline-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
        disabled={disabled}
        onClick={handleReset}
      >
        <RotateCcw aria-hidden="true" />
        {t('raw.tone.reset')}
      </button>
    </ToolSection>
  )
}
