import type { ProcessingParams } from '@lumaforge/luma-color-runtime'
import {
  normalizeColorBalanceParams,
  normalizeSaturationParams,
  normalizeToneParams,
} from '@lumaforge/luma-color-runtime'

import type { ImageSession } from '../../model/session'
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
import { clampLookIntensity, DEFAULT_LOOK_INTENSITY } from './style-system'

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
 * Look intensity an existing session projects into processing params. A
 * session that owns no look projects the default intensity, whatever the
 * detached params still hold.
 */
export function projectSessionLookIntensity(session: ImageSession): number {
  return session.activeStyle
    ? session.activeStyle.currentIntensity
    : DEFAULT_LOOK_INTENSITY
}

/**
 * Sets how much of the look reaches the photo on the current session. The
 * amount is continuous (0..1) and lands in the session style exactly, so the
 * export manifest records what the preview showed. A session that owns no
 * look keeps projecting the default intensity while the caller carries the
 * amount in detached params. An unchanged amount returns the session itself.
 */
export function computeSessionIntensityChange(
  prevSession: ImageSession,
  value: number,
): { session: ImageSession; shouldInvalidateExportGraph: boolean } {
  const intensity = clampLookIntensity(value)
  const shouldInvalidateExportGraph =
    projectSessionLookIntensity(prevSession) !== intensity

  return {
    session: shouldInvalidateExportGraph
      ? applyLookIntensityToSession(prevSession, {
          intensity,
          clearExportResult: true,
        })
      : prevSession,
    shouldInvalidateExportGraph,
  }
}

/**
 * Sets the look intensity on the detached params. A detached look derives its
 * amount from this intensity, so the intensity alone decides whether the
 * graph changes. An unchanged amount returns the params themselves.
 */
export function computeDetachedIntensityChange(
  prevParams: ProcessingParams,
  value: number,
): { params: ProcessingParams; shouldInvalidateExportGraph: boolean } {
  const intensity = clampLookIntensity(value)
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
      ? clearActiveLookFromSession(prevSession, { clearExportResult: true })
      : prevSession,
    shouldInvalidateExportGraph,
  }
}

/**
 * Clears the look from the detached params. A detached style or a
 * still-loaded LUT means the graph changes; params that already carry no
 * style are returned themselves.
 */
export function computeDetachedClearLUT(
  prevParams: ProcessingParams,
  hasLoadedLut: boolean,
): { params: ProcessingParams; shouldInvalidateExportGraph: boolean } {
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
