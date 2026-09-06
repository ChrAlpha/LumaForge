import type { HSLBandId, HSLBandShift } from '@lumaforge/luma-color-runtime'
import { makeNeutralBand } from '@lumaforge/luma-color-runtime'
import { RotateCcw } from 'lucide-react'
import { useState } from 'react'

import { Button } from '~/components/ui/button'
import { clsxm } from '~/lib/cn'
import type { Translate } from '~/lib/i18n'
import { useI18n } from '~/lib/i18n'

import { HSL_BAND_SWATCH } from '../mobile/hsl-fields'
import { DesktopAdjustRow } from './DesktopAdjustRow'
import {
  SEGMENTED_FOCUS_RING,
  SEGMENTED_ITEM_TEXT,
  SEGMENTED_THUMB_BG,
  SEGMENTED_TRACK,
} from './segmented-chrome'
import {
  hslHueTrack,
  hslLightnessTrack,
  hslSaturationTrack,
} from './slider-tracks'

export type HSLToolValue = Readonly<Record<HSLBandId, Readonly<HSLBandShift>>>

const HSL_BAND_ORDER: readonly HSLBandId[] = [
  'red',
  'orange',
  'yellow',
  'green',
  'aqua',
  'blue',
  'purple',
  'magenta',
] as const

const HSL_AXIS_ORDER: readonly (keyof HSLBandShift)[] = [
  'hue',
  'saturation',
  'lightness',
] as const

const HSL_BAND_LABEL_KEY: Record<HSLBandId, Parameters<Translate>[0]> = {
  red: 'raw.hsl.bands.red',
  orange: 'raw.hsl.bands.orange',
  yellow: 'raw.hsl.bands.yellow',
  green: 'raw.hsl.bands.green',
  aqua: 'raw.hsl.bands.aqua',
  blue: 'raw.hsl.bands.blue',
  purple: 'raw.hsl.bands.purple',
  magenta: 'raw.hsl.bands.magenta',
}

const HSL_AXIS_LABEL_KEY: Record<keyof HSLBandShift, Parameters<Translate>[0]> =
  {
    hue: 'raw.hsl.fields.hue',
    saturation: 'raw.hsl.fields.saturation',
    lightness: 'raw.hsl.fields.lightness',
  }

const HSL_AXIS_RESET_KEY: Record<keyof HSLBandShift, Parameters<Translate>[0]> =
  {
    hue: 'raw.hsl.resetHue',
    saturation: 'raw.hsl.resetSaturation',
    lightness: 'raw.hsl.resetLightness',
  }

function trackForAxis(band: HSLBandId, axis: keyof HSLBandShift): string {
  switch (axis) {
    case 'hue':
      return hslHueTrack(band)
    case 'saturation':
      return hslSaturationTrack(band)
    case 'lightness':
      return hslLightnessTrack(band)
  }
}

function formatSignedInteger(value: number) {
  const rounded = Math.round(value)
  return rounded > 0 ? `+${rounded}` : `${rounded}`
}

function isBandAxisNeutral(
  value: HSLToolValue | undefined,
  axis: keyof HSLBandShift,
): boolean {
  if (!value) return true
  return HSL_BAND_ORDER.every((band) => value[band][axis] === 0)
}

function isAllBandsNeutral(value: HSLToolValue | undefined): boolean {
  if (!value) return true
  return HSL_BAND_ORDER.every(
    (band) =>
      value[band].hue === 0 &&
      value[band].saturation === 0 &&
      value[band].lightness === 0,
  )
}

function HSLAxisTabs({
  activeAxis,
  disabled,
  onSelect,
  axisLabels,
  labelText,
}: {
  activeAxis: keyof HSLBandShift
  disabled: boolean
  onSelect: (axis: keyof HSLBandShift) => void
  axisLabels: Record<keyof HSLBandShift, string>
  labelText: string
}) {
  return (
    <div
      role="tablist"
      aria-label={labelText}
      data-hsl-axis-tabs
      // One paint for every segmented control in the chrome. Re-stating the
      // values here is what let this group drift into a pill beside the
      // rounded-rect Strength group one card away.
      className={clsxm('grid grid-cols-3 gap-0.5', SEGMENTED_TRACK)}
    >
      {HSL_AXIS_ORDER.map((axis) => {
        const selected = activeAxis === axis
        return (
          <button
            key={axis}
            type="button"
            role="tab"
            aria-selected={selected}
            data-hsl-axis-tab={axis}
            data-active={selected ? '' : undefined}
            disabled={disabled}
            onClick={() => onSelect(axis)}
            className={clsxm(
              'relative flex h-7 items-center justify-center rounded-md text-[0.78rem] tracking-wide',
              SEGMENTED_ITEM_TEXT,
              SEGMENTED_FOCUS_RING,
              'disabled:cursor-not-allowed disabled:opacity-60',
              selected && `font-semibold ${SEGMENTED_THUMB_BG}`,
            )}
          >
            {axisLabels[axis]}
          </button>
        )
      })}
    </div>
  )
}

