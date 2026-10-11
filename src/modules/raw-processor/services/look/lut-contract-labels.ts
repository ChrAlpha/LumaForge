import type { LUTColorProfile } from '@lumaforge/luma-color-runtime'
import {
  getColorGamut,
  getTransferFunction,
  hasDisplayLikeInput,
} from '@lumaforge/luma-color-runtime'

import type { KnownLUTContractOutput, LUTContractOutput } from './lut-contract'
import { describeLUTContractOutput } from './lut-contract'

const DISPLAY_OUTPUT_LABEL = 'Rec.709 display'

/** Names a known contract output for the LUT surfaces. */
export function formatLUTContractOutput(output: KnownLUTContractOutput) {
  if (output.kind === 'display-implied' || output.displayLike) {
    return DISPLAY_OUTPUT_LABEL
  }

  const gamut = getColorGamut(output.gamut)?.label ?? output.gamut
  const transfer =
    getTransferFunction(output.transfer)?.label ?? output.transfer
  return `${gamut} / ${transfer}`
}

function formatOutput(output: LUTContractOutput) {
  if (output.kind === 'missing') return 'Output profile required'
  return formatLUTContractOutput(output)
}

export function getProfileOutputLabel(profile?: LUTColorProfile) {
  if (!profile) return undefined
  return formatOutput(describeLUTContractOutput(profile))
}

export function getProfileAsOutputLabel(profile: LUTColorProfile) {
  if (hasDisplayLikeInput(profile)) return DISPLAY_OUTPUT_LABEL

  const gamut = getColorGamut(profile.inputGamut)?.label ?? profile.inputGamut
  const transfer =
    getTransferFunction(profile.inputTransfer)?.label ?? profile.inputTransfer

  return `${gamut} / ${transfer}`
}

export function getProfileContractLabel(profile: LUTColorProfile) {
  return profile.label
}

export function getProfileGroupLabel(profile: LUTColorProfile) {
  if (profile.role === 'display-look') return 'Output'
  if (profile.label.startsWith('ARRI')) return 'ARRI'
  if (profile.label.startsWith('RED')) return 'RED'
  if (profile.label.startsWith('Nikon')) return 'Nikon'
  if (profile.label.startsWith('Sony')) return 'Sony'
  if (profile.label.startsWith('Canon')) return 'Canon'
  if (profile.label.startsWith('Fujifilm')) return 'Fujifilm'
  if (profile.label.startsWith('Panasonic')) return 'Panasonic'
  if (profile.label.startsWith('ACES')) return 'ACES'
  return 'Other'
}

export function groupProfiles(profiles: LUTColorProfile[]) {
  const groups = new Map<string, LUTColorProfile[]>()

  for (const profile of profiles) {
    const group = getProfileGroupLabel(profile)
    groups.set(group, [...(groups.get(group) ?? []), profile])
  }

  return Array.from(groups.entries()).map(([label, items]) => ({
    label,
    items,
  }))
}
