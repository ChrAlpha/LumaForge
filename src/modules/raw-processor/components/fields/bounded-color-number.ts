import type { UserColorScalarKey } from '@lumaforge/luma-color-runtime'
import { USER_COLOR_FIELD_BOUNDS } from '@lumaforge/luma-color-runtime'
import { z } from 'zod'

/** A number inside the color runtime's clamp for the user field `key`. */
export function boundedColorNumber(key: UserColorScalarKey) {
  const { min, max } = USER_COLOR_FIELD_BOUNDS[key]
  return z.number().min(min).max(max)
}
