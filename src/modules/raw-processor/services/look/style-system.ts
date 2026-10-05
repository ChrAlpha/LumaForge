import type {
  LUTColorProfile,
  LUTContractResolution,
} from '@lumaforge/luma-color-runtime'
import {
  getColorGamut,
  getTransferFunction,
} from '@lumaforge/luma-color-runtime'

import type { ParsedLUT } from '~/lib/lut/cube-parser'

import type { LUTContractSelectionState } from '../../model/session'

const DISPLAY_LIKE_INPUT_TRANSFERS = new Set(['srgb', 'bt709', 'gamma24'])

/**
 * Named amounts of a look. Strength is continuous; these only mark the
 * detents (and their labels) on the Strength row.
 */
export const LOOK_INTENSITY_PRESETS = {
  light: 0.4,
  standard: 0.7,
  strong: 1,
} as const

export type LookIntensityPreset = keyof typeof LOOK_INTENSITY_PRESETS

/** Where a fresh look starts, and what a Strength reset returns to. */
export const DEFAULT_LOOK_INTENSITY = LOOK_INTENSITY_PRESETS.standard

/** Keep a look amount inside 0..1; a non-number falls back to the default. */
export function clampLookIntensity(intensity: number): number {
  if (!Number.isFinite(intensity)) return DEFAULT_LOOK_INTENSITY
  return Math.min(1, Math.max(0, intensity))
}

function describeLUTOutput(profile: LUTColorProfile): string {
  if (!profile.outputGamut || !profile.outputTransfer || !profile.outputRange) {
    if (
      profile.role === 'display-look' &&
      profile.inputGamut === 'srgb-rec709' &&
      DISPLAY_LIKE_INPUT_TRANSFERS.has(profile.inputTransfer)
    ) {
      return 'Rec.709 display'
    }
    return 'output profile required'
  }

  if (
    profile.outputGamut === 'srgb-rec709' &&
    ['srgb', 'bt709', 'gamma24'].includes(profile.outputTransfer)
  ) {
    return 'Rec.709 display'
  }

  const gamut = getColorGamut(profile.outputGamut)?.label ?? profile.outputGamut
  const transfer =
    getTransferFunction(profile.outputTransfer)?.label ?? profile.outputTransfer

  return `${gamut} / ${transfer}`
}

function describeLUTContract(profileResolution: LUTContractResolution): string {
  if (profileResolution.kind === 'confirmed') {
    return `${profileResolution.profile.label} -> ${describeLUTOutput(
      profileResolution.profile,
    )}`
  }

  return 'an unresolved LUT contract'
}

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
  const warning =
    lut.profileResolution.kind === 'confirmed'
      ? `This LUT uses ${describeLUTContract(lut.profileResolution)}.`
      : 'Choose the LUT input and output contract before preview or export.'

  return {
    kind: 'custom' as const,
    name: lut.title || 'Custom LUT',
    currentIntensity: DEFAULT_LOOK_INTENSITY,
    defaultIntensity: DEFAULT_LOOK_INTENSITY,
    warning,
    lutAsset: {
      format: 'cube' as const,
      dimension: lut.size as 17 | 33 | 65,
      title: lut.title,
      inputProfile: lut.inputProfile,
      profileResolution: lut.profileResolution,
      fingerprint: lut.fingerprint,
      sha256: options.sha256 ?? lut.sha256,
      sourceName: lut.sourceName,
    },
  }
}
