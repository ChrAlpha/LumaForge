import type {
  ColorGraphIntent,
  HSLBandId,
  HSLBandShift,
} from '@lumaforge/luma-color-runtime'
import { NEUTRAL_SELECTIVE_COLOR } from '@lumaforge/luma-color-runtime'
import { useCallback } from 'react'

import type { ColorValue } from '../../../components/color-fields'
import type { ToneValue } from '../../../components/tone-fields'
import { changesRenderGraphParams } from '../../../services/export/export-state'
import {
  computeColorParams,
  computeToneParams,
} from '../../../services/look/orchestrate-params-update'
import { rawWorkflowStore } from '../../../state/workflow.atoms'

const NEUTRAL_TONE: ToneValue = {
  userExposureEv: 0,
  userContrast: 0,
  userHighlights: 0,
  userShadows: 0,
  userWhites: 0,
  userBlacks: 0,
}

const NEUTRAL_COLOR: ColorValue = {
  userTemperature: 0,
  userTint: 0,
  userSaturation: 0,
  userVibrance: 0,
}

export function useRawAdjustmentActions(invalidateExportGraph: () => void) {
  // Each edit is decided against the stored intent when it lands, and the
  // export graph is invalidated only once the write has returned.
  const update = useCallback(
    (
      change: (prev: ColorGraphIntent) => {
        params: ColorGraphIntent
        shouldClearExportResult: boolean
      },
    ) => {
      let shouldClearExportResult = false
      rawWorkflowStore.setColorIntent((prev) => {
        const next = change(prev)
        shouldClearExportResult = next.shouldClearExportResult
        return next.params
      })
      if (shouldClearExportResult) invalidateExportGraph()
    },
    [invalidateExportGraph],
  )

  const setToneParams = useCallback(
    (toneParams: Partial<ToneValue>) =>
      update((prev) => computeToneParams(prev, toneParams)),
    [update],
  )
  const resetTone = useCallback(
    () => setToneParams(NEUTRAL_TONE),
    [setToneParams],
  )

  const setColorParams = useCallback(
    (colorParams: Partial<ColorValue>) =>
      update((prev) => computeColorParams(prev, colorParams)),
    [update],
  )
  const resetColor = useCallback(
    () => setColorParams(NEUTRAL_COLOR),
    [setColorParams],
  )

  const setSelectiveColor = useCallback(
    (
      next: (
        prev: ColorGraphIntent['selectiveColor'],
      ) => ColorGraphIntent['selectiveColor'],
    ) =>
      update((prev) => {
        const selectiveColor = next(prev.selectiveColor)
        return {
          params: { ...prev, selectiveColor },
          shouldClearExportResult: changesRenderGraphParams(prev, {
            selectiveColor,
          }),
        }
      }),
    [update],
  )

  const setSelectiveColorBand = useCallback(
    (band: HSLBandId, shift: Partial<HSLBandShift>) =>
      setSelectiveColor((prev) => ({
        ...prev,
        [band]: {
          hue: shift.hue ?? prev[band].hue,
          saturation: shift.saturation ?? prev[band].saturation,
          lightness: shift.lightness ?? prev[band].lightness,
        },
      })),
    [setSelectiveColor],
  )
  const resetSelectiveColor = useCallback(
    () => setSelectiveColor(() => NEUTRAL_SELECTIVE_COLOR),
    [setSelectiveColor],
  )

  return {
    setToneParams,
    resetTone,
    setColorParams,
    resetColor,
    setSelectiveColorBand,
    resetSelectiveColor,
  }
}
