import type { ParsedLUT } from '~/lib/lut/cube-parser'

import type {
  ImageSession,
  LUTContractSelectionState,
  StyleAsset,
} from '../../model/session'
import { clearExportResultState } from '../export/export-state'
import { clampLookIntensity, toCustomStyle } from './style-system'

/**
 * Resolve the detached (pre-session) look from the standalone LUT atom.
 * The canonical detached intensity lives in processing params, so the
 * synthesized style carries the user's current amount instead of a default.
 */
export function resolveDetachedLookStyle(
  lut: ParsedLUT | null,
  intensity: number,
): StyleAsset | null {
  if (!lut) {
    return null
  }

  return {
    ...toCustomStyle(lut),
    currentIntensity: clampLookIntensity(intensity),
  }
}

/**
 * Single source of truth for the active look: the session owns it once one
 * exists; before that, the detached LUT (if any) defines it. Every consumer
 * of "what look is active right now" must resolve through here so the
 * LUT-before-RAW and RAW-before-LUT orderings cannot diverge.
 */
export function resolveActiveLook(input: {
  session: ImageSession | null
  lut: ParsedLUT | null
  intensity: number
}): StyleAsset | null {
  if (input.session) {
    return input.session.activeStyle
  }

  return resolveDetachedLookStyle(input.lut, input.intensity)
}

export function preserveCustomLookIntensity(
  style: StyleAsset,
  activeStyle: StyleAsset | null | undefined,
): StyleAsset {
  if (activeStyle?.kind !== 'custom') {
    return style
  }

  return {
    ...style,
    currentIntensity: activeStyle.currentIntensity,
  }
}

export function applyActiveLookToSession(
  session: ImageSession,
  input: {
    style: StyleAsset | null
    lutProfileSelection?: LUTContractSelectionState
    clearExportResult: boolean
  },
): ImageSession {
  const nextSession = {
    ...session,
    activeStyle: input.style,
    lutProfileSelection: input.lutProfileSelection,
  }

  return input.clearExportResult
    ? clearExportResultState(nextSession)
    : nextSession
}

export function applyLookIntensityToSession(
  session: ImageSession,
  input: {
    intensity: number
    clearExportResult: boolean
  },
): ImageSession {
  if (!session.activeStyle) {
    return input.clearExportResult ? clearExportResultState(session) : session
  }

  const nextSession = {
    ...session,
    activeStyle: {
      ...session.activeStyle,
      currentIntensity: clampLookIntensity(input.intensity),
    },
  }

  return input.clearExportResult
    ? clearExportResultState(nextSession)
    : nextSession
}

export function clearActiveLookFromSession(
  session: ImageSession,
  input: {
    clearExportResult: boolean
  },
): ImageSession {
  return applyActiveLookToSession(session, {
    style: null,
    lutProfileSelection: undefined,
    clearExportResult: input.clearExportResult,
  })
}
