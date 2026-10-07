import { describe, expect, it, vi } from 'vitest'

import {
  inferLUTInputProfile,
  resolveLUTProfile,
  toCompatInputProfile,
} from './lut-profile-resolution'
import type { LUTColorProfile } from './registry'
import { getLUTColorProfile } from './registry'

const V_LOG_TO_REC709_METADATA = [
  'LUMAFORGE_INPUT_PROFILE=panasonic-vgamut-vlog',
  'LUMAFORGE_ROLE=combined-look-output',
  'LUMAFORGE_OUTPUT_GAMUT=srgb-rec709',
  'LUMAFORGE_OUTPUT_TRANSFER=bt709',
  'LUMAFORGE_OUTPUT_RANGE=full',
]

function registryProfile(id: string): LUTColorProfile {
  const profile = getLUTColorProfile(id)
  if (!profile) throw new Error(`Missing registry profile ${id}`)
  return profile
}

describe('lUT contract precedence', () => {
  it('resolves structured metadata ahead of a stored user contract', () => {
    const lookupStoredProfile = vi.fn(() => registryProfile('display-srgb'))

    expect(
      resolveLUTProfile({
        title: 'Trusted LUT',
        comments: V_LOG_TO_REC709_METADATA,
        fingerprint: 'metadata-and-stored',
        lookupStoredProfile,
      }),
    ).toMatchObject({
      kind: 'confirmed',
      confidence: 'metadata',
      profile: { id: 'panasonic-vgamut-vlog' },
    })
    expect(lookupStoredProfile).not.toHaveBeenCalled()
  })

  it('resolves a stored user contract ahead of name recommendations', () => {
    const lookupStoredProfile = vi.fn(() =>
      registryProfile('sony-sgamut3cine-slog3'),
    )

    expect(
      resolveLUTProfile({
        title: 'LUMIXPHOTOSTYLE VLOG',
        sourceName: 'Panasonic_VLog.cube',
        comments: [],
        fingerprint: 'stored-fingerprint',
        lookupStoredProfile,
      }),
    ).toMatchObject({
      kind: 'confirmed',
      confidence: 'persisted-user',
      profile: { id: 'sony-sgamut3cine-slog3' },
    })
    expect(lookupStoredProfile).toHaveBeenCalledWith('stored-fingerprint')
  })

  it('resolves a stored user contract ahead of an unsupported output annotation', () => {
    expect(
      resolveLUTProfile({
        title: 'Sony technical LUT',
        sourceName: 'SLog3_SGamut3Cine_to_Cineon.cube',
        comments: [],
        fingerprint: 'stored-cineon',
        lookupStoredProfile: () => registryProfile('display-srgb'),
      }),
    ).toMatchObject({
      kind: 'confirmed',
      confidence: 'persisted-user',
      profile: { id: 'display-srgb' },
    })
  })

  it('falls through to recommendations when the stored lookup misses', () => {
    expect(
      resolveLUTProfile({
        title: 'Sony technical LUT',
        sourceName: 'SLog3_SGamut3Cine_to_Rec709.cube',
        comments: [],
        fingerprint: 'unknown-fingerprint',
        lookupStoredProfile: () => undefined,
      }),
    ).toMatchObject({
      kind: 'recommended',
      recommendations: expect.arrayContaining([
        expect.objectContaining({
          id: 'sony-sgamut3cine-slog3',
          role: 'combined-look-output',
          outputGamut: 'srgb-rec709',
          outputTransfer: 'gamma24',
          outputRange: 'full',
        }),
      ]),
    })
  })

  it('never consults storage without both a fingerprint and a lookup', () => {
    const lookupStoredProfile = vi.fn(() => registryProfile('display-srgb'))

    expect(
      resolveLUTProfile({
        title: 'Panasonic technical LUT',
        sourceName: 'Panasonic_VLog.cube',
        comments: [],
        lookupStoredProfile,
      }).kind,
    ).toBe('recommended')
    expect(lookupStoredProfile).not.toHaveBeenCalled()

    expect(
      resolveLUTProfile({
        title: 'Panasonic technical LUT',
        sourceName: 'Panasonic_VLog.cube',
        comments: [],
        fingerprint: 'no-lookup',
      }).kind,
    ).toBe('recommended')
  })
})

