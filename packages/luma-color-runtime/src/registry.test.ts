import { describe, expect, it } from 'vitest'

import {
  getColorGamut,
  getLUTColorProfile,
  getTransferFunction,
  inferLUTColorProfileHints,
  searchLUTColorProfiles,
  TIER1_LUT_COLOR_PROFILES,
} from './registry'

describe('color registry', () => {
  const expectedTier1Profiles = [
    ['arri-awg4-logc4', 'arri-wide-gamut-4', 'logc4'],
    ['arri-awg3-logc3', 'arri-wide-gamut-3', 'logc3'],
    ['red-rwg-log3g10', 'red-wide-gamut-rgb', 'log3g10'],
    ['nikon-zr-rwg-log3g10', 'red-wide-gamut-rgb', 'log3g10'],
    ['nikon-bt2020-nlog', 'rec2020', 'n-log'],
    ['rec2100-pq', 'rec2020', 'pq'],
    ['rec2100-hlg', 'rec2020', 'hlg'],
    ['sony-sgamut3cine-slog3', 's-gamut3-cine', 's-log3'],
    ['sony-sgamut3-slog3', 's-gamut3', 's-log3'],
    ['sony-sgamut-slog2', 's-gamut', 's-log2'],
    ['canon-cinema-gamut-clog2', 'canon-cinema-gamut', 'canon-log2'],
    ['canon-cinema-gamut-clog3', 'canon-cinema-gamut', 'canon-log3'],
    ['canon-cinema-gamut-clog', 'canon-cinema-gamut', 'canon-log'],
    ['fuji-fgamut-flog', 'f-gamut', 'f-log'],
    ['fuji-fgamut-flog2', 'f-gamut', 'f-log2'],
    ['fuji-fgamutc-flog2c', 'f-gamut-c', 'f-log2c'],
    ['panasonic-vgamut-vlog', 'v-gamut', 'v-log'],
    ['aces-ap1-acescc', 'aces-ap1', 'acescc'],
    ['aces-ap1-acescct', 'aces-ap1', 'acescct'],
    ['display-srgb', 'srgb-rec709', 'srgb'],
    ['rec709-gamma24', 'srgb-rec709', 'gamma24'],
  ] as const

  it('ships the required Tier 1 profile catalog with stable ids', () => {
    expect(TIER1_LUT_COLOR_PROFILES.map((profile) => profile.id)).toEqual(
      expectedTier1Profiles.map(([id]) => id),
    )

    for (const [id, inputGamut, inputTransfer] of expectedTier1Profiles) {
      expect(getLUTColorProfile(id)).toMatchObject({
        id,
        inputGamut,
        inputTransfer,
      })
    }
  })

  it('stores gamut primaries, white points, aliases, and source URLs', () => {
    const awg4 = getColorGamut('arri-wide-gamut-4')

    expect(awg4?.primaries.red).toEqual([0.7347, 0.2653])
    expect(awg4?.whitePoint).toEqual([0.3127, 0.329])
    expect(awg4?.aliases).toContain('ARRI Wide Gamut 4')
    expect(awg4?.source).toMatch(/^https:\/\//)
  })

  it('stores transfer functions with legacy aliases', () => {
    expect(getTransferFunction('S-Log3')?.id).toBe('s-log3')
    expect(getTransferFunction('S-Log3.Cine')?.id).toBe('s-log3')
    expect(getTransferFunction('F-Log2C')?.id).toBe('f-log2c')
    expect(getTransferFunction('Gamma 2.4')?.id).toBe('gamma24')
    expect(getTransferFunction('Rec.709 Gamma 2.4')?.id).toBe('gamma24')
  })

  it('stores color gamuts with legacy aliases', () => {
    expect(getColorGamut('N-Gamut')?.id).toBe('rec2020')
  })

  it('resolves stable catalog LUT contracts backed by public transfer math', () => {
    const publicStableCatalogContracts = [
      ['arri-wide-gamut-3', 'arri-logc3', 'arri-wide-gamut-3', 'logc3'],
      ['display-p3', 'srgb', 'display-p3', 'srgb'],
      ['dji-d-gamut', 'dji-d-log', 'dji-d-gamut', 'dji-d-log'],
      ['fujifilm-f-gamut-c', 'fujifilm-f-log2c', 'f-gamut-c', 'f-log2c'],
      ['leica-l-gamut', 'leica-l-log', 'rec2020', 'l-log'],
      ['rec2020', 'apple-log', 'rec2020', 'apple-log'],
      ['rec2020', 'nikon-n-log', 'rec2020', 'n-log'],
      ['red-wide-gamut-rgb', 'red-log3g10', 'red-wide-gamut-rgb', 'log3g10'],
      ['sony-s-gamut', 'sony-s-log2', 's-gamut', 's-log2'],
      ['sony-s-gamut3-cine', 'sony-s-log3', 's-gamut3-cine', 's-log3'],
      ['v-gamut', 'v-log', 'v-gamut', 'v-log'],
      ['rec709', 'bt1886', 'srgb-rec709', 'gamma24'],
      ['rec709', 'gamma-2-4', 'srgb-rec709', 'gamma24'],
      ['rec709', 'srgb', 'srgb-rec709', 'srgb'],
    ] as const

    for (const [
      catalogGamut,
      catalogTransfer,
      runtimeGamut,
      runtimeTransfer,
    ] of publicStableCatalogContracts) {
      expect(getColorGamut(catalogGamut)?.id, catalogGamut).toBe(runtimeGamut)
      expect(getTransferFunction(catalogTransfer)?.id, catalogTransfer).toBe(
        runtimeTransfer,
      )
    }
  })

  it('keeps stable catalog private curves unresolved until public math exists', () => {
    for (const transfer of [
      'insta360-i-log',
      'om-system-flat',
      'om-system-om-log400',
      'om-system-sdr',
      'om-system-wdr',
    ]) {
      expect(getTransferFunction(transfer), transfer).toBeUndefined()
    }
  })

  it('searches profiles by camera ecosystem, gamut, transfer, and aliases', () => {
    expect(searchLUTColorProfiles('Nikon ZR Log3G10')[0]?.id).toBe(
      'nikon-zr-rwg-log3g10',
    )
    expect(searchLUTColorProfiles('S-Gamut3 Cine SLog3')[0]?.id).toBe(
      'sony-sgamut3cine-slog3',
    )
    expect(searchLUTColorProfiles('gamma 2.4 rec709')[0]?.id).toBe(
      'rec709-gamma24',
    )
  })

  it('infers likely profile hints from LUT titles, filenames, and comments', () => {
    expect(
      inferLUTColorProfileHints({
        title: 'Nikon ZR creative conversion',
        sourceName: 'zr_rwg_log3g10_to_709.cube',
        comments: ['Input: REDWideGamutRGB / Log3G10'],
      })[0]?.id,
    ).toBe('nikon-zr-rwg-log3g10')

    expect(
      inferLUTColorProfileHints({
        title: 'FUJIFILM ETERNA F-Log2 C',
        sourceName: 'FGamutC_FLog2C_to_BT709.cube',
        comments: [],
      })[0]?.id,
    ).toBe('fuji-fgamutc-flog2c')
  })

  it('does not return the full catalog for empty LUT hint text', () => {
    expect(
      inferLUTColorProfileHints({
        title: '  ',
        sourceName: '\t',
        comments: ['', '   '],
      }),
    ).toEqual([])
  })
})
