import type {
  LUTColorProfile,
  LUTContractResolution,
} from '@lumaforge/luma-color-runtime'
import { useState } from 'react'

import type { LUTContractSelectionState } from '../../model/session'
import type { LUTOutputOption } from '../tools/lut/lut-output-options'
import { toOutputCarrierProfile } from '../tools/lut/lut-output-options'
import {
  composeLUTContractProfile,
  toSelectableContract,
} from '../tools/lut-contract'
import type { LookContractStep } from './MobileLookFooter'
import { useMobileLutContractState } from './useMobileLutContractState'

/**
 * Where a contract edit starts: at the output when only the output is
 * missing, otherwise at the input.
 */
export function initialContractStep(
  status: ReturnType<
    typeof useMobileLutContractState
  >['contractView']['status'],
): LookContractStep {
  return status === 'incomplete-output' ? 'output' : 'input'
}

/**
 * Two-step LUT contract editing (input, then output) for the mobile Look
 * deck: the step, the search query, and the input drafted before an output
 * completes the contract.
 */
export function useMobileLutContractEditor({
  lutProfileSelection,
  lutProfileResolution,
  onLutProfileSelect,
  onComplete,
}: {
  lutProfileSelection?: LUTContractSelectionState | null
  lutProfileResolution?: LUTContractResolution | null
  onLutProfileSelect: (profile: LUTColorProfile) => void
  /** The contract is complete; the editor's job is done. */
  onComplete: () => void
}) {
  const [contractQuery, setContractQuery] = useState('')
  const contractState = useMobileLutContractState({
    contractQuery,
    lutProfileSelection,
    lutProfileResolution,
  })
  const [contractStep, setContractStep] = useState<LookContractStep>(() =>
    initialContractStep(contractState.contractView.status),
  )
  const [draftInputProfile, setDraftInputProfile] =
    useState<LUTColorProfile | null>(contractState.resolvedProfile ?? null)

  const start = (
    step: LookContractStep = initialContractStep(
      contractState.contractView.status,
    ),
    draftOverride?: LUTColorProfile | null,
  ) => {
    setDraftInputProfile(
      draftOverride !== undefined
        ? draftOverride
        : (contractState.resolvedProfile ?? null),
    )
    setContractQuery('')
    setContractStep(step)
  }

  const selectInput = (profile: LUTColorProfile) => {
    setDraftInputProfile(profile)
    setContractQuery('')
    setContractStep('output')
  }

  const selectOutput = (option: LUTOutputOption) => {
    const inputProfile = draftInputProfile ?? option.sourceProfile
    onLutProfileSelect(
      composeLUTContractProfile(inputProfile, toOutputCarrierProfile(option)),
    )
    setContractQuery('')
    onComplete()
  }

  /**
   * A recommendation that declares its output completes the contract in one
   * tap; one that names only its input drafts it and moves on to the output.
   */
  const applyRecommendation = (profile: LUTColorProfile) => {
    if (toSelectableContract(profile)) {
      onLutProfileSelect(profile)
      setContractQuery('')
      onComplete()
      return
    }
    selectInput(profile)
  }

  const back = () => {
    setContractQuery('')
    setContractStep('input')
  }

  return {
    ...contractState,
    contractStep,
    contractQuery,
    draftInputProfile,
    setContractQuery,
    start,
    back,
    selectInput,
    selectOutput,
    applyRecommendation,
  }
}
