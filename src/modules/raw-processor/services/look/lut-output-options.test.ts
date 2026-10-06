import { getLUTColorProfile } from '@lumaforge/luma-color-runtime'
import { describe, expect, it } from 'vitest'

import { composeLUTContractProfile } from './lut-contract'
import {
  dedupeOutputOptions,
  dedupeProfiles,
  groupOutputOptions,
  toDeclaredOutputOption,
  toOutputCarrierProfile,
  toSearchOutputOption,
} from './lut-output-options'

const sony = getLUTColorProfile('sony-sgamut3cine-slog3')!
const panasonic = getLUTColorProfile('panasonic-vgamut-vlog')!
const nikon = getLUTColorProfile('nikon-bt2020-nlog')!
const displaySrgb = getLUTColorProfile('display-srgb')!
const rec709 = getLUTColorProfile('rec709-gamma24')!

describe('lutOutputOptions', () => {
  it('dedupes declared output options by output contract', () => {
    const sonyCombined = {
      ...sony,
      role: 'combined-look-output' as const,
      outputGamut: 'srgb-rec709' as const,
      outputTransfer: 'srgb' as const,
      outputRange: 'full' as const,
    }
    const panasonicCombined = {
      ...panasonic,
      role: 'combined-look-output' as const,
      outputGamut: 'srgb-rec709' as const,
      outputTransfer: 'srgb' as const,
      outputRange: 'full' as const,
    }

    const options = dedupeOutputOptions(
      [sonyCombined, panasonicCombined].map(
        (profile) => toDeclaredOutputOption(profile)!,
      ),
    )

    expect(options).toHaveLength(1)
    expect(options[0]?.id).toBe('sony-sgamut3cine-slog3:declared-output')
    expect(options[0]?.label).toBe('Rec.709 display')
  })

  it('keeps output options that differ in gamut, transfer or range', () => {
    const base = toSearchOutputOption(sony)
    const options = dedupeOutputOptions([
      base,
      { ...base, id: 'gamut', gamut: 'rec2020' },
      { ...base, id: 'transfer', transfer: 'srgb' },
      { ...base, id: 'range', range: 'legal' },
      { ...base, id: 'same' },
    ])

    expect(options.map((option) => option.id)).toEqual([
      base.id,
      'gamut',
      'transfer',
      'range',
    ])
  })

  it('declares no output option for a profile without a full output side', () => {
    expect(toDeclaredOutputOption(sony)).toBeUndefined()
    expect(
      toDeclaredOutputOption({
        ...sony,
        role: 'combined-look-output',
        outputGamut: 'srgb-rec709',
        outputTransfer: 'srgb',
      }),
    ).toBeUndefined()
  })

  it('offers a searched profile by its input side', () => {
    expect(toSearchOutputOption(nikon)).toEqual({
      id: 'nikon-bt2020-nlog:search-output',
      label: nikon.label,
      gamut: nikon.inputGamut,
      transfer: nikon.inputTransfer,
      range: nikon.inputRange,
      sourceProfile: nikon,
    })
  })

  it('composes the full contract through the carrier profile', () => {
    const combined = {
      ...panasonic,
      role: 'combined-look-output' as const,
      outputGamut: 'srgb-rec709' as const,
      outputTransfer: 'gamma24' as const,
      outputRange: 'legal' as const,
    }
    const declared = toDeclaredOutputOption(combined)!
    const carrier = toOutputCarrierProfile(declared)

    expect(carrier).toMatchObject({
      id: panasonic.id,
      inputGamut: 'srgb-rec709',
      inputTransfer: 'gamma24',
      inputRange: 'legal',
    })
    expect(carrier.outputGamut).toBeUndefined()
    expect(carrier.outputTransfer).toBeUndefined()
    expect(carrier.outputRange).toBeUndefined()

    expect(composeLUTContractProfile(sony, carrier)).toEqual(
      composeLUTContractProfile(sony, {
        ...rec709,
        inputRange: 'legal',
      }),
    )
    expect(
      composeLUTContractProfile(
        sony,
        toOutputCarrierProfile(toSearchOutputOption(displaySrgb)),
      ),
    ).toEqual(composeLUTContractProfile(sony, displaySrgb))
  })

  it('dedupes profiles by id in first-seen order', () => {
    expect(
      dedupeProfiles([sony, nikon, sony, panasonic, nikon]).map(
        (profile) => profile.id,
      ),
    ).toEqual([sony.id, nikon.id, panasonic.id])
  })

  it('groups output options by vendor in first-seen order', () => {
    const groups = groupOutputOptions(
      [nikon, displaySrgb, sony, rec709, panasonic].map(toSearchOutputOption),
    )

    expect(
      groups.map((group) => [
        group.label,
        group.items.map((item) => item.sourceProfile.id),
      ]),
    ).toEqual([
      ['Nikon', [nikon.id]],
      ['Output', [displaySrgb.id, rec709.id]],
      ['Sony', [sony.id]],
      ['Panasonic', [panasonic.id]],
    ])
  })
})
