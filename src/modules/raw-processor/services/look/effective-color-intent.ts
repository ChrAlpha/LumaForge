import type { ColorGraphIntent } from '@lumaforge/luma-color-runtime'

import type { ImageSession } from '../../model/session'
import { DEFAULT_LOOK_INTENSITY } from './style-system'

/**
 * Look intensity an existing session projects into the color intent. A
 * session that owns no look projects the default intensity, whatever the
 * detached intent still holds.
 */
export function projectSessionLookIntensity(session: ImageSession): number {
  return session.activeStyle
    ? session.activeStyle.currentIntensity
    : DEFAULT_LOOK_INTENSITY
}

/**
 * The color intent the photo renders and exports with: the stored intent,
 * with the look of the current session projected over it.
 *
 * Without a session the stored intent is the effective one. A session that
 * owns no look projects no look at the default strength. A custom session
 * look projects the custom style at its continuous strength, zero included,
 * so a zero-strength look keeps the LUT and its contract checks. A built-in
 * session look keeps the preset the stored intent selects. When the
 * projection changes nothing, the stored intent itself is returned.
 */
export function projectEffectiveColorIntent(
  storedIntent: ColorGraphIntent,
  session: ImageSession | null,
): ColorGraphIntent {
  if (!session) return storedIntent

  const intensity = projectSessionLookIntensity(session)
  const stylePatch = !session.activeStyle
    ? { styleKind: 'none' as const, builtinPreset: null }
    : session.activeStyle.kind === 'custom'
      ? { styleKind: 'custom' as const, builtinPreset: null }
      : {}
  const nextIntent: ColorGraphIntent = {
    ...storedIntent,
    ...stylePatch,
    intensity,
  }

  return storedIntent.intensity === nextIntent.intensity &&
    storedIntent.styleKind === nextIntent.styleKind &&
    storedIntent.builtinPreset === nextIntent.builtinPreset
    ? storedIntent
    : nextIntent
}
