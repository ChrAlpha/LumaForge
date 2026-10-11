/**
 * App-layer .cube LUT parser.
 *
 * Delegates to the package-level parser in @lumaforge/luma-color-runtime,
 * injecting localStorage-based profile persistence for the browser app.
 */

import type { ParsedLUT } from '@lumaforge/luma-color-runtime'
import { parseCubeLUT as parseCubeLUTCore } from '@lumaforge/luma-color-runtime'

import { getStoredLUTProfileSelection } from './profile-resolution'

export type { ParsedLUT } from '@lumaforge/luma-color-runtime'
export { toLUTData, validateLUT } from '@lumaforge/luma-color-runtime'

interface ParseCubeOptions {
  sourceName?: string
}

export function parseCubeLUT(
  content: string,
  options: ParseCubeOptions = {},
): ParsedLUT {
  return parseCubeLUTCore(content, {
    ...options,
    lookupStoredProfile: getStoredLUTProfileSelection,
  })
}

export function isSupportedLUT(file: File | string): boolean {
  const name = typeof file === 'string' ? file : file.name
  const ext = name.split('.').pop()?.toLowerCase()
  return ext ? ext === 'cube' : false
}
