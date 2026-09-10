import type { LUTData, ProcessingParams } from '@lumaforge/luma-color-runtime'
import { getLUTColorProfile } from '@lumaforge/luma-color-runtime'
import { describe, expect, it } from 'vitest'

import {
  getShaderSpecialization,
  getShaderSpecializationKey,
  MAX_SHADER_SPECIALIZATIONS,
  normalizeShaderSpecialization,
} from './specialization'
import { DEFAULT_PARAMS } from './uniforms'

function lut(): LUTData {
  return {
    size: 2,
    data: new Float32Array(24),
    domainMin: [0, 0, 0],
    domainMax: [1, 1, 1],
    inputProfile: 'display-srgb',
    profileResolution: {
      kind: 'confirmed',
      confidence: 'user',
      profile: getLUTColorProfile('display-srgb')!,
    },
  }
}

describe('shader specialization features', () => {
  it('keeps numeric edits and builtin choices out of the cache key', () => {
    const a = getShaderSpecialization(
      {
        ...DEFAULT_PARAMS,
        styleKind: 'builtin',
        builtinPreset: 'warm',
        userSaturation: 1,
      },
      null,
    )
    const b = getShaderSpecialization(
      {
        ...DEFAULT_PARAMS,
        styleKind: 'builtin',
        builtinPreset: 'mono',
        userExposureEv: 2,
        userContrast: 50,
        userSaturation: -90,
        intensity: 0.2,
        viewMode: 'original',
      },
      lut(),
    )
    expect(getShaderSpecializationKey(a)).toBe(getShaderSpecializationKey(b))
    expect(a).toEqual({
      styleKind: 1,
      useLut: false,
      selectiveColorActive: false,
      saturationActive: true,
      vibranceActive: false,
    })
  })

  it('matches f32 neutral saturation and keeps nonneutral values dynamic', () => {
    for (const value of [0, -0, 1e-50, -1e-50]) {
      expect(
        getShaderSpecialization(
          { ...DEFAULT_PARAMS, userSaturation: value, userVibrance: value },
          null,
        ),
      ).toMatchObject({ saturationActive: false, vibranceActive: false })
    }
    for (const value of [1, -1, 1e-20, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(
        getShaderSpecialization(
          { ...DEFAULT_PARAMS, userSaturation: value, userVibrance: value },
          null,
        ),
      ).toMatchObject({ saturationActive: true, vibranceActive: true })
    }
  })

  it('uses the same normalized HSL activation as the texture uploader', () => {
    const selectiveColor = {
      red: { hue: Number.NaN, saturation: 0, lightness: -0 },
    } as NonNullable<ProcessingParams['selectiveColor']>
    expect(
      getShaderSpecialization({ ...DEFAULT_PARAMS, selectiveColor }, null)
        .selectiveColorActive,
    ).toBe(false)
    const active = {
      ...selectiveColor,
      red: { hue: 0, saturation: 0, lightness: 1e-20 },
    }
    expect(
      getShaderSpecialization(
        { ...DEFAULT_PARAMS, selectiveColor: active },
        null,
      ).selectiveColorActive,
    ).toBe(true)
  })

  it('only enables a custom LUT after its contract is renderable', () => {
    const params = { ...DEFAULT_PARAMS, styleKind: 'custom' as const }
    const source = lut()
    expect(getShaderSpecialization(params, source)).toMatchObject({
      styleKind: 2,
      useLut: true,
    })
    for (const profileResolution of [
      { kind: 'unknown' },
      { kind: 'recommended', recommendations: [] },
      { kind: 'unsupported-output', recommendations: [] },
    ] as const) {
      expect(
        getShaderSpecialization(params, {
          ...source,
          profileResolution,
        } as LUTData),
      ).toMatchObject({ styleKind: 0, useLut: false })
    }
    if (source.profileResolution.kind !== 'confirmed')
      throw new Error('Missing fixture contract')
    const incomplete = {
      ...source,
      profileResolution: {
        ...source.profileResolution,
        profile: {
          ...source.profileResolution.profile,
          role: 'technical-output' as const,
          outputTransfer: undefined,
        },
      },
    }
    expect(getShaderSpecialization(params, incomplete)).toMatchObject({
      styleKind: 0,
      useLut: false,
    })
  })

  it('canonicalizes unused flags to at most 24 keys plus generic', () => {
    const keys = new Set<string>()
    for (const styleKind of [0, 1, 2] as const)
      for (const useLut of [false, true])
        for (const selectiveColorActive of [false, true])
          for (const saturationActive of [false, true])
            for (const vibranceActive of [false, true]) {
              const descriptor = {
                styleKind,
                useLut,
                selectiveColorActive,
                saturationActive,
                vibranceActive,
              }
              keys.add(getShaderSpecializationKey(descriptor))
              expect(normalizeShaderSpecialization(descriptor).useLut).toBe(
                styleKind === 2 && useLut,
              )
            }
    expect(keys.size).toBe(MAX_SHADER_SPECIALIZATIONS)
    expect(getShaderSpecializationKey()).toBe('generic')
  })
})
