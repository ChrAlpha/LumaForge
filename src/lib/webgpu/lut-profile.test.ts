import type {
  LUTColorProfile,
  LUTContractResolution,
  LUTData,
} from '@lumaforge/luma-color-runtime'
import {
  getGamutMatrix,
  getLUTColorProfile,
  mat3ToColumnMajor,
  NEUTRAL_USER_COLOR_INTENT,
  parseCubeLUT,
  TIER1_LUT_COLOR_PROFILES,
  toLUTData,
} from '@lumaforge/luma-color-runtime'
import {
  LUT_RANGE_UNIFORMS,
  LUT_ROLE_UNIFORMS,
  LUT_TRANSFER_UNIFORMS,
} from '@lumaforge/luma-color-runtime/wgsl'
import { describe, expect, it } from 'vitest'

import { resolveGpuPreviewLook } from './lut-profile'

function lutData(profileResolution: LUTContractResolution): LUTData {
  const cube = `LUT_3D_SIZE 2\n${'0 0 0\n'.repeat(8)}`
  return { ...toLUTData(parseCubeLUT(cube)), profileResolution }
}

const CUSTOM = {
  styleKind: 'custom',
  builtinPreset: null,
  intensity: 0.37,
  ...NEUTRAL_USER_COLOR_INTENT,
  userExposureEv: 0.5,
} as const

function drawn(profile: LUTColorProfile) {
  const lut = lutData({ kind: 'confirmed', profile, confidence: 'metadata' })
  const look = resolveGpuPreviewLook(CUSTOM, lut)
  expect(look.lut).toBe(lut)
  return look.uniforms
}

const IDENTITY_MATRIX = [1, 0, 0, 0, 1, 0, 0, 0, 1]

describe('webGPU LUT uniforms', () => {
  it.each(
    TIER1_LUT_COLOR_PROFILES.filter(
      (profile) => profile.role === 'display-look',
    ),
  )('draws Tier 1 display profile $id in its own transfer', (profile) => {
    const uniforms = drawn(profile)
    expect(uniforms.lutRole).toBe(LUT_ROLE_UNIFORMS['display-look'])
    expect(uniforms.lutInputTransfer).toBe(
      LUT_TRANSFER_UNIFORMS[profile.inputTransfer],
    )
    expect(Array.from(uniforms.lutOutputToDisplayGamut)).toEqual(
      IDENTITY_MATRIX,
    )
  })

  it('keeps a non-sRGB display look transfer on both sides', () => {
    const uniforms = drawn(getLUTColorProfile('rec709-gamma24')!)
    expect(uniforms.lutInputTransfer).toBe(LUT_TRANSFER_UNIFORMS.gamma24)
    expect(uniforms.lutOutputTransfer).toBe(LUT_TRANSFER_UNIFORMS.gamma24)
    expect(uniforms.lutInputRange).toBe(LUT_RANGE_UNIFORMS.full)
    expect(uniforms.lutOutputRange).toBe(LUT_RANGE_UNIFORMS.full)
  })

  it('converts a display look with a declared wide output gamut back to sRGB like export', () => {
    const uniforms = drawn({
      ...getLUTColorProfile('display-srgb')!,
      id: 'test-display-p3-output',
      outputGamut: 'display-p3',
      outputTransfer: 'srgb',
      outputRange: 'full',
    })
    expect(Array.from(uniforms.lutOutputToDisplayGamut)).toEqual(
      Array.from(
        mat3ToColumnMajor(getGamutMatrix('display-p3', 'srgb-rec709')),
      ),
    )
  })

  it('maps a combined output contract to its transfers, role, ranges and input gamut', () => {
    const profile: LUTColorProfile = {
      ...getLUTColorProfile('panasonic-vgamut-vlog')!,
      role: 'combined-look-output',
      inputRange: 'legal',
      outputGamut: 'srgb-rec709',
      outputTransfer: 'bt709',
      outputRange: 'full',
    }
    const uniforms = drawn(profile)
    expect(uniforms).toMatchObject({
      lutRole: LUT_ROLE_UNIFORMS['combined-look-output'],
      lutInputTransfer: LUT_TRANSFER_UNIFORMS['v-log'],
      lutOutputTransfer: LUT_TRANSFER_UNIFORMS.bt709,
      lutInputRange: LUT_RANGE_UNIFORMS.legal,
      lutOutputRange: LUT_RANGE_UNIFORMS.full,
    })
    expect(Array.from(uniforms.inputToLutGamut)).toEqual(
      Array.from(
        mat3ToColumnMajor(getGamutMatrix('prophoto-rgb', profile.inputGamut)),
      ),
    )
    expect(Array.from(uniforms.lutOutputToDisplayGamut)).toEqual(
      IDENTITY_MATRIX,
    )
  })

  it('keeps a built-in preset, which only the WebGPU preview implements', () => {
    expect(
      resolveGpuPreviewLook(
        { ...CUSTOM, styleKind: 'builtin', builtinPreset: 'fade' },
        null,
      ),
    ).toMatchObject({
      look: { styleKind: 'builtin', builtinPreset: 'fade', intensity: 0.37 },
      lut: null,
    })
  })
})
