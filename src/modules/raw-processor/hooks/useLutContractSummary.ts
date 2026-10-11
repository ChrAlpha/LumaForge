import type { LUTContractResolution } from '@lumaforge/luma-color-runtime'
import { useMemo } from 'react'

import type { LUTContractSelectionState } from '../model/session'
import {
  deriveLUTContractView,
  getResolvedProfile,
} from '../services/look/lut-contract'

type UseLutContractSummaryInput = {
  lutProfileSelection?: LUTContractSelectionState | null
  lutProfileResolution?: LUTContractResolution | null
}

export function useLutContractSummary({
  lutProfileSelection,
  lutProfileResolution,
}: UseLutContractSummaryInput) {
  const profileSuggestions = useMemo(() => {
    const resolution = lutProfileResolution
    return resolution &&
      (resolution.kind === 'recommended' ||
        resolution.kind === 'unsupported-output')
      ? resolution.recommendations
      : []
  }, [lutProfileResolution])
  const resolvedProfile = getResolvedProfile(
    lutProfileSelection,
    lutProfileResolution,
  )
  const contractView = deriveLUTContractView(
    lutProfileSelection,
    lutProfileResolution,
  )
  const needsUserSelection =
    lutProfileResolution != null && lutProfileResolution.kind !== 'confirmed'

  return {
    profileSuggestions,
    resolvedProfile,
    contractView,
    needsUserSelection,
  }
}
