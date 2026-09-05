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

export function mapIntensityLevel(
  level: 'off' | 'light' | 'standard' | 'strong',
) {
  if (level === 'off') return 0
  if (level === 'light') return 0.4
  if (level === 'standard') return 0.7
  return 1
}

/**
 * Inverse of {@link mapIntensityLevel}: recover the discrete intensity level
 * from a stored params intensity. Used to keep the detached (pre-session)
 * look in sync with the canonical intensity stored in processing params.
 */
export function intensityLevelFromValue(
  intensity: number,
): 'off' | 'light' | 'standard' | 'strong' {
  if (intensity <= 0) return 'off'
  if (intensity <= 0.4) return 'light'
  if (intensity <= 0.7) return 'standard'
  return 'strong'
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
    defaultIntensityLevel: 'standard' as const,
    currentIntensityLevel: 'standard' as const,
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
