import { parseCubeLUT } from '@lumaforge/luma-color-runtime'
import { describe, expect, it } from 'vitest'

import {
  buildLUTContractSelectionState,
  DEFAULT_LOOK_INTENSITY,
  LOOK_INTENSITY_PRESETS,
  toCustomStyle,
} from './style-system'

function makeCube(title: string, comments: string[] = []) {
  const lines = [
    `TITLE "${title}"`,
    ...comments.map((comment) => `# ${comment}`),
    'LUT_3D_SIZE 2',
    '0 0 0',
    '1 0 0',
    '0 1 0',
    '1 1 0',
    '0 0 1',
    '1 0 1',
    '0 1 1',
    '1 1 1',
  ].filter(Boolean)

  return lines.join('\n')
}

describe('style-system', () => {
  it('names the strength presets and starts a look at Standard', () => {
    expect(LOOK_INTENSITY_PRESETS).toEqual({
      light: 0.4,
      standard: 0.7,
      strong: 1,
    })
    expect(DEFAULT_LOOK_INTENSITY).toBe(0.7)
    const style = toCustomStyle(parseCubeLUT(makeCube('Any')))
    expect(style).toMatchObject({
      currentIntensity: 0.7,
      defaultIntensity: 0.7,
    })
  })

  it('carries the parsed contract and identity as the LUT asset', () => {
    const lut = parseCubeLUT(
      makeCube('Camera LUT', [
        'LUMAFORGE_INPUT_PROFILE=panasonic-vgamut-vlog',
        'LUMAFORGE_ROLE=combined-look-output',
        'LUMAFORGE_OUTPUT_GAMUT=srgb-rec709',
        'LUMAFORGE_OUTPUT_TRANSFER=bt709',
        'LUMAFORGE_OUTPUT_RANGE=full',
      ]),
      { sourceName: 'Panasonic_VLog_to_Rec709.cube' },
    )

    const style = toCustomStyle(lut, { sha256: 'a'.repeat(64) })

    expect(style.lutAsset).toEqual({
      format: 'cube',
      dimension: 2,
      title: 'Camera LUT',
      profileResolution: lut.profileResolution,
      fingerprint: lut.fingerprint,
      sha256: 'a'.repeat(64),
      sourceName: 'Panasonic_VLog_to_Rec709.cube',
    })
    expect(style.lutAsset.profileResolution).toMatchObject({
      kind: 'confirmed',
      confidence: 'metadata',
      profile: { id: 'panasonic-vgamut-vlog' },
    })
  })

  it('builds an unknown LUT profile selection state for unresolved LUTs', () => {
    const lut = parseCubeLUT(makeCube('Client Secret Sauce'), {
      sourceName: 'unknown-look.cube',
    })

    expect(buildLUTContractSelectionState(lut)).toEqual({
      status: 'unknown',
      fingerprint: lut.fingerprint,
      title: 'Client Secret Sauce',
      sourceName: 'unknown-look.cube',
    })
  })
})
