import type { LUTColorProfile } from '@lumaforge/luma-color-runtime'

import {
  getProfileAsOutputLabel,
  getProfileOutputLabel,
} from '../../components/tools/lut-contract-labels'
import { toSelectableContract } from './lut-contract'

export type LUTOutputOption = {
  id: string
  label: string
  gamut: LUTColorProfile['inputGamut']
  transfer: LUTColorProfile['inputTransfer']
  range: LUTColorProfile['inputRange']
  sourceProfile: LUTColorProfile
}

export function dedupeProfiles(profiles: LUTColorProfile[]) {
  const seen = new Set<string>()
  return profiles.filter((profile) => {
    if (seen.has(profile.id)) return false
    seen.add(profile.id)
    return true
  })
}

export function dedupeOutputOptions(options: LUTOutputOption[]) {
  const seen = new Set<string>()
  return options.filter((option) => {
    const key = [option.gamut, option.transfer, option.range].join(':')
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export function getOutputGroupLabel(profile: LUTColorProfile) {
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

export function toDeclaredOutputOption(
  profile: LUTColorProfile,
): LUTOutputOption | undefined {
  const selectable = toSelectableContract(profile)
  if (
    !selectable?.outputGamut ||
    !selectable.outputTransfer ||
    !selectable.outputRange
  ) {
    return undefined
  }

  return {
    id: `${profile.id}:declared-output`,
    label:
      getProfileOutputLabel(selectable) ?? getProfileAsOutputLabel(profile),
    gamut: selectable.outputGamut,
    transfer: selectable.outputTransfer,
    range: selectable.outputRange,
    sourceProfile: profile,
  }
}

export function toSearchOutputOption(
  profile: LUTColorProfile,
): LUTOutputOption {
  return {
    id: `${profile.id}:search-output`,
    label: profile.label,
    gamut: profile.inputGamut,
    transfer: profile.inputTransfer,
    range: profile.inputRange,
    sourceProfile: profile,
  }
}

export function toOutputCarrierProfile(
  option: LUTOutputOption,
): LUTColorProfile {
  return {
    ...option.sourceProfile,
    inputGamut: option.gamut,
    inputTransfer: option.transfer,
    inputRange: option.range,
    outputGamut: undefined,
    outputTransfer: undefined,
    outputRange: undefined,
  }
}

export function groupOutputOptions(options: LUTOutputOption[]) {
  const groups = new Map<string, LUTOutputOption[]>()

  for (const option of options) {
    const group = getOutputGroupLabel(option.sourceProfile)
    groups.set(group, [...(groups.get(group) ?? []), option])
  }

  return Array.from(groups.entries()).map(([label, items]) => ({
    label,
    items,
  }))
}
