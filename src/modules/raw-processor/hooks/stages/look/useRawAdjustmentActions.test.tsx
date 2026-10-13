import type { ColorGraphIntent } from '@lumaforge/luma-color-runtime'
import {
  NEUTRAL_SELECTIVE_COLOR,
  NEUTRAL_USER_COLOR_INTENT,
} from '@lumaforge/luma-color-runtime'
import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import {
  getProcessingParams,
  setProcessingParams,
} from '../../../state/workflow.atoms'
import { useRawAdjustmentActions } from './useRawAdjustmentActions'

const baseParams: ColorGraphIntent = {
  ...NEUTRAL_USER_COLOR_INTENT,
  intensity: 0.7,
  styleKind: 'none',
  builtinPreset: null,
}

const SHIFTED_BANDS: ColorGraphIntent['selectiveColor'] = {
  red: { hue: 10, saturation: 25, lightness: -12 },
  orange: { hue: 1, saturation: 2, lightness: 3 },
  yellow: { hue: 4, saturation: 5, lightness: 6 },
  green: { hue: 7, saturation: 8, lightness: 9 },
  aqua: { hue: 10, saturation: 11, lightness: 12 },
  blue: { hue: 13, saturation: 14, lightness: 15 },
  purple: { hue: 16, saturation: 17, lightness: 18 },
  magenta: { hue: 19, saturation: 20, lightness: 21 },
}

/** The actions over the stored intent `initial`, rendered once. */
function renderActions(initial: ColorGraphIntent) {
  setProcessingParams(initial)
  const invalidateExportGraph = vi.fn()
  const { result } = renderHook(() =>
    useRawAdjustmentActions(invalidateExportGraph),
  )
  return { actions: result.current, invalidateExportGraph }
}

describe('useRawAdjustmentActions', () => {
  it('composes tone, color and HSL edits issued before a rerender', () => {
    const { actions, invalidateExportGraph } = renderActions(baseParams)

    act(() => {
      actions.setToneParams({ userContrast: 140 })
      actions.setToneParams({ userShadows: 15 })
      actions.setColorParams({ userTemperature: 30 })
      actions.setSelectiveColorBand('red', { hue: 12 })
    })

    expect(getProcessingParams()).toMatchObject({
      userContrast: 100,
      userShadows: 15,
      userTemperature: 30,
      intensity: 0.7,
    })
    expect(getProcessingParams().selectiveColor.red).toEqual({
      hue: 12,
      saturation: 0,
      lightness: 0,
    })
    expect(invalidateExportGraph).toHaveBeenCalledTimes(4)
  })

  it('moves only the named fields of one band', () => {
    const { actions } = renderActions({
      ...baseParams,
      selectiveColor: SHIFTED_BANDS,
    })

    act(() => actions.setSelectiveColorBand('red', { hue: 50 }))

    expect(getProcessingParams().selectiveColor).toEqual({
      ...SHIFTED_BANDS,
      red: { hue: 50, saturation: 25, lightness: -12 },
    })
  })

  it('resets HSL without touching tone or color, and tone or color without touching HSL', () => {
    const adjusted: ColorGraphIntent = {
      ...baseParams,
      userExposureEv: 1.5,
      userContrast: -20,
      userTemperature: 12,
      userTint: -8,
      selectiveColor: SHIFTED_BANDS,
    }
    let { actions } = renderActions(adjusted)
    act(() => actions.resetSelectiveColor())
    expect(getProcessingParams()).toEqual({
      ...adjusted,
      selectiveColor: NEUTRAL_SELECTIVE_COLOR,
    })
    ;({ actions } = renderActions(adjusted))
    act(() => {
      actions.resetTone()
      actions.resetColor()
    })
    expect(getProcessingParams()).toEqual({
      ...baseParams,
      selectiveColor: SHIFTED_BANDS,
    })
  })

  it('does not invalidate the export graph when HSL is already neutral', () => {
    const { actions, invalidateExportGraph } = renderActions(baseParams)

    act(() => actions.resetSelectiveColor())

    expect(invalidateExportGraph).not.toHaveBeenCalled()
  })
})
