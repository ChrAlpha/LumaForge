import { RotateCcw } from 'lucide-react'
import { useId } from 'react'

import { Button } from '~/components/ui/button'
import { Checkbox } from '~/components/ui/checkbox'
import { Slider } from '~/components/ui/slider'
import { clsxm } from '~/lib/cn'
import type { MessageKey } from '~/lib/i18n'
import { useI18n } from '~/lib/i18n'
import {
  SEGMENTED_FOCUS_RING,
  SEGMENTED_ITEM_TEXT,
  SEGMENTED_THUMB_BG,
  SEGMENTED_TRACK,
} from '~/modules/raw-processor/components/tools/segmented-chrome'

import type { UprightMode } from './geometry/types'
import type { ManualTransform } from './transform-types'

const MODES: UprightMode[] = ['off', 'auto', 'level', 'vertical', 'full']
const SLIDERS: Array<{
  key: keyof ManualTransform
  label: MessageKey
  min: number
  max: number
  step: number
}> = [
  { key: 'vertical', label: 'transform.vertical', min: -60, max: 60, step: 1 },
  {
    key: 'horizontal',
    label: 'transform.horizontal',
    min: -60,
    max: 60,
    step: 1,
  },
  { key: 'rotate', label: 'transform.rotate', min: -30, max: 30, step: 0.1 },
  { key: 'aspect', label: 'transform.aspect', min: -50, max: 50, step: 1 },
  { key: 'scale', label: 'transform.scale', min: 50, max: 150, step: 1 },
  { key: 'offsetX', label: 'transform.offsetX', min: -30, max: 30, step: 1 },
  { key: 'offsetY', label: 'transform.offsetY', min: -30, max: 30, step: 1 },
]

export function TransformControls({
  mode,
  onModeChange,
  manual,
  onManualChange,
  constrainCrop,
  onCropChange,
  onReset,
  disabled,
  embedded = false,
}: {
  mode: UprightMode
  onModeChange: (mode: UprightMode) => void
  manual: ManualTransform
  onManualChange: (manual: ManualTransform) => void
  constrainCrop: boolean
  onCropChange: (value: boolean) => void
  onReset: () => void
  disabled: boolean
  embedded?: boolean
}) {
  const { t } = useI18n()
  const id = useId()
  return (
    <>
      {!embedded && (
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-base font-semibold">{t('transform.controls')}</h2>
          <Button
            variant="ghost"
            className="h-11 px-2"
            onClick={onReset}
            disabled={disabled}
          >
            <RotateCcw size={14} aria-hidden />
            {t('transform.reset')}
          </Button>
        </div>
      )}
      <div
        role="group"
        aria-label={t('transform.modes')}
        className={clsxm(
          'grid grid-cols-3 gap-1',
          embedded ? SEGMENTED_TRACK : 'mt-3 gap-2',
        )}
      >
        {MODES.map((value) => (
          <Button
            key={value}
            data-testid={`mode-${value}`}
            variant={mode === value ? 'secondary' : 'ghost'}
            aria-pressed={mode === value}
            onClick={() => onModeChange(value)}
            disabled={disabled}
            className={clsxm(
              'h-11 text-sm',
              !embedded && 'border',
              value === 'auto' && 'col-span-2',
              embedded
                ? [
                    SEGMENTED_ITEM_TEXT,
                    SEGMENTED_FOCUS_RING,
                    mode === value &&
                      `${SEGMENTED_THUMB_BG} font-semibold text-lf-on-photo-ink`,
                  ]
                : mode === value
                  ? 'border-lf-on-surface/30 bg-lf-surface-muted text-lf-on-surface'
                  : 'border-lf-on-surface/10',
            )}
          >
            {t(`transform.mode.${value}`)}
          </Button>
        ))}
      </div>
      <p className="mt-3 min-h-12 text-xs leading-relaxed text-lf-on-surface/70">
        {t(`transform.modeHelp.${mode}`)}
      </p>
      <div className="mt-4 border-t border-lf-on-surface/10 pt-2">
        {SLIDERS.map(({ key, label, min, max, step }) => (
          <div
            key={key}
            className="grid min-h-14 grid-cols-[5.5rem_1fr_2.75rem] items-center gap-3"
          >
            <span id={`${id}-${key}`} className="text-xs text-lf-on-surface/80">
              {t(label)}
            </span>
            <Slider
              min={min}
              max={max}
              step={step}
              value={[manual[key]]}
              onValueChange={([value]) =>
                onManualChange({ ...manual, [key]: value })
              }
              disabled={disabled}
              thumbAriaLabelledBy={`${id}-${key}`}
              bipolar={min < 0}
            />
            <output className="text-right text-xs tabular-nums text-lf-on-surface/90">
              {manual[key].toFixed(step < 1 ? 1 : 0)}
            </output>
          </div>
        ))}
      </div>
      <label className="mt-3 flex min-h-11 cursor-pointer items-center gap-3 border-t border-lf-on-surface/10 pt-3 text-sm">
        <Checkbox
          checked={constrainCrop}
          onCheckedChange={(value) => onCropChange(value === true)}
          disabled={disabled}
          className="border border-lf-on-surface/30 bg-lf-surface-muted data-[state=checked]:bg-lf-green data-[state=checked]:text-lf-on-surface"
        />
        {t('transform.crop')}
      </label>
    </>
  )
}
