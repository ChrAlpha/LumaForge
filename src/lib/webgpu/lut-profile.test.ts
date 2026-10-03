import type { LUTColorProfile } from '@lumaforge/luma-color-runtime'
import {
  getLUTColorProfile,
  TIER1_LUT_COLOR_PROFILES,
} from '@lumaforge/luma-color-runtime'
import {
  LUT_RANGE_UNIFORMS,
  LUT_ROLE_UNIFORMS,
  LUT_TRANSFER_UNIFORMS,
} from '@lumaforge/luma-color-runtime/wgsl'
import { describe, expect, it } from 'vitest'

import {
  isLUTProfileRenderable,
  resolveLUTPipelineProfileUniforms,
} from './lut-profile'

function resolved(profile: LUTColorProfile) {
  return {
    kind: 'confirmed' as const,
    profile,
    confidence: 'metadata' as const,
  }
}

const IDENTITY_MATRIX = [1, 0, 0, 0, 1, 0, 0, 0, 1]

describe('lUT pipeline profile uniforms', () => {
  it.each(
    TIER1_LUT_COLOR_PROFILES.filter(
      (profile) => profile.role !== 'display-look',
    ),
  )(
    'requires Tier 1 scene profile $id to declare its output contract',
    (profile) => {
      expect(isLUTProfileRenderable(resolved(profile))).toBe(false)
    },
  )

  it.each(
    TIER1_LUT_COLOR_PROFILES.filter(
      (profile) => profile.role === 'display-look',
    ),
  )('keeps Tier 1 display profile $id on the compatibility path', (profile) => {
    const uniforms = resolveLUTPipelineProfileUniforms(resolved(profile))

    expect(uniforms.lutRole).toBe(LUT_ROLE_UNIFORMS['display-look'])
    expect(uniforms.lutInputTransfer).toBe(
      LUT_TRANSFER_UNIFORMS[profile.inputTransfer],
    )
    expect(Array.from(uniforms.inputToLutGamut)).toEqual(IDENTITY_MATRIX)
    expect(Array.from(uniforms.lutOutputToDisplayGamut)).toEqual(
      IDENTITY_MATRIX,
    )
  })

  it('marks bare resolved scene creative profiles as not renderable', () => {
    const profile = getLUTColorProfile('panasonic-vgamut-vlog')
    expect(profile).toBeDefined()

    expect(isLUTProfileRenderable(resolved(profile!))).toBe(false)
  })

  it('maps explicit combined output contracts to transfer, role, range, and non-display matrices', () => {
    const profile = getLUTColorProfile('panasonic-vgamut-vlog')
    expect(profile).toBeDefined()

    const uniforms = resolveLUTPipelineProfileUniforms(
      resolved({
        ...profile!,
        role: 'combined-look-output',
        outputGamut: 'srgb-rec709',
        outputTransfer: 'bt709',
        outputRange: 'full',
      }),
    )

    expect(uniforms.lutRole).toBe(LUT_ROLE_UNIFORMS['combined-look-output'])
    expect(uniforms.lutInputTransfer).toBe(LUT_TRANSFER_UNIFORMS['v-log'])
    expect(uniforms.lutOutputTransfer).toBe(LUT_TRANSFER_UNIFORMS.bt709)
    expect(uniforms.lutInputRange).toBe(LUT_RANGE_UNIFORMS.full)
    expect(uniforms.lutOutputRange).toBe(LUT_RANGE_UNIFORMS.full)
    expect(Array.from(uniforms.inputToLutGamut)).not.toEqual(IDENTITY_MATRIX)
    expect(Array.from(uniforms.lutOutputToDisplayGamut)).toEqual(
      IDENTITY_MATRIX,
    )
  })

  it('marks unresolved profile choices as not renderable', () => {
    const resolution = {
      kind: 'unknown',
    } as const satisfies {
      kind: 'unknown'
    }
    const uniforms = resolveLUTPipelineProfileUniforms(resolution)

    expect(uniforms.lutRole).toBe(LUT_ROLE_UNIFORMS['display-look'])
    expect(uniforms.lutInputTransfer).toBe(LUT_TRANSFER_UNIFORMS.srgb)
    expect(uniforms.lutOutputTransfer).toBe(LUT_TRANSFER_UNIFORMS.srgb)
    expect(isLUTProfileRenderable(resolution)).toBe(false)
    expect(Array.from(uniforms.inputToLutGamut)).toEqual(IDENTITY_MATRIX)
    expect(Array.from(uniforms.lutOutputToDisplayGamut)).toEqual(
      IDENTITY_MATRIX,
    )
  })

  it('preserves non-sRGB display-look transfer and range uniforms', () => {
    const profile = getLUTColorProfile('rec709-gamma24')
    expect(profile).toBeDefined()

    const uniforms = resolveLUTPipelineProfileUniforms(resolved(profile!))

    expect(uniforms.lutRole).toBe(LUT_ROLE_UNIFORMS['display-look'])
    expect(uniforms.lutInputTransfer).toBe(LUT_TRANSFER_UNIFORMS.gamma24)
    expect(uniforms.lutOutputTransfer).toBe(LUT_TRANSFER_UNIFORMS.gamma24)
    expect(uniforms.lutInputRange).toBe(LUT_RANGE_UNIFORMS.full)
    expect(uniforms.lutOutputRange).toBe(LUT_RANGE_UNIFORMS.full)
    expect(Array.from(uniforms.inputToLutGamut)).toEqual(IDENTITY_MATRIX)
  })

  it('maps combined Rec.709 output LUTs through explicit BT.709 output', () => {
    const profile: LUTColorProfile = {
      id: 'test-combined-rec709',
      label: 'Test Combined Rec.709 Output',
      role: 'combined-look-output',
      inputGamut: 'v-gamut',
      inputTransfer: 'v-log',
      inputRange: 'legal',
      outputGamut: 'srgb-rec709',
      outputTransfer: 'bt709',
      outputRange: 'full',
      aliases: [],
    }

    const uniforms = resolveLUTPipelineProfileUniforms(resolved(profile))

    expect(uniforms.lutRole).toBe(LUT_ROLE_UNIFORMS['combined-look-output'])
    expect(uniforms.lutInputTransfer).toBe(LUT_TRANSFER_UNIFORMS['v-log'])
    expect(uniforms.lutOutputTransfer).toBe(LUT_TRANSFER_UNIFORMS.bt709)
    expect(uniforms.lutInputRange).toBe(LUT_RANGE_UNIFORMS.legal)
    expect(uniforms.lutOutputRange).toBe(LUT_RANGE_UNIFORMS.full)
    expect(Array.from(uniforms.lutOutputToDisplayGamut)).toEqual(
      IDENTITY_MATRIX,
    )
  })

  it('maps technical linear LUT outputs to the linear no-op transfer', () => {
    const profile = getLUTColorProfile('sony-sgamut3cine-slog3')
    expect(profile).toBeDefined()

    const uniforms = resolveLUTPipelineProfileUniforms(
      resolved({
        ...profile!,
        role: 'technical-output',
        outputGamut: 's-gamut3-cine',
        outputTransfer: 'linear',
        outputRange: 'full',
      }),
    )

    expect(uniforms.lutRole).toBe(LUT_ROLE_UNIFORMS['technical-output'])
    expect(uniforms.lutInputTransfer).toBe(LUT_TRANSFER_UNIFORMS['s-log3'])
    expect(uniforms.lutOutputTransfer).toBe(LUT_TRANSFER_UNIFORMS.linear)
    expect(uniforms.lutOutputTransfer).not.toBe(LUT_TRANSFER_UNIFORMS['s-log3'])
  })

  it('does not render omitted non-display output contracts', () => {
    const profile = getLUTColorProfile('sony-sgamut3cine-slog3')
    expect(profile).toBeDefined()

    expect(
      isLUTProfileRenderable(
        resolved({
          ...profile!,
          role: 'technical-output',
          outputTransfer: undefined,
        }),
      ),
    ).toBe(false)
    expect(
      isLUTProfileRenderable(
        resolved({
          ...profile!,
          role: 'combined-look-output',
          outputGamut: undefined,
          outputTransfer: undefined,
        }),
      ),
    ).toBe(false)
  })

  it('marks unsupported output resolutions as not renderable', () => {
    expect(
      isLUTProfileRenderable({
        kind: 'unsupported-output',
        recommendations: [],
      }),
    ).toBe(false)
  })
})
