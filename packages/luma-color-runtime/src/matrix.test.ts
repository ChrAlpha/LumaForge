import { describe, expect, it } from 'vitest'

import { getGamutMatrix, mat3Identity } from './matrix'

function expectMatrixClose(
  actual: Float32Array,
  expected: number[],
  precision = 4,
) {
  expect(Array.from(actual)).toHaveLength(expected.length)

  for (const [index, value] of expected.entries()) {
    expect(actual[index]).toBeCloseTo(value, precision)
  }
}

function applyMatrix(matrix: Float32Array, rgb: [number, number, number]) {
  return [
    matrix[0] * rgb[0] + matrix[1] * rgb[1] + matrix[2] * rgb[2],
    matrix[3] * rgb[0] + matrix[4] * rgb[1] + matrix[5] * rgb[2],
    matrix[6] * rgb[0] + matrix[7] * rgb[1] + matrix[8] * rgb[2],
  ] as const
}

describe('gamut matrix registry integration', () => {
  it('matches a known Rec.2020 to Rec.709 linear conversion matrix', () => {
    expectMatrixClose(
      getGamutMatrix('rec2020', 'srgb-rec709'),
      [
        1.660491, -0.587641, -0.07285, -0.12455, 1.1329, -0.008349, -0.018151,
        -0.100579, 1.11873,
      ],
    )
  })

  it('precomputes ProPhoto D50 to target gamut matrices with white adaptation', () => {
    const matrix = getGamutMatrix('prophoto-rgb', 'arri-wide-gamut-4')
    const white = applyMatrix(matrix, [1, 1, 1])

    expect(white[0]).toBeCloseTo(1, 4)
    expect(white[1]).toBeCloseTo(1, 4)
    expect(white[2]).toBeCloseTo(1, 4)
    expect(Array.from(matrix).some((value) => Math.abs(value) > 0.001)).toBe(
      true,
    )
  })

  it('precomputes LUT output gamut to display/export target matrices', () => {
    const matrix = getGamutMatrix('red-wide-gamut-rgb', 'display-p3')

    for (const value of matrix) {
      expect(Number.isFinite(value)).toBe(true)
    }
    expect(Array.from(matrix)).not.toEqual(Array.from(mat3Identity()))
  })

  it('covers stable catalog input and output gamut matrix calculations', () => {
    const catalogInputGamutsWithPublicMath = [
      'arri-wide-gamut-3',
      'display-p3',
      'dji-d-gamut',
      'f-gamut-c',
      'rec2020',
      'red-wide-gamut-rgb',
      's-gamut',
      's-gamut3-cine',
      'srgb-rec709',
      'v-gamut',
    ] as const

    for (const gamut of catalogInputGamutsWithPublicMath) {
      const matrix = getGamutMatrix('prophoto-rgb', gamut)

      expect(Array.from(matrix).every(Number.isFinite), gamut).toBe(true)
    }

    const catalogOutputGamutsWithPublicMath = ['srgb-rec709'] as const

    for (const gamut of catalogOutputGamutsWithPublicMath) {
      const matrix = getGamutMatrix(gamut, 'srgb-rec709')

      expect(Array.from(matrix).every(Number.isFinite), gamut).toBe(true)
    }
  })

  it('refuses a gamut outside the table', () => {
    expect(() =>
      getGamutMatrix('Unknown Input' as never, 'srgb-rec709'),
    ).toThrow('Unknown color gamut: Unknown Input or srgb-rec709')
    expect(() => getGamutMatrix('srgb-rec709', 'toString' as never)).toThrow(
      'Unknown color gamut',
    )
  })
})
