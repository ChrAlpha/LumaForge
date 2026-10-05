import { describe, expect, it } from 'vitest'

import { parseCubeLUT } from '~/lib/lut/cube-parser'

import {
  buildLUTContractSelectionState,
  clampLookIntensity,
  DEFAULT_LOOK_INTENSITY,
  LOOK_INTENSITY_PRESETS,
  toCustomStyle,
} from '../services/look/style-system'

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

  it('keeps a look amount continuous inside 0..1', () => {
    expect(clampLookIntensity(0.62)).toBe(0.62)
    expect(clampLookIntensity(-0.2)).toBe(0)
    expect(clampLookIntensity(1.3)).toBe(1)
    expect(clampLookIntensity(Number.NaN)).toBe(0.7)
  })

  it('asks for input and output contracts on unresolved custom LUT styles', () => {
    const style = toCustomStyle(
      parseCubeLUT(makeCube('Client display sRGB LUT')),
    )

    expect(style.kind).toBe('custom')
    expect(style.warning).toBe(
      'Choose the LUT input and output contract before preview or export.',
    )
    expect(style.lutAsset?.inputProfile).toBe('display-srgb')
    expect(style.lutAsset?.profileResolution?.kind).not.toBe('confirmed')
  })

  it('labels V-Log custom LUT styles with their resolved contract', () => {
    const style = toCustomStyle(
      parseCubeLUT(
        makeCube('Camera LUT', [
          'LUMAFORGE_INPUT_PROFILE=panasonic-vgamut-vlog',
          'LUMAFORGE_ROLE=combined-look-output',
          'LUMAFORGE_OUTPUT_GAMUT=srgb-rec709',
          'LUMAFORGE_OUTPUT_TRANSFER=bt709',
          'LUMAFORGE_OUTPUT_RANGE=full',
        ]),
        {
          sourceName: 'Panasonic_VLog_to_Rec709.cube',
        },
      ),
    )

    expect(style.lutAsset?.inputProfile).toBe('v-log')
    expect(style.warning).toBe(
      'This LUT uses Panasonic V-Gamut / V-Log -> Rec.709 display.',
    )
    expect(style.lutAsset).toMatchObject({
      profileResolution: {
        kind: 'confirmed',
        profile: { id: 'panasonic-vgamut-vlog' },
      },
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
