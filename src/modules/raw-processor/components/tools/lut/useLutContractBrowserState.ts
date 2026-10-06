import type { LUTColorProfile } from '@lumaforge/luma-color-runtime'
import { searchLUTColorProfiles } from '@lumaforge/luma-color-runtime'
import { useMemo } from 'react'

import { groupProfiles } from '../lut-contract-labels'
import type { LUTOutputOption } from './lut-output-options'
import {
  dedupeOutputOptions,
  dedupeProfiles,
  groupOutputOptions,
  toDeclaredOutputOption,
  toSearchOutputOption,
} from './lut-output-options'

type UseLutContractBrowserStateInput = {
  query: string
  suggestions: LUTColorProfile[]
  currentProfile?: LUTColorProfile | null
}

export function useLutContractBrowserState({
  query,
  suggestions,
  currentProfile,
}: UseLutContractBrowserStateInput) {
  const searchResults = useMemo(() => searchLUTColorProfiles(query), [query])
  const hasQuery = query.trim().length > 0
  const resultIds = useMemo(
    () => new Set(searchResults.map((profile) => profile.id)),
    [searchResults],
  )
  const visibleSuggestions = useMemo(
    () =>
      dedupeProfiles(suggestions).filter(
        (profile) => !hasQuery || resultIds.has(profile.id),
      ),
    [hasQuery, resultIds, suggestions],
  )
  const suggestionIds = useMemo(
    () => new Set(visibleSuggestions.map((profile) => profile.id)),
    [visibleSuggestions],
  )
  const groupedInputProfiles = useMemo(
    () =>
      groupProfiles(
        dedupeProfiles(searchResults).filter(
          (profile) => !suggestionIds.has(profile.id),
        ),
      ),
    [searchResults, suggestionIds],
  )
  const currentOutputOption = useMemo(
    () => (currentProfile ? toDeclaredOutputOption(currentProfile) : undefined),
    [currentProfile],
  )
  const suggestedOutputOptions = useMemo(
    () =>
      dedupeOutputOptions(
        [
          currentOutputOption,
          ...visibleSuggestions.map(
            (profile) =>
              toDeclaredOutputOption(profile) ?? toSearchOutputOption(profile),
          ),
        ].filter(Boolean) as LUTOutputOption[],
      ),
    [currentOutputOption, visibleSuggestions],
  )
  const groupedOutputOptions = useMemo(
    () =>
      groupOutputOptions(
        dedupeOutputOptions(
          searchResults
            .filter((profile) => !suggestionIds.has(profile.id))
            .map(toSearchOutputOption),
        ),
      ),
    [searchResults, suggestionIds],
  )
  const activeOutputOptionId = useMemo(() => {
    if (
      !currentProfile?.outputGamut ||
      !currentProfile.outputTransfer ||
      !currentProfile.outputRange
    ) {
      return undefined
    }

    return `${currentProfile.id}:declared-output`
  }, [currentProfile])
  const hasInputMatches =
    visibleSuggestions.length > 0 || groupedInputProfiles.length > 0
  const hasOutputMatches =
    suggestedOutputOptions.length > 0 || groupedOutputOptions.length > 0

  return {
    searchResults,
    hasQuery,
    visibleSuggestions,
    groupedInputProfiles,
    suggestedOutputOptions,
    groupedOutputOptions,
    activeOutputOptionId,
    hasInputMatches,
    hasOutputMatches,
  }
}
