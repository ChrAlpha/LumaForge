import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { parseCubeLUT, toLUTData } from './cube-parser'
import { applyLUTContractSelection } from './profile-resolution'

function makeCube({
  comments = [],
  mutateEntry,
  size = 2,
  title,
}: {
  comments?: string[]
  mutateEntry?: (input: {
    b: number
    g: number
    index: number
    r: number
    values: [number, number, number]
  }) => [number, number, number]
  size?: number
  title?: string
} = {}) {
  const lines = [
    title ? `TITLE "${title}"` : '',
    ...comments.map((comment) => `# ${comment}`),
    `LUT_3D_SIZE ${size}`,
    '',
  ].filter(Boolean)
  const step = 1 / (size - 1)

  for (let b = 0; b < size; b++) {
    for (let g = 0; g < size; g++) {
      for (let r = 0; r < size; r++) {
        const index = lines.length
        const values = mutateEntry
          ? mutateEntry({
              b,
              g,
              index,
              r,
              values: [r * step, g * step, b * step],
            })
          : [r * step, g * step, b * step]
        lines.push(`${values[0]} ${values[1]} ${values[2]}`)
      }
    }
  }

  return lines.join('\n')
}

describe('cube-parser input profiles', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  afterEach(() => {
    localStorage.clear()
  })

  it('preserves comments and falls back to the source file name for the title', () => {
    const lut = parseCubeLUT(
      makeCube({
        comments: ['Input: display referred sRGB', 'Created for web preview'],
      }),
      { sourceName: 'Client Display Look.cube' },
    )

    expect(lut.title).toBe('Client Display Look')
    expect(lut.sourceName).toBe('Client Display Look.cube')
    expect(lut.comments).toEqual([
      'Input: display referred sRGB',
      'Created for web preview',
    ])
    expect(lut.fingerprint).toEqual(expect.any(String))
    expect(lut.profileResolution).toMatchObject({ kind: 'recommended' })
    if (lut.profileResolution.kind !== 'recommended') {
      throw new Error('Expected the display comment to recommend a contract')
    }
    expect(lut.profileResolution.recommendations[0]?.id).toBe('display-srgb')
    expect(toLUTData(lut).profileResolution).toEqual(lut.profileResolution)
  })

  it('does not force unknown LUTs to a display-sRGB profile resolution', () => {
    const lut = parseCubeLUT(makeCube({ title: 'Client Secret Sauce' }), {
      sourceName: 'unknown-look.cube',
    })

    expect(lut.profileResolution).toEqual({
      kind: 'unknown',
    })
  })

  it('does not resolve LUT contracts from filename or free-form comments', () => {
    const lut = parseCubeLUT(
      makeCube({ comments: ['LUMIXPHOTOSTYLE VLOG'], title: 'Generated' }),
      { sourceName: 'technical-vlog-to-rec709.cube' },
    )

    expect(lut.profileResolution.kind).not.toBe('confirmed')
    expect(lut.profileResolution).not.toMatchObject({
      kind: 'confirmed',
    })
  })

  it('resolves structured metadata as a full input and output contract', () => {
    const lut = parseCubeLUT(
      makeCube({
        title: 'Trusted LUT',
        comments: [
          'LUMAFORGE_INPUT_PROFILE=panasonic-vgamut-vlog',
          'LUMAFORGE_ROLE=combined-look-output',
          'LUMAFORGE_OUTPUT_GAMUT=srgb-rec709',
          'LUMAFORGE_OUTPUT_TRANSFER=bt709',
          'LUMAFORGE_OUTPUT_RANGE=full',
        ],
      }),
      { sourceName: 'renamed-file.cube' },
    )

    expect(lut.profileResolution).toMatchObject({
      kind: 'confirmed',
      confidence: 'metadata',
      profile: {
        inputGamut: 'v-gamut',
        inputTransfer: 'v-log',
        role: 'combined-look-output',
        outputGamut: 'srgb-rec709',
        outputTransfer: 'bt709',
        outputRange: 'full',
      },
    })
  })

  it('does not resolve display-look metadata for non-display input without output fields', () => {
    const lut = parseCubeLUT(
      makeCube({
        title: 'Incomplete Camera LUT',
        comments: [
          'LUMAFORGE_INPUT_PROFILE=panasonic-vgamut-vlog',
          'LUMAFORGE_ROLE=display-look',
        ],
      }),
      { sourceName: 'Panasonic_VLog.cube' },
    )

    expect(lut.profileResolution.kind).not.toBe('confirmed')
    expect(lut.profileResolution).not.toMatchObject({
      kind: 'confirmed',
    })
  })

  it('reapplies a persisted user-selected contract by content fingerprint', () => {
    const first = parseCubeLUT(makeCube(), { sourceName: 'first-name.cube' })

    applyLUTContractSelection(first, {
      role: 'combined-look-output',
      inputProfile: 'panasonic-vgamut-vlog',
      outputGamut: 'srgb-rec709',
      outputTransfer: 'bt709',
      outputRange: 'full',
    })

    const renamed = parseCubeLUT(makeCube(), { sourceName: 'renamed.cube' })

    expect(renamed.fingerprint).toBe(first.fingerprint)
    expect(renamed.profileResolution).toMatchObject({
      kind: 'confirmed',
      confidence: 'persisted-user',
    })
  })

  it('suggests V-Log LUT markers from comments and file names', () => {
    const lut = parseCubeLUT(
      makeCube({ comments: ['LUMIXPHOTOSTYLE VLOG'], title: 'Generated' }),
      { sourceName: 'FLog2C_to_CLASSIC-Neg_VLog.cube' },
    )

    expect(lut.profileResolution).toMatchObject({
      kind: 'recommended',
      recommendations: expect.arrayContaining([
        expect.objectContaining({ id: 'panasonic-vgamut-vlog' }),
      ]),
    })
    expect(toLUTData(lut)).toMatchObject({
      profileResolution: {
        kind: 'recommended',
      },
    })
  })

  it('suggests S-Log3 S-Gamut3.Cine LUTs with Rec.709 output metadata', () => {
    const lut = parseCubeLUT(makeCube({ title: 'Sony technical LUT' }), {
      sourceName: 'SLog3_SGamut3Cine_to_Rec709.cube',
    })

    expect(lut.profileResolution).toMatchObject({
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

  it('does not treat output-side V-Log as Panasonic V-Log input', () => {
    const lut = parseCubeLUT(makeCube({ title: 'Sony technical LUT' }), {
      sourceName: 'SLog3_SGamut3Cine_to_VLog.cube',
    })

    expect(lut.profileResolution).toMatchObject({
      kind: 'recommended',
      recommendations: expect.arrayContaining([
        expect.objectContaining({
          id: 'sony-sgamut3cine-slog3',
          outputRange: 'unknown',
        }),
      ]),
    })
    expect(lut.profileResolution).not.toMatchObject({
      kind: 'confirmed',
      profile: { id: 'panasonic-vgamut-vlog' },
    })
  })

  it('keeps ambiguous output-side V-Log filenames out of high-confidence V-Log input', () => {
    const lut = parseCubeLUT(makeCube({ title: 'Conversion LUT' }), {
      sourceName: 'UnknownCamera_to_VLog.cube',
    })

    expect(lut.profileResolution).not.toMatchObject({
      kind: 'confirmed',
      profile: { id: 'panasonic-vgamut-vlog' },
    })
  })

  it('suggests bare BT.709 and BT.1886 output phrases', () => {
    const bt709 = parseCubeLUT(makeCube({ title: 'Sony technical LUT' }), {
      sourceName: 'SLog3_SGamut3Cine_BT709.cube',
    })
    const bt1886 = parseCubeLUT(makeCube({ title: 'Sony technical LUT' }), {
      sourceName: 'SLog3_SGamut3Cine_BT.1886.cube',
    })

    for (const lut of [bt709, bt1886]) {
      expect(lut.profileResolution).toMatchObject({
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
    }
  })

  it('suggests to Linear output phrases with a supported linear transfer', () => {
    const linear = parseCubeLUT(makeCube({ title: 'Sony technical LUT' }), {
      sourceName: 'SLog3_SGamut3Cine_to_Linear.cube',
    })

    expect(linear.profileResolution).toMatchObject({
      kind: 'recommended',
      recommendations: expect.arrayContaining([
        expect.objectContaining({
          id: 'sony-sgamut3cine-slog3',
          role: 'technical-output',
          outputTransfer: 'linear',
          outputRange: 'unknown',
        }),
      ]),
    })
  })

  it('fails closed for unsupported Cineon output phrases', () => {
    const cineon = parseCubeLUT(makeCube({ title: 'Sony technical LUT' }), {
      sourceName: 'SLog3_SGamut3Cine_to_Cineon.cube',
    })

    expect(cineon.profileResolution.kind).toBe('unsupported-output')
    if (cineon.profileResolution.kind !== 'unsupported-output') {
      throw new Error('Expected Cineon LUT to require profile selection')
    }
    expect(cineon.profileResolution.recommendations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'sony-sgamut3cine-slog3' }),
      ]),
    )
    expect(cineon.profileResolution).not.toMatchObject({
      kind: 'confirmed',
      profile: { outputTransfer: 'gamma24' },
    })
  })

  it('accepts scientific notation in LUT data values', () => {
    const lut = parseCubeLUT(`LUT_3D_SIZE 2
0 0 0
1.0e-5 0 0
0 1E-5 0
0 0 1e-5
0.5 0.5 0.5
1 0 0
0 1 0
0 0 1`)

    expect(lut.data.length).toBe(2 * 2 * 2 * 3)
    expect(lut.data[3]).toBeCloseTo(0.00001)
  })

  it('fingerprints interior LUT content instead of only endpoints', () => {
    const baseCube = makeCube({ size: 3, title: 'Same LUT' })
    const changedInteriorCube = makeCube({
      size: 3,
      title: 'Same LUT',
      mutateEntry: ({ r, g, b, values }) =>
        r === 1 && g === 1 && b === 1
          ? [0.12345, values[1], values[2]]
          : values,
    })
    const options = { sourceName: 'same-name.cube' }

    expect(parseCubeLUT(baseCube, options).fingerprint).not.toBe(
      parseCubeLUT(changedInteriorCube, options).fingerprint,
    )
  })
})
