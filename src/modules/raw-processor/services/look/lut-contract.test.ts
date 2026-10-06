import type { LUTColorProfile } from '@lumaforge/luma-color-runtime'
import { getLUTColorProfile } from '@lumaforge/luma-color-runtime'
import { describe, expect, it } from 'vitest'

import {
  composeLUTContractProfile,
  deriveLUTContractView,
  describeLUTContractOutput,
  getResolvedProfile,
  toSelectableContract,
} from './lut-contract'

function requireProfile(id: string): LUTColorProfile {
  const profile = getLUTColorProfile(id)
  if (!profile) throw new Error(`Missing test profile ${id}`)
  return profile
}

const vlog = requireProfile('panasonic-vgamut-vlog') // input-only
const slog3 = requireProfile('sony-sgamut3cine-slog3') // input-only
const displaySrgb = requireProfile('display-srgb') // display look, no output
const rec709 = requireProfile('rec709-gamma24') // display look, no output

const vlogTo709: LUTColorProfile = {
  ...vlog,
  role: 'combined-look-output',
  outputGamut: 'srgb-rec709',
  outputTransfer: 'gamma24',
  outputRange: 'full',
}

/** An output picked in the browser: its input side names the output. */
function outputCarrier(
  profile: LUTColorProfile,
  range: LUTColorProfile['inputRange'] = profile.inputRange,
): LUTColorProfile {
  return {
    ...profile,
    inputRange: range,
    outputGamut: undefined,
    outputTransfer: undefined,
    outputRange: undefined,
  }
}

describe('composeLUTContractProfile', () => {
  it('keeps a display look on display input with display output a display look', () => {
    const composed = composeLUTContractProfile(
      displaySrgb,
      outputCarrier(rec709),
    )
    expect(composed.role).toBe('display-look')
    expect(composed.inputGamut).toBe('srgb-rec709')
    expect(composed.inputTransfer).toBe('srgb')
    expect(composed.outputGamut).toBe('srgb-rec709')
    expect(composed.outputTransfer).toBe('gamma24')
    expect(composed.outputRange).toBe('full')
  })

  it('makes a scene input into display output a combined look/output', () => {
    const composed = composeLUTContractProfile(slog3, outputCarrier(rec709))
    expect(composed.role).toBe('combined-look-output')
    expect(composed.id).toBe(slog3.id)
    expect(composed.label).toBe(slog3.label)
    expect(composed.inputGamut).toBe('s-gamut3-cine')
    expect(composed.inputTransfer).toBe('s-log3')
  })

  it('makes an output matching the input a scene-creative LUT', () => {
    const composed = composeLUTContractProfile(slog3, outputCarrier(slog3))
    expect(composed.role).toBe('scene-creative')
    expect(composed.outputGamut).toBe('s-gamut3-cine')
    expect(composed.outputTransfer).toBe('s-log3')
  })

  it('makes a scene-to-other-scene LUT a technical output and carries the range', () => {
    const composed = composeLUTContractProfile(
      slog3,
      outputCarrier(vlog, 'legal'),
    )
    expect(composed.role).toBe('technical-output')
    expect(composed.inputRange).toBe('full')
    expect(composed.outputGamut).toBe('v-gamut')
    expect(composed.outputTransfer).toBe('v-log')
    expect(composed.outputRange).toBe('legal')
  })

  it('treats a display look on scene input with display output as combined', () => {
    const composed = composeLUTContractProfile(
      { ...slog3, role: 'display-look' },
      outputCarrier(displaySrgb),
    )
    expect(composed.role).toBe('combined-look-output')
  })
})

describe('describeLUTContractOutput', () => {
  it('implies display output for a display look on display input', () => {
    expect(describeLUTContractOutput(displaySrgb)).toEqual({
      kind: 'display-implied',
    })
  })

  it('reports a missing output for an input-only scene profile', () => {
    expect(describeLUTContractOutput(vlog)).toEqual({ kind: 'missing' })
    expect(
      describeLUTContractOutput({ ...vlog, outputGamut: 'srgb-rec709' }),
    ).toEqual({ kind: 'missing' })
  })

  it('reports a missing output for a display look on scene input', () => {
    expect(
      describeLUTContractOutput({ ...slog3, role: 'display-look' }),
    ).toEqual({ kind: 'missing' })
  })

  it('describes a declared display output', () => {
    expect(describeLUTContractOutput(vlogTo709)).toEqual({
      kind: 'declared',
      gamut: 'srgb-rec709',
      transfer: 'gamma24',
      range: 'full',
      displayLike: true,
    })
  })

  it('describes a declared scene output', () => {
    expect(
      describeLUTContractOutput({
        ...slog3,
        role: 'technical-output',
        outputGamut: 'v-gamut',
        outputTransfer: 'v-log',
        outputRange: 'legal',
      }),
    ).toEqual({
      kind: 'declared',
      gamut: 'v-gamut',
      transfer: 'v-log',
      range: 'legal',
      displayLike: false,
    })
  })
})

describe('toSelectableContract', () => {
  it('accepts profiles whose output side is known', () => {
    expect(toSelectableContract(displaySrgb)).toBe(displaySrgb)
    expect(toSelectableContract(vlogTo709)).toBe(vlogTo709)
  })

  it('rejects profiles that still need an output', () => {
    expect(toSelectableContract(vlog)).toBeUndefined()
    expect(
      toSelectableContract({ ...slog3, role: 'display-look' }),
    ).toBeUndefined()
  })
})

