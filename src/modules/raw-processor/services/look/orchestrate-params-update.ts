import type { ProcessingParams } from '@lumaforge/luma-color-runtime'
import {
  normalizeColorBalanceParams,
  normalizeSaturationParams,
  normalizeToneParams,
} from '@lumaforge/luma-color-runtime'

import type { ImageSession, StyleAsset } from '../../model/session'
import { clampCompareSplit } from '../compare/compare-split'
import {
  applyCompareSplitToSession,
  applyPreviewViewportToSession,
  applyViewModeToSession,
} from '../compare/view-session-state'
import { changesRenderGraphParams } from '../export/export-state'
import type { PreviewViewport } from '../preview/preview-viewport'
import {
  applyLookIntensityToSession,
  clearActiveLookFromSession,
} from './look-session-state'
import { clampLookIntensity } from './style-system'

export function computeViewModeChange(
  session: ImageSession | null,
  mode: ProcessingParams['viewMode'],
): ImageSession | null {
  if (!session) {
    return null
  }

  return applyViewModeToSession(session, mode)
}

export function computeCompareSplitChange(
  session: ImageSession | null,
  split: number,
): { session: ImageSession | null; nextSplit: number } {
  const nextSplit = clampCompareSplit(split)
  const nextSession = session
    ? applyCompareSplitToSession(session, nextSplit)
    : null

  return { session: nextSession, nextSplit }
}

export function computeViewportChange(
  session: ImageSession | null,
  viewport: PreviewViewport,
): ImageSession | null {
  if (!session) {
    return null
  }

  return applyPreviewViewportToSession(session, viewport)
}

/**
 * Set how much of the look reaches the photo. The amount is continuous
 * (0..1) and lands in params and the session style exactly, so the export
 * manifest records what the preview showed.
 */
export function computeIntensityChange(
  prevParams: ProcessingParams,
  prevSession: ImageSession | null,
  activeStyle: StyleAsset | null,
  value: number,
): {
  params: ProcessingParams
  session: ImageSession | null
  shouldInvalidateExportGraph: boolean
} {
  const intensity = clampLookIntensity(value)
  const shouldInvalidateExportGraph =
    prevParams.intensity !== intensity ||
    (activeStyle ? activeStyle.currentIntensity !== intensity : false)

  const nextParams: ProcessingParams = {
    ...prevParams,
    intensity,
  }

  const nextSession = prevSession
    ? applyLookIntensityToSession(prevSession, {
        intensity,
        clearExportResult: shouldInvalidateExportGraph,
      })
    : null

  return {
    params: nextParams,
    session: nextSession,
    shouldInvalidateExportGraph,
  }
}

export function computeClearLUT(
  prevParams: ProcessingParams,
  prevSession: ImageSession | null,
  activeStyle: StyleAsset | null,
  hasLut: boolean,
  hasLutDataRef: boolean,
  hasLutProfileSelection: boolean,
): {
  params: ProcessingParams
  session: ImageSession | null
  shouldInvalidateExportGraph: boolean
} {
  const shouldInvalidateExportGraph =
    prevParams.styleKind !== 'none' ||
    prevParams.builtinPreset !== null ||
    Boolean(activeStyle) ||
    hasLut ||
    hasLutDataRef ||
    hasLutProfileSelection

  const nextParams: ProcessingParams = {
    ...prevParams,
    styleKind: 'none',
    builtinPreset: null,
  }

  const nextSession = prevSession
    ? clearActiveLookFromSession(prevSession, {
        clearExportResult: shouldInvalidateExportGraph,
      })
    : null

  return {
    params: nextParams,
    session: nextSession,
    shouldInvalidateExportGraph,
  }
}

export function computeToneParams(
  prevParams: ProcessingParams,
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
): { params: ProcessingParams; shouldClearExportResult: boolean } {
  const normalized = normalizeToneParams({
    userExposureEv: toneParams.userExposureEv ?? prevParams.userExposureEv,
    userContrast: toneParams.userContrast ?? prevParams.userContrast,
    userHighlights: toneParams.userHighlights ?? prevParams.userHighlights,
    userShadows: toneParams.userShadows ?? prevParams.userShadows,
    userWhites: toneParams.userWhites ?? prevParams.userWhites,
    userBlacks: toneParams.userBlacks ?? prevParams.userBlacks,
  })

  const shouldClearExportResult = changesRenderGraphParams(
    prevParams,
    normalized,
  )

  return {
    params: { ...prevParams, ...normalized },
    shouldClearExportResult,
  }
}

export function computeColorParams(
  prevParams: ProcessingParams,
  colorParams: Partial<
    Pick<
      ProcessingParams,
      'userTemperature' | 'userTint' | 'userSaturation' | 'userVibrance'
    >
  >,
): { params: ProcessingParams; shouldClearExportResult: boolean } {
  const normalizedBalance = normalizeColorBalanceParams({
    userTemperature: colorParams.userTemperature ?? prevParams.userTemperature,
    userTint: colorParams.userTint ?? prevParams.userTint,
  })
  const normalizedSat = normalizeSaturationParams({
    userSaturation: colorParams.userSaturation ?? prevParams.userSaturation,
    userVibrance: colorParams.userVibrance ?? prevParams.userVibrance,
  })

  const merged = { ...normalizedBalance, ...normalizedSat }
  const shouldClearExportResult = changesRenderGraphParams(prevParams, merged)

  return {
    params: { ...prevParams, ...merged },
    shouldClearExportResult,
  }
}