function HSLAxisSliderRow({
  band,
  bandLabel,
  axis,
  axisLabel,
  value,
  disabled,
  onChange,
}: {
  band: HSLBandId
  bandLabel: string
  axis: keyof HSLBandShift
  axisLabel: string
  value: number
  disabled: boolean
  onChange: (next: number) => void
}) {
  return (
    <DesktopAdjustRow
      label={bandLabel}
      labelPrefix={axisLabel}
      value={value}
      min={-100}
      max={100}
      step={1}
      disabled={disabled}
      track={trackForAxis(band, axis)}
      formatValue={formatSignedInteger}
      onChange={onChange}
      sliderLabel={axisLabel}
      asGroup
      rowProps={{ 'data-hsl-band': band, 'data-hsl-axis': axis }}
      leading={
        <span
          aria-hidden="true"
          data-hsl-band-swatch={band}
          className="size-2.5 shrink-0 rounded-full ring-1 ring-[oklch(from_var(--color-lf-on-surface)_l_c_h_/_0.18)]"
          style={{ backgroundColor: HSL_BAND_SWATCH[band] }}
        />
      }
    />
  )
}

export function HSLTool({
  value,
  disabled,
  onChange,
  onReset,
}: {
  value: HSLToolValue | undefined
  disabled: boolean
  onChange: (band: HSLBandId, shift: Partial<HSLBandShift>) => void
  onReset: () => void
}) {
  const { t } = useI18n()
  const [activeAxis, setActiveAxis] = useState<keyof HSLBandShift>('hue')

  const axisLabels: Record<keyof HSLBandShift, string> = {
    hue: t(HSL_AXIS_LABEL_KEY.hue),
    saturation: t(HSL_AXIS_LABEL_KEY.saturation),
    lightness: t(HSL_AXIS_LABEL_KEY.lightness),
  }

  const isAxisNeutral = isBandAxisNeutral(value, activeAxis)
  const isAllNeutral = isAllBandsNeutral(value)

  function resetActiveAxis() {
    // React batches setState in this event handler so all 8 calls collapse
    // into one render with the cumulative selectiveColor update.
    for (const band of HSL_BAND_ORDER) {
      onChange(band, { [activeAxis]: 0 })
    }
  }

  return (
    <div className="grid gap-3">
      <HSLAxisTabs
        activeAxis={activeAxis}
        disabled={disabled}
        onSelect={setActiveAxis}
        axisLabels={axisLabels}
        labelText={t('raw.hsl.axisTabsLabel')}
      />
      <div
        role="tabpanel"
        data-hsl-axis-panel={activeAxis}
        aria-label={axisLabels[activeAxis]}
        className="grid gap-1.5"
      >
        {HSL_BAND_ORDER.map((band) => {
          const bandValue = value?.[band] ?? makeNeutralBand()
          return (
            <HSLAxisSliderRow
              key={band}
              band={band}
              bandLabel={t(HSL_BAND_LABEL_KEY[band])}
              axis={activeAxis}
              axisLabel={axisLabels[activeAxis]}
              value={bandValue[activeAxis]}
              disabled={disabled}
              onChange={(next) => onChange(band, { [activeAxis]: next })}
            />
          )
        })}
      </div>
      <p className="text-[0.78rem] leading-relaxed text-lf-on-surface/72">
        {t('raw.hsl.note')}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="light"
          size="sm"
          disabled={disabled || isAxisNeutral}
          onClick={resetActiveAxis}
          className="[&_svg]:size-3.5"
        >
          <RotateCcw aria-hidden="true" />
          {t(HSL_AXIS_RESET_KEY[activeAxis])}
        </Button>
        <Button
          variant="secondary"
          size="sm"
          disabled={disabled || isAllNeutral}
          onClick={onReset}
          className="[&_svg]:size-3.5"
        >
          {t('raw.hsl.reset')}
        </Button>
      </div>
    </div>
  )
}