describe('getResolvedProfile', () => {
  it('prefers a confirmed resolution over the stored selection', () => {
    expect(
      getResolvedProfile(
        {
          status: 'confirmed',
          fingerprint: 'fp',
          profileId: 'display-srgb',
          confidence: 'user',
        },
        { kind: 'confirmed', confidence: 'user', profile: vlogTo709 },
      ),
    ).toBe(vlogTo709)
  })

  it('falls back to a confirmed selection when the resolution is not confirmed', () => {
    expect(
      getResolvedProfile(
        {
          status: 'confirmed',
          fingerprint: 'fp',
          profileId: 'display-srgb',
          confidence: 'user',
        },
        { kind: 'recommended', recommendations: [slog3] },
      )?.id,
    ).toBe('display-srgb')
  })

  it('resolves nothing without a confirmation', () => {
    expect(getResolvedProfile(null, null)).toBeUndefined()
    expect(
      getResolvedProfile(null, {
        kind: 'recommended',
        recommendations: [slog3],
      }),
    ).toBeUndefined()
  })
})

describe('deriveLUTContractView', () => {
  it('returns confirmed with the implied display output for a resolved selection', () => {
    const view = deriveLUTContractView(
      {
        status: 'confirmed',
        fingerprint: 'fp',
        profileId: 'display-srgb',
        confidence: 'metadata',
      },
      null,
    )
    expect(view).toEqual({
      status: 'confirmed',
      profile: displaySrgb,
      output: { kind: 'display-implied' },
    })
  })

  it('returns confirmed with the declared output for a confirmed resolution', () => {
    const view = deriveLUTContractView(null, {
      kind: 'confirmed',
      confidence: 'user',
      profile: vlogTo709,
    })
    expect(view.status).toBe('confirmed')
    if (view.status === 'confirmed') {
      expect(view.output).toEqual({
        kind: 'declared',
        gamut: 'srgb-rec709',
        transfer: 'gamma24',
        range: 'full',
        displayLike: true,
      })
    }
  })

  it('returns incomplete-output when the resolved profile has no output side', () => {
    const view = deriveLUTContractView(null, {
      kind: 'confirmed',
      confidence: 'user',
      profile: vlog,
    })
    expect(view).toEqual({ status: 'incomplete-output', profile: vlog })
  })

  it('derives the status from the contract, not from profile wording', () => {
    const relabelled = { ...vlog, label: 'Output profile required' }
    expect(
      deriveLUTContractView(null, {
        kind: 'confirmed',
        confidence: 'user',
        profile: relabelled,
      }).status,
    ).toBe('incomplete-output')

    const relabelledComplete = {
      ...vlogTo709,
      label: 'Output profile required',
    }
    expect(
      deriveLUTContractView(null, {
        kind: 'confirmed',
        confidence: 'user',
        profile: relabelledComplete,
      }).status,
    ).toBe('confirmed')
  })

  it('returns recommended with completesContract=false for an input-only recommendation', () => {
    const view = deriveLUTContractView(
      {
        status: 'recommended',
        fingerprint: 'fp',
        title: 't',
        recommendations: [vlog],
      },
      { kind: 'recommended', recommendations: [vlog] },
    )
    expect(view.status).toBe('recommended')
    if (view.status === 'recommended') {
      expect(view.recommendation.id).toBe(vlog.id)
      expect(view.completesContract).toBe(false)
    }
  })

  it('returns recommended with completesContract=true when the recommendation has a full output', () => {
    const view = deriveLUTContractView(
      {
        status: 'recommended',
        fingerprint: 'fp',
        title: 't',
        recommendations: [vlogTo709],
      },
      { kind: 'recommended', recommendations: [vlogTo709] },
    )
    expect(view.status).toBe('recommended')
    if (view.status === 'recommended') {
      expect(view.completesContract).toBe(true)
    }
  })

  it('reads recommendations from the selection when there is no resolution', () => {
    const view = deriveLUTContractView(
      {
        status: 'recommended',
        fingerprint: 'fp',
        title: 't',
        recommendations: [slog3, vlog],
      },
      null,
    )
    expect(view.status).toBe('recommended')
    if (view.status === 'recommended') {
      expect(view.recommendation.id).toBe(slog3.id)
      expect(view.recommendations.map((profile) => profile.id)).toEqual([
        slog3.id,
        vlog.id,
      ])
    }
  })

  it('prefers resolution recommendations over selection recommendations', () => {
    const view = deriveLUTContractView(
      {
        status: 'recommended',
        fingerprint: 'fp',
        title: 't',
        recommendations: [slog3],
      },
      { kind: 'recommended', recommendations: [vlog] },
    )
    expect(view.status === 'recommended' && view.recommendation.id).toBe(
      vlog.id,
    )
  })

  it('returns unsupported-output with recommendations', () => {
    const view = deriveLUTContractView(
      {
        status: 'unsupported-output',
        fingerprint: 'fp',
        title: 't',
        recommendations: [vlog],
      },
      { kind: 'unsupported-output', recommendations: [vlog] },
    )
    expect(view.status).toBe('unsupported-output')
    if (view.status === 'unsupported-output') {
      expect(view.recommendations.map((profile) => profile.id)).toEqual([
        vlog.id,
      ])
    }
  })

  it('returns unknown when there is nothing to work with', () => {
    expect(deriveLUTContractView(null, null).status).toBe('unknown')
    expect(
      deriveLUTContractView(
        { status: 'unknown', fingerprint: 'fp', title: 't' },
        { kind: 'unknown' },
      ).status,
    ).toBe('unknown')
    expect(
      deriveLUTContractView(null, {
        kind: 'recommended',
        recommendations: [],
      }).status,
    ).toBe('unknown')
  })
})
