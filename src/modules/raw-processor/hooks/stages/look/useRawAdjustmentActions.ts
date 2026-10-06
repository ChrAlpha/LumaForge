import type {
  ColorGraphIntent,
  ColorGraphIntentSource,
  HSLBandId,
  HSLBandShift,
  ProcessingParams,
} from '@lumaforge/luma-color-runtime'
import {
  COLOR_GRAPH_INTENT_KEYS,
  makeNeutralBand,
} from '@lumaforge/luma-color-runtime'
import { useCallback } from 'react'

import { changesRenderGraphParams } from '../../../services/export/export-state'
import {
  computeColorParams,
  computeToneParams,
} from '../../../services/look/orchestrate-params-update'

function makeNeutralSelectiveColor(): Record<HSLBandId, HSLBandShift> {
  return {
    red: makeNeutralBand(),
    orange: makeNeutralBand(),
    yellow: makeNeutralBand(),
    green: makeNeutralBand(),
    aqua: makeNeutralBand(),
    blue: makeNeutralBand(),
    purple: makeNeutralBand(),
    magenta: makeNeutralBand(),
  }
}

export type SetColorIntent = (
  value: ColorGraphIntent | ((prev: ColorGraphIntent) => ColorGraphIntent),
) => void

/**
 * The color fields a patch carries, and only those. Fields are kept when the
 * patch owns them, so an explicit undefined still counts as written.
 */
function pickColorIntentPatch(
  patch: Partial<ColorGraphIntent>,
): Partial<ColorGraphIntent> {
  const colorPatch: Record<string, unknown> = {}
  for (const key of COLOR_GRAPH_INTENT_KEYS) {
    if (Object.hasOwn(patch, key)) {
      colorPatch[key] = patch[key]
    }
  }
  return colorPatch as Partial<ColorGraphIntent>
}

type UseRawAdjustmentActionsInput = {
  /** The color the photo renders with now; decides whether a patch changes the graph. */
  params: ColorGraphIntentSource
  setColorIntent: SetColorIntent
  invalidateExportGraph: () => void
}

export function useRawAdjustmentActions({
  params,
  setColorIntent,
  invalidateExportGraph,
}: UseRawAdjustmentActionsInput) {
  // A color patch writes color only. View mode and compare split have their
  // own setters on the view owner, so a view field in the record is dropped.
  const setProcessingParams = useCallback(
    (newParams: Partial<ColorGraphIntent>) => {
      const colorPatch = pickColorIntentPatch(newParams)
      if (Object.keys(colorPatch).length === 0) {
        return
      }

      const shouldClearExportResult = changesRenderGraphParams(
        params,
        colorPatch,
      )
      setColorIntent((prev) => ({ ...prev, ...colorPatch }))
      if (shouldClearExportResult) {
        invalidateExportGraph()
      }
    },
    [invalidateExportGraph, params, setColorIntent],
  )

  const setToneParams = useCallback(
    (
      toneParams: Partial<
        Pick<
          ProcessingParams,
          | 'userExposureEv'
          | 'userContrast'
          | 'userHighlights'
          | 'userShadows'
          | 'userWhites'
          | 'userBlacks'
        >
      >,
    ) => {
      let shouldClearExportResult = false
      setColorIntent((prev) => {
        const { params: nextParams, shouldClearExportResult: shouldClear } =
          computeToneParams(prev, toneParams)
        shouldClearExportResult = shouldClear
        return nextParams
      })

      if (shouldClearExportResult) {
        invalidateExportGraph()
      }
    },
    [invalidateExportGraph, setColorIntent],
  )

  const resetTone = useCallback(() => {
    setProcessingParams({
      userExposureEv: 0,
      userContrast: 0,
      userHighlights: 0,
      userShadows: 0,
      userWhites: 0,
      userBlacks: 0,
    })
  }, [setProcessingParams])

  const setColorParams = useCallback(
    (
      colorParams: Partial<
        Pick<
          ProcessingParams,
          'userTemperature' | 'userTint' | 'userSaturation' | 'userVibrance'
        >
      >,
    ) => {
      let shouldClearExportResult = false
      setColorIntent((prev) => {
        const { params: nextParams, shouldClearExportResult: shouldClear } =
          computeColorParams(prev, colorParams)
        shouldClearExportResult = shouldClear
        return nextParams
      })

      if (shouldClearExportResult) {
        invalidateExportGraph()
      }
    },
    [invalidateExportGraph, setColorIntent],
  )

  const resetColor = useCallback(() => {
    setProcessingParams({
      userTemperature: 0,
      userTint: 0,
      userSaturation: 0,
      userVibrance: 0,
    })
  }, [setProcessingParams])

  const setSelectiveColorBand = useCallback(
    (band: HSLBandId, shift: Partial<HSLBandShift>) => {
      let shouldClearExportResult = false
      setColorIntent((prev) => {
        const baseRecord = prev.selectiveColor
        const previousBand = baseRecord[band] ?? makeNeutralBand()
        const nextBand: HSLBandShift = {
          hue: shift.hue ?? previousBand.hue,
          saturation: shift.saturation ?? previousBand.saturation,
          lightness: shift.lightness ?? previousBand.lightness,
        }
        const nextSelectiveColor: Record<HSLBandId, HSLBandShift> = {
          red: baseRecord.red ?? makeNeutralBand(),
          orange: baseRecord.orange ?? makeNeutralBand(),
          yellow: baseRecord.yellow ?? makeNeutralBand(),
          green: baseRecord.green ?? makeNeutralBand(),
          aqua: baseRecord.aqua ?? makeNeutralBand(),
          blue: baseRecord.blue ?? makeNeutralBand(),
          purple: baseRecord.purple ?? makeNeutralBand(),
          magenta: baseRecord.magenta ?? makeNeutralBand(),
        }
        nextSelectiveColor[band] = nextBand
        shouldClearExportResult = changesRenderGraphParams(prev, {
          selectiveColor: nextSelectiveColor,
        })
        return { ...prev, selectiveColor: nextSelectiveColor }
      })

      if (shouldClearExportResult) {
        invalidateExportGraph()
      }
    },
    [invalidateExportGraph, setColorIntent],
  )

  const resetSelectiveColor = useCallback(() => {
    let shouldClearExportResult = false
    setColorIntent((prev) => {
      const nextSelectiveColor = makeNeutralSelectiveColor()
      shouldClearExportResult = changesRenderGraphParams(prev, {
        selectiveColor: nextSelectiveColor,
      })
      return { ...prev, selectiveColor: nextSelectiveColor }
    })

    if (shouldClearExportResult) {
      invalidateExportGraph()
    }
  }, [invalidateExportGraph, setColorIntent])

  return {
    setParams: setProcessingParams,
    setToneParams,
    resetTone,
    setColorParams,
    resetColor,
    setSelectiveColorBand,
    resetSelectiveColor,
  }
}
