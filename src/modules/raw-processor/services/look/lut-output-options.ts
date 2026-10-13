import type { LUTColorProfile } from '@lumaforge/luma-color-runtime'

import { toSelectableContract } from './lut-contract'
import { getProfileOutputLabel, groupByProfile } from './lut-contract-labels'

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
    label: getProfileOutputLabel(selectable),
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
  return groupByProfile(options, (option) => option.sourceProfile)
}
