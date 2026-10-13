import type { LUTColorProfile } from '@lumaforge/luma-color-runtime'
import {
  getColorGamut,
  getTransferFunction,
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

export function getProfileOutputLabel(profile: LUTColorProfile) {
  return formatOutput(describeLUTContractOutput(profile))
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

/** Groups items by the group label of the profile each names, in first-seen order. */
export function groupByProfile<Item>(
  items: readonly Item[],
  profileOf: (item: Item) => LUTColorProfile,
) {
  const groups = new Map<string, Item[]>()
  for (const item of items) {
    const label = getProfileGroupLabel(profileOf(item))
    groups.set(label, [...(groups.get(label) ?? []), item])
  }
  return Array.from(groups, ([label, grouped]) => ({ label, items: grouped }))
}

export function groupProfiles(profiles: LUTColorProfile[]) {
  return groupByProfile(profiles, (profile) => profile)
}
