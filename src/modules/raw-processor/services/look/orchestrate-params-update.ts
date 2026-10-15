import type { ColorGraphIntent } from '@lumaforge/luma-color-runtime'
import {
  normalizeColorBalanceParams,
  normalizeLookIntensity,
  normalizeSaturationParams,
  normalizeToneParams,
} from '@lumaforge/luma-color-runtime'

import type { ImageSession } from '../../model/session'
import { clampCompareSplit } from '../compare/compare-split'
import {
  applyCompareSplitToSession,
  applyPreviewViewportToSession,
} from '../compare/view-session-state'
import { changesRenderGraphParams } from '../export/export-state'
import type { PreviewViewport } from '../preview/preview-viewport'
import { projectSessionLookIntensity } from './effective-color-intent'
import {
  applyLookIntensityToSession,
  clearActiveLookFromSession,
} from './look-session-state'
import { DEFAULT_LOOK_INTENSITY } from './style-system'

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
 * Sets how much of the look reaches the photo on the current session. The
 * amount is continuous (0..1) and lands in the session style exactly, so the
 * export manifest records what the preview showed. A session that owns no
 * look keeps projecting the default intensity while the caller carries the
 * amount in the detached intent. An unchanged amount returns the session
 * itself.
 */
export function computeSessionIntensityChange(
  prevSession: ImageSession,
  value: number,
): { session: ImageSession; shouldInvalidateExportGraph: boolean } {
  const intensity = normalizeLookIntensity(value, DEFAULT_LOOK_INTENSITY)
  const shouldInvalidateExportGraph =
    projectSessionLookIntensity(prevSession) !== intensity

  return {
    session: shouldInvalidateExportGraph
      ? applyLookIntensityToSession(prevSession, intensity)
      : prevSession,
    shouldInvalidateExportGraph,
  }
}

/**
 * Sets the look intensity on the detached color intent. The amount is
 * continuous (0..1); a detached look derives its amount from it, so the
 * intensity alone decides whether the graph changes. An unchanged amount
 * returns the intent itself.
 */
export function computeDetachedIntensityChange(
  prevParams: ColorGraphIntent,
  value: number,
): { params: ColorGraphIntent; shouldInvalidateExportGraph: boolean } {
  const intensity = normalizeLookIntensity(value, DEFAULT_LOOK_INTENSITY)
  const shouldInvalidateExportGraph = prevParams.intensity !== intensity

  return {
    params: shouldInvalidateExportGraph
      ? { ...prevParams, intensity }
      : prevParams,
    shouldInvalidateExportGraph,
  }
}

/**
 * Clears the look from the current session. A look, a LUT contract selection
 * or a still-loaded LUT means the graph changes; otherwise the session itself
 * is returned.
 */
export function computeSessionClearLUT(
  prevSession: ImageSession,
  hasLoadedLut: boolean,
): { session: ImageSession; shouldInvalidateExportGraph: boolean } {
  const shouldInvalidateExportGraph =
    Boolean(prevSession.activeStyle) ||
    Boolean(prevSession.lutProfileSelection) ||
    hasLoadedLut

  return {
    session: shouldInvalidateExportGraph
      ? clearActiveLookFromSession(prevSession)
      : prevSession,
    shouldInvalidateExportGraph,
  }
}

/**
 * Clears the look from the detached color intent, keeping its strength. A
 * detached style or a still-loaded LUT means the graph changes; an intent
 * that already carries no style is returned itself.
 */
export function computeDetachedClearLUT(
  prevParams: ColorGraphIntent,
  hasLoadedLut: boolean,
): { params: ColorGraphIntent; shouldInvalidateExportGraph: boolean } {
  const hasDetachedStyle =
    prevParams.styleKind !== 'none' || prevParams.builtinPreset !== null

  return {
    params: hasDetachedStyle
      ? { ...prevParams, styleKind: 'none', builtinPreset: null }
      : prevParams,
    shouldInvalidateExportGraph: hasDetachedStyle || hasLoadedLut,
  }
}

export function computeToneParams(
  prevParams: ColorGraphIntent,
  toneParams: Partial<
    Pick<
      ColorGraphIntent,
      | 'userExposureEv'
      | 'userContrast'
      | 'userHighlights'
      | 'userShadows'
      | 'userWhites'
      | 'userBlacks'
    >
  >,
): { params: ColorGraphIntent; shouldClearExportResult: boolean } {
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
  prevParams: ColorGraphIntent,
  colorParams: Partial<
    Pick<
      ColorGraphIntent,
      'userTemperature' | 'userTint' | 'userSaturation' | 'userVibrance'
    >
  >,
): { params: ColorGraphIntent; shouldClearExportResult: boolean } {
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
