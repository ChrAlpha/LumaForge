import type {
  ColorGraphIntent,
  LUTColorProfile,
  LUTContractResolution,
  LUTData,
} from '@lumaforge/luma-color-runtime'
import { NEUTRAL_USER_COLOR_INTENT } from '@lumaforge/luma-color-runtime'
import { describe, expect, expectTypeOf, it } from 'vitest'

import { resolveHqPreviewLookRefusal } from './hq-preview-look'

function profile(overrides: Partial<LUTColorProfile> = {}): LUTColorProfile {
  return {
    id: 'test-profile',
    label: 'Test profile',
    role: 'scene-creative',
    inputGamut: 'v-gamut',
    inputTransfer: 'v-log',
    inputRange: 'full',
    outputGamut: 'srgb-rec709',
    outputTransfer: 'srgb',
    outputRange: 'full',
    aliases: [],
    ...overrides,
  }
}

function lut(profileResolution: LUTContractResolution): LUTData {
  return {
    size: 2,
    data: new Float32Array(2 ** 3 * 3),
    domainMin: [0, 0, 0],
    domainMax: [1, 1, 1],
    profileResolution,
  }
}

function intent(styleKind: ColorGraphIntent['styleKind']): ColorGraphIntent {
  return {
    styleKind,
    builtinPreset: null,
    intensity: 1,
    ...NEUTRAL_USER_COLOR_INTENT,
  }
}

describe('resolveHqPreviewLookRefusal', () => {
  it('reads the complete color intent', () => {
    expectTypeOf<
      Parameters<typeof resolveHqPreviewLookRefusal>[0]['intent']
    >().toEqualTypeOf<ColorGraphIntent>()
  })

  it('refuses a LUT the WebGPU preview leaves out', () => {
    expect(
      resolveHqPreviewLookRefusal({
        intent: intent('custom'),
        lut: lut({
          kind: 'confirmed',
          confidence: 'user',
          profile: profile({
            outputGamut: 'rec2020',
            outputTransfer: 'linear',
          }),
        }),
      }),
    ).toBe('lut-output-transfer-linear')
    expect(
      resolveHqPreviewLookRefusal({
        intent: intent('custom'),
        lut: lut({ kind: 'recommended', recommendations: [profile()] }),
      }),
    ).toBe('lut-input-unconfirmed')
    expect(
      resolveHqPreviewLookRefusal({ intent: intent('custom'), lut: null }),
    ).toBe('lut-not-loaded')
  })

  it('accepts a LUT the preview draws, and no look at all', () => {
    expect(
      resolveHqPreviewLookRefusal({
        intent: intent('custom'),
        lut: lut({ kind: 'confirmed', confidence: 'user', profile: profile() }),
      }),
    ).toBeNull()
    expect(
      resolveHqPreviewLookRefusal({ intent: intent('none'), lut: null }),
    ).toBeNull()
  })
})
