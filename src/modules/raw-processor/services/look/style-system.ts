import type { ParsedLUT } from '@lumaforge/luma-color-runtime'

import type { LUTContractSelectionState } from '../../model/session'

/**
 * Named amounts of a look. Strength is continuous; these only mark the
 * detents (and their labels) on the Strength row.
 */
export const LOOK_INTENSITY_PRESETS = {
  light: 0.4,
  standard: 0.7,
  strong: 1,
} as const

/** Where a fresh look starts, and what a Strength reset returns to. */
export const DEFAULT_LOOK_INTENSITY = LOOK_INTENSITY_PRESETS.standard

export function buildLUTContractSelectionState(
  lut: ParsedLUT,
): LUTContractSelectionState {
  const resolution = lut.profileResolution
  if (resolution.kind === 'confirmed') {
    return {
      status: 'confirmed',
      fingerprint: lut.fingerprint,
      profileId: resolution.profile.id,
      confidence: resolution.confidence,
    }
  }
  if (resolution.kind === 'recommended') {
    return {
      status: 'recommended',
      fingerprint: lut.fingerprint,
      title: lut.title,
      sourceName: lut.sourceName,
      recommendations: resolution.recommendations,
    }
  }
  if (resolution.kind === 'unsupported-output') {
    return {
      status: 'unsupported-output',
      fingerprint: lut.fingerprint,
      title: lut.title,
      sourceName: lut.sourceName,
      recommendations: resolution.recommendations,
    }
  }
  return {
    status: 'unknown',
    fingerprint: lut.fingerprint,
    title: lut.title,
    sourceName: lut.sourceName,
  }
}

export function toCustomStyle(
  lut: ParsedLUT,
  options: { sha256?: string } = {},
) {
  return {
    kind: 'custom' as const,
    name: lut.title || 'Custom LUT',
    currentIntensity: DEFAULT_LOOK_INTENSITY,
    defaultIntensity: DEFAULT_LOOK_INTENSITY,
    lutAsset: {
      format: 'cube' as const,
      dimension: lut.size as 17 | 33 | 65,
      title: lut.title,
      profileResolution: lut.profileResolution,
      fingerprint: lut.fingerprint,
      sha256: options.sha256 ?? lut.sha256,
      sourceName: lut.sourceName,
    },
  }
}
