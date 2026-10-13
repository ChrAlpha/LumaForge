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
  resolveExportColorGraph,
  TIER1_LUT_COLOR_PROFILES,
  toLUTData,
} from '@lumaforge/luma-color-runtime'
import {
  LUT_RANGE_UNIFORMS,
  LUT_ROLE_UNIFORMS,
  LUT_TRANSFER_UNIFORMS,
} from '@lumaforge/luma-color-runtime/wgsl'
import { describe, expect, it } from 'vitest'

import {
  resolveGpuPreviewLook,
  resolveLUTPipelineProfileUniforms,
} from './lut-profile'

function resolved(profile: LUTColorProfile) {
  return {
    kind: 'confirmed' as const,
    profile,
    confidence: 'metadata' as const,
  }
}

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

/** Whether the WebGPU preview draws a custom LUT with this contract. */
function isLUTProfileRenderable(profileResolution: LUTContractResolution) {
  const lut = lutData(profileResolution)
  const drawn = resolveGpuPreviewLook(CUSTOM, lut).lut !== null
  // The preview draws a LUT exactly when export runs it.
  expect(drawn).toBe(resolveExportColorGraph({ ...CUSTOM, lut }).supported)
  return drawn
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

  it('converts a display look with a declared wide output gamut back to sRGB like export', () => {
    const profile: LUTColorProfile = {
      ...getLUTColorProfile('display-srgb')!,
      id: 'test-display-p3-output',
      outputGamut: 'display-p3',
      outputTransfer: 'srgb',
      outputRange: 'full',
    }

    const uniforms = resolveLUTPipelineProfileUniforms(resolved(profile))

    expect(uniforms.lutRole).toBe(LUT_ROLE_UNIFORMS['display-look'])
    expect(Array.from(uniforms.inputToLutGamut)).toEqual(IDENTITY_MATRIX)
    expect(Array.from(uniforms.lutOutputToDisplayGamut)).toEqual(
      Array.from(
        mat3ToColumnMajor(getGamutMatrix('display-p3', 'srgb-rec709')),
      ),
    )
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

  it.each([
    [
      'a linear output',
      { outputTransfer: 'linear' },
      'lut-output-transfer-linear',
    ],
    [
      'an unknown output range',
      { outputRange: 'unknown' },
      'lut-output-range-unknown',
    ],
  ] as const)(
    'does not render a display look with %s, which export refuses',
    (_label, overrides, reason) => {
      const profile = { ...getLUTColorProfile('display-srgb')!, ...overrides }
      expect(isLUTProfileRenderable(resolved(profile))).toBe(false)
      expect(resolveGpuPreviewLook(CUSTOM, lutData(resolved(profile)))).toEqual(
        {
          look: { styleKind: 'none', builtinPreset: null, intensity: 0 },
          lut: null,
          reason,
        },
      )
    },
  )

  it('draws a contract export accepts as selected', () => {
    const lut = lutData(resolved(getLUTColorProfile('display-srgb')!))
    expect(isLUTProfileRenderable(lut.profileResolution)).toBe(true)
    expect(resolveGpuPreviewLook(CUSTOM, lut)).toEqual({
      look: { styleKind: 'custom', builtinPreset: null, intensity: 0.37 },
      lut,
      reason: null,
    })
  })

  it('keeps a built-in preset, which only the WebGPU preview implements', () => {
    expect(
      resolveGpuPreviewLook(
        { ...CUSTOM, styleKind: 'builtin', builtinPreset: 'fade' },
        null,
      ),
    ).toEqual({
      look: { styleKind: 'builtin', builtinPreset: 'fade', intensity: 0.37 },
      lut: null,
      reason: null,
    })
  })

  it('draws no look while the selected LUT is not loaded', () => {
    expect(resolveGpuPreviewLook(CUSTOM, null)).toMatchObject({
      look: { styleKind: 'none' },
      lut: null,
      reason: 'lut-not-loaded',
    })
  })
})
