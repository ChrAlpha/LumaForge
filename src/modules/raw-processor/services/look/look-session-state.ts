import type { ParsedLUT } from '@lumaforge/luma-color-runtime'
import { normalizeLookIntensity } from '@lumaforge/luma-color-runtime'

import type {
  ImageSession,
  LUTContractSelectionState,
  StyleAsset,
} from '../../model/session'
import { clearExportResultState } from '../export/export-state'
import { DEFAULT_LOOK_INTENSITY, toCustomStyle } from './style-system'

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
    currentIntensity: normalizeLookIntensity(intensity, DEFAULT_LOOK_INTENSITY),
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
  },
): ImageSession {
  return clearExportResultState({
    ...session,
    activeStyle: input.style,
    lutProfileSelection: input.lutProfileSelection,
  })
}

export function applyLookIntensityToSession(
  session: ImageSession,
  intensity: number,
): ImageSession {
  return clearExportResultState(
    session.activeStyle
      ? {
          ...session,
          activeStyle: {
            ...session.activeStyle,
            currentIntensity: normalizeLookIntensity(
              intensity,
              DEFAULT_LOOK_INTENSITY,
            ),
          },
        }
      : session,
  )
}

export function clearActiveLookFromSession(
  session: ImageSession,
): ImageSession {
  return applyActiveLookToSession(session, {
    style: null,
    lutProfileSelection: undefined,
  })
}