describe('lUT explicit profile labels', () => {
  it('does not resolve LUT contracts from filename or free-form comments', () => {
    const resolution = resolveLUTProfile({
      title: 'Generated',
      sourceName: 'technical-vlog-to-rec709.cube',
      comments: ['LUMIXPHOTOSTYLE VLOG'],
    })

    expect(resolution.kind).not.toBe('confirmed')
  })

  it('resolves structured metadata as a full input and output contract', () => {
    const resolution = resolveLUTProfile({
      title: 'Trusted LUT',
      sourceName: 'renamed-file.cube',
      comments: V_LOG_TO_REC709_METADATA,
    })

    expect(resolution).toMatchObject({
      kind: 'confirmed',
      confidence: 'metadata',
      profile: {
        id: 'panasonic-vgamut-vlog',
        inputGamut: 'v-gamut',
        inputTransfer: 'v-log',
        role: 'combined-look-output',
        outputGamut: 'srgb-rec709',
        outputTransfer: 'bt709',
        outputRange: 'full',
      },
    })
  })

  it('does not resolve structured metadata when input profile conflicts with explicit input fields', () => {
    const resolution = resolveLUTProfile({
      title: 'Contradictory LUT',
      sourceName: 'contradictory.cube',
      comments: [
        'LUMAFORGE_INPUT_PROFILE=display-srgb',
        'LUMAFORGE_ROLE=display-look',
        'LUMAFORGE_INPUT_GAMUT=v-gamut',
        'LUMAFORGE_INPUT_TRANSFER=v-log',
        'LUMAFORGE_INPUT_RANGE=full',
        'LUMAFORGE_OUTPUT_GAMUT=srgb-rec709',
        'LUMAFORGE_OUTPUT_TRANSFER=bt709',
        'LUMAFORGE_OUTPUT_RANGE=full',
      ],
    })

    expect(resolution.kind).not.toBe('confirmed')
  })

  it('does not resolve display-look metadata for non-display input without output fields', () => {
    const resolution = resolveLUTProfile({
      title: 'Incomplete Camera LUT',
      sourceName: 'Panasonic_VLog.cube',
      comments: [
        'LUMAFORGE_INPUT_PROFILE=panasonic-vgamut-vlog',
        'LUMAFORGE_ROLE=display-look',
      ],
    })

    expect(resolution.kind).not.toBe('confirmed')
  })

  it('does not resolve display-look metadata for non-display input with output fields', () => {
    const resolution = resolveLUTProfile({
      title: 'Malformed Camera LUT',
      sourceName: 'Panasonic_VLog_to_Rec709.cube',
      comments: [
        'LUMAFORGE_INPUT_PROFILE=panasonic-vgamut-vlog',
        'LUMAFORGE_ROLE=display-look',
        'LUMAFORGE_OUTPUT_GAMUT=srgb-rec709',
        'LUMAFORGE_OUTPUT_TRANSFER=bt709',
        'LUMAFORGE_OUTPUT_RANGE=full',
      ],
    })

    expect(resolution.kind).not.toBe('confirmed')
  })

  it('does not resolve input profile labels as explicit input profiles', () => {
    expect(
      resolveLUTProfile({
        title: 'Client LUT',
        comments: ['Input profile: V-Log'],
      }),
    ).toMatchObject({
      kind: 'recommended',
      recommendations: expect.arrayContaining([
        expect.objectContaining({ id: 'panasonic-vgamut-vlog' }),
      ]),
    })
  })

  it('does not resolve output, target, destination or bare profile labels as input profiles', () => {
    for (const comment of [
      'Output profile: V-Log',
      'Target profile = VLog',
      'Destination profile: V-Log',
      'Profile: V-Log',
    ]) {
      expect(
        resolveLUTProfile({ title: 'Client LUT', comments: [comment] }).kind,
      ).toBe('unknown')
    }
  })

  it('ignores mixed-case output-side to and for markers for input inference', () => {
    for (const name of ['UnknownCamera_To_VLog', 'UnknownCamera_FOR_VLog']) {
      expect(
        resolveLUTProfile({
          title: name,
          sourceName: `${name}.cube`,
          comments: [],
        }).kind,
      ).toBe('unknown')
    }
  })

  it('does not resolve unsupported Cineon output annotations as renderable profiles', () => {
    const resolution = resolveLUTProfile({
      title: 'Sony technical LUT',
      sourceName: 'SLog3_SGamut3Cine_to_Cineon.cube',
      comments: [],
    })

    expect(resolution.kind).toBe('unsupported-output')
    if (resolution.kind !== 'unsupported-output') {
      throw new Error('Expected Cineon LUT to require profile selection')
    }
    expect(resolution.recommendations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'sony-sgamut3cine-slog3' }),
      ]),
    )
  })

  it('detects unsupported for Cineon and unknown LogC directional outputs', () => {
    for (const sourceName of [
      'SLog3_SGamut3Cine_for_Cineon.cube',
      'SLog3_SGamut3Cine_toCineon.cube',
      'SLog3_SGamut3Cine_to_LogC.cube',
      'SLog3_SGamut3Cine_for_LogC.cube',
    ]) {
      expect(
        resolveLUTProfile({
          title: 'Sony technical LUT',
          sourceName,
          comments: [],
        }),
      ).toMatchObject({ kind: 'unsupported-output' })
    }
  })
})

describe('binary input projection', () => {
  it('maps only confirmed V-Log contracts to the v-log compat profile', () => {
    expect(
      toCompatInputProfile(
        resolveLUTProfile({
          title: 'Trusted LUT',
          comments: V_LOG_TO_REC709_METADATA,
        }),
      ),
    ).toBe('v-log')
    expect(
      toCompatInputProfile(
        resolveLUTProfile({
          title: 'Panasonic technical LUT',
          sourceName: 'Panasonic_VLog.cube',
          comments: [],
        }),
      ),
    ).toBe('display-srgb')
    expect(toCompatInputProfile({ kind: 'unknown' })).toBe('display-srgb')
  })

  it('infers the compat input profile from cube text comments', () => {
    const content = [
      ...V_LOG_TO_REC709_METADATA.map((line) => `# ${line}`),
      'LUT_3D_SIZE 2',
    ].join('\n')

    expect(inferLUTInputProfile({ content, sourceName: 'any.cube' })).toBe(
      'v-log',
    )
    expect(
      inferLUTInputProfile({
        content: 'LUT_3D_SIZE 2',
        sourceName: 'Panasonic_VLog.cube',
      }),
    ).toBe('display-srgb')
  })
})
