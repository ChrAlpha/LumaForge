import type { LUTContractResolution } from '@lumaforge/luma-color-runtime'

import { useLutContractBrowserState } from '../../hooks/useLutContractBrowserState'
import { useLutContractSummary } from '../../hooks/useLutContractSummary'
import type { LUTContractSelectionState } from '../../model/session'

type UseMobileLutContractStateInput = {
  contractQuery: string
  lutProfileSelection?: LUTContractSelectionState | null
  lutProfileResolution?: LUTContractResolution | null
}

export function useMobileLutContractState({
  contractQuery,
  lutProfileSelection,
  lutProfileResolution,
}: UseMobileLutContractStateInput) {
  const summary = useLutContractSummary({
    lutProfileSelection,
    lutProfileResolution,
  })
  const browserState = useLutContractBrowserState({
    query: contractQuery,
    suggestions: summary.profileSuggestions,
    currentProfile: summary.resolvedProfile,
  })

  return {
    ...summary,
    contractSearchResults: browserState.searchResults,
    hasContractQuery: browserState.hasQuery,
    visibleSuggestions: browserState.visibleSuggestions,
    groupedInputProfiles: browserState.groupedInputProfiles,
    suggestedOutputOptions: browserState.suggestedOutputOptions,
    groupedOutputOptions: browserState.groupedOutputOptions,
    activeOutputOptionId: browserState.activeOutputOptionId,
    hasInputMatches: browserState.hasInputMatches,
    hasOutputMatches: browserState.hasOutputMatches,
  }
}
