import { getLUTColorProfile } from '@lumaforge/luma-color-runtime'
import { describe, expect, it } from 'vitest'

import {
  getProfileAsOutputLabel,
  getProfileContractLabel,
  getProfileOutputLabel,
} from './lut-contract-labels'

const vlog709 = getLUTColorProfile('panasonic-vgamut-vlog')! // input-only unless output annotated
const displaySrgb = getLUTColorProfile('display-srgb')!

describe('getProfileOutputLabel', () => {
  it('names an implied or declared display output as Rec.709 display', () => {
    expect(getProfileOutputLabel(displaySrgb)).toBe('Rec.709 display')
    expect(
      getProfileOutputLabel({
        ...vlog709,
        role: 'combined-look-output',
        outputGamut: 'srgb-rec709',
        outputTransfer: 'bt709',
        outputRange: 'legal',
      }),
    ).toBe('Rec.709 display')
  })

  it('names a declared scene output by gamut and transfer', () => {
    expect(
      getProfileOutputLabel({
        ...displaySrgb,
        role: 'technical-output',
        outputGamut: 'v-gamut',
        outputTransfer: 'v-log',
        outputRange: 'full',
      }),
    ).toBe('V-Gamut / V-Log')
  })

  it('asks for an output when the contract has none', () => {
    expect(getProfileOutputLabel(vlog709)).toBe('Output profile required')
    expect(getProfileOutputLabel(undefined)).toBeUndefined()
  })
})

describe('getProfileAsOutputLabel', () => {
  it('names a profile used as an output by its input side', () => {
    expect(getProfileAsOutputLabel(displaySrgb)).toBe('Rec.709 display')
    expect(getProfileAsOutputLabel(vlog709)).toBe('V-Gamut / V-Log')
  })
})

describe('getProfileContractLabel', () => {
  it('returns the profile label without the output suffix when the profile has a full output contract', () => {
    const complete = {
      ...vlog709,
      role: 'combined-look-output' as const,
      outputGamut: 'srgb-rec709' as const,
      outputTransfer: 'gamma24' as const,
      outputRange: 'full' as const,
    }
    expect(getProfileContractLabel(complete)).toBe(vlog709.label)
    expect(getProfileContractLabel(complete)).not.toContain('->')
  })

  it('returns the profile label when the profile lacks an output contract', () => {
    expect(getProfileContractLabel(vlog709)).toBe(vlog709.label)
  })
})
