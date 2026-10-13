import { describe, expect, it } from 'vitest'

import { resolveLUTProfile } from './lut-profile-resolution'

const V_LOG_TO_REC709_METADATA = [
  'LUMAFORGE_INPUT_PROFILE=panasonic-vgamut-vlog',
  'LUMAFORGE_ROLE=combined-look-output',
  'LUMAFORGE_OUTPUT_GAMUT=srgb-rec709',
  'LUMAFORGE_OUTPUT_TRANSFER=bt709',
  'LUMAFORGE_OUTPUT_RANGE=full',
]

describe('lUT name hints', () => {
  function recommendationsFor(sourceName: string, comments: string[] = []) {
    const resolution = resolveLUTProfile({
      title: 'Sony technical LUT',
      sourceName,
      comments,
    })
    if (resolution.kind !== 'recommended') {
      throw new Error(`Expected ${sourceName} to recommend a contract`)
    }
    return resolution.recommendations
  }

  it('recommends input profiles from comments and file names', () => {
    expect(
      recommendationsFor('Client Display Look.cube', [
        'Input: display referred sRGB',
      ])[0]?.id,
    ).toBe('display-srgb')
    expect(
      recommendationsFor('FLog2C_to_CLASSIC-Neg_VLog.cube', [
        'LUMIXPHOTOSTYLE VLOG',
      ]),
    ).toContainEqual(expect.objectContaining({ id: 'panasonic-vgamut-vlog' }))
  })

  it('annotates Rec.709, bare BT.709 and BT.1886 outputs as full-range gamma 2.4', () => {
    for (const sourceName of [
      'SLog3_SGamut3Cine_to_Rec709.cube',
      'SLog3_SGamut3Cine_BT709.cube',
      'SLog3_SGamut3Cine_BT.1886.cube',
    ]) {
      expect(recommendationsFor(sourceName)).toContainEqual(
        expect.objectContaining({
          id: 'sony-sgamut3cine-slog3',
          role: 'combined-look-output',
          outputGamut: 'srgb-rec709',
          outputTransfer: 'gamma24',
          outputRange: 'full',
        }),
      )
    }
  })

  it('annotates to-Linear and to-V-Log outputs as technical with an unknown range', () => {
    expect(
      recommendationsFor('SLog3_SGamut3Cine_to_Linear.cube'),
    ).toContainEqual(
      expect.objectContaining({
        id: 'sony-sgamut3cine-slog3',
        role: 'technical-output',
        outputTransfer: 'linear',
        outputRange: 'unknown',
      }),
    )
    const toVLog = recommendationsFor('SLog3_SGamut3Cine_to_VLog.cube')
    expect(toVLog).toContainEqual(
      expect.objectContaining({
        id: 'sony-sgamut3cine-slog3',
        outputRange: 'unknown',
      }),
    )
    expect(toVLog).not.toContainEqual(
      expect.objectContaining({ id: 'panasonic-vgamut-vlog' }),
    )
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

describe('lUT structured input profile ids', () => {
  function resolveInputProfile(inputProfile: string) {
    return resolveLUTProfile({
      title: 'Trusted LUT',
      comments: [
        `LUMAFORGE_INPUT_PROFILE=${inputProfile}`,
        ...V_LOG_TO_REC709_METADATA.slice(1),
      ],
    })
  }

  it('confirms registry profile ids and registry aliases', () => {
    for (const inputProfile of [
      'panasonic-vgamut-vlog',
      'Panasonic VLog',
      'V-Gamut V-Log',
    ]) {
      expect(resolveInputProfile(inputProfile)).toMatchObject({
        kind: 'confirmed',
        confidence: 'metadata',
        profile: {
          id: 'panasonic-vgamut-vlog',
          inputGamut: 'v-gamut',
          inputTransfer: 'v-log',
        },
      })
    }
  })

  it('does not confirm the retired binary input profile names', () => {
    for (const inputProfile of ['v-log', 'vlog', 'V-Log input']) {
      expect(resolveInputProfile(inputProfile).kind).not.toBe('confirmed')
    }
  })

  it('confirms an explicit input gamut and transfer without a profile id', () => {
    expect(
      resolveLUTProfile({
        title: 'Trusted LUT',
        comments: [
          'LUMAFORGE_INPUT_GAMUT=v-gamut',
          'LUMAFORGE_INPUT_TRANSFER=v-log',
          'LUMAFORGE_INPUT_RANGE=full',
          ...V_LOG_TO_REC709_METADATA.slice(1),
        ],
      }),
    ).toMatchObject({
      kind: 'confirmed',
      profile: { inputGamut: 'v-gamut', inputTransfer: 'v-log' },
    })
  })
})
