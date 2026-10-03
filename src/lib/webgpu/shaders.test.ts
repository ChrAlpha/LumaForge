import { getLUTColorProfile } from '@lumaforge/luma-color-runtime'
import { describe, expect, it } from 'vitest'

import {
  createProcessShader,
  UNIFORM_BUFFER_STRUCT,
  VERTEX_SHADER,
} from './shaders'
import { getShaderSpecialization } from './specialization'
import { UNIFORM_BUFFER_SIZE, UNIFORM_FIELDS } from './uniform-layout'
import { DEFAULT_PARAMS } from './uniforms'

describe('webGPU display-domain LUT blending', () => {
  it('blends partial-strength display and output LUTs against the unclamped base like export', () => {
    const shader = createProcessShader(true, true)
    // The CPU row-band processor encodes base and styled colors without an
    // upper clamp before the intensity mix; only the final output clamps.
    expect(shader).toContain(
      'mix(editedBaseDisplayExtended, applyDisplayLut(editedBaseSceneLinearProPhoto), intensity)',
    )
    expect(shader).toContain(
      'mix(editedBaseDisplayExtended, applyCombinedOutputLut(editedBaseSceneLinearProPhoto), intensity)',
    )
    expect(shader).toContain(
      'return linearToSrgbExtended(displayLinearOutput);',
    )
    expect(shader).toContain('return linearToSrgbExtended(displayLinear);')
    expect(shader).toContain('return vec4f(clamp01v(styledColor), 1.0);')
  })
})

describe('webGPU shader variants', () => {
  it('folds resolved LUT contracts and builtin presets while keeping data and tone live', () => {
    const profile = getLUTColorProfile('display-srgb')!
    const lut = {
      size: 2,
      data: new Float32Array(24),
      domainMin: [0, 0, 0] as [number, number, number],
      domainMax: [1, 1, 1] as [number, number, number],
      inputProfile: 'display-srgb' as const,
      profileResolution: {
        kind: 'confirmed' as const,
        confidence: 'user' as const,
        profile,
      },
    }
    const custom = createProcessShader(
      true,
      false,
      getShaderSpecialization({ ...DEFAULT_PARAMS, styleKind: 'custom' }, lut),
    )
    for (const field of [
      'lutRole',
      'lutInputTransfer',
      'lutOutputTransfer',
      'lutInputRange',
      'lutOutputRange',
    ])
      expect(custom).not.toContain(`params.${field}`)
    for (const field of [
      'lutDomainMin',
      'lutDomainMax',
      'inputToLutGamut',
      'userContrastFactor',
    ])
      expect(custom).toContain(`params.${field}`)
    const builtin = createProcessShader(
      false,
      true,
      getShaderSpecialization(
        { ...DEFAULT_PARAMS, styleKind: 'builtin', builtinPreset: 'warm' },
        null,
      ),
    )
    expect(builtin).not.toContain('params.builtinPreset')
  })

  it('eliminates neutral feature branches while preserving live numeric uniforms', () => {
    const neutral = getShaderSpecialization(DEFAULT_PARAMS, null)
    const code = createProcessShader(true, false, neutral)
    expect(code).not.toContain('params.styleKind')
    expect(code).not.toContain('params.useLut')
    expect(code).not.toContain('params.selectiveColorActive')
    expect(code).not.toContain('params.userSaturation')
    expect(code).not.toContain('params.userVibrance')
    expect(code).toContain('params.userExposureMultiplier')
    expect(code).toContain('params.userContrastFactor')
    expect(code).toContain('params.viewMode')
    expect(code).toContain('params.compareSplit')
    expect(code).toContain('sampleUnfilterableLut(normalizedColor)')
    expect(createProcessShader(true, false)).toContain('params.userSaturation')
    const active = getShaderSpecialization(
      { ...DEFAULT_PARAMS, userSaturation: 20, userVibrance: -30 },
      null,
    )
    expect(createProcessShader(false, true, active)).toContain(
      'params.userSaturation',
    )
    expect(createProcessShader(false, true, active)).toContain(
      'params.userVibrance',
    )
  })
  it('uses explicit float loads and full precision manual LUT interpolation on baseline devices', () => {
    for (const integer of [true, false]) {
      const code = createProcessShader(integer, false)
      expect(code).not.toContain('textureSampleLevel(lutTexture')
      expect(code).not.toContain('textureSampleLevel(inputTexture')
      expect(code).toContain('sampleUnfilterableLut(normalizedColor)')
      expect(code).toContain(integer ? 'texture_2d<u32>' : 'texture_2d<f32>')
    }
    expect(createProcessShader(false, true)).toContain(
      'textureSampleLevel(lutTexture',
    )
    expect(VERTEX_SHADER).toContain('@builtin(vertex_index)')
  })
  it('matches packed field offsets to WGSL alignment and final struct size', () => {
    let offset = 0
    const layout = {
      f32: [4, 4],
      i32: [4, 4],
      vec2f: [8, 8],
      vec3f: [16, 12],
      mat3x3f: [16, 48],
    }
    for (const match of UNIFORM_BUFFER_STRUCT.matchAll(
      /(\w+): (f32|i32|vec2f|vec3f|mat3x3f),/g,
    )) {
      const [, name, type] = match
      const [align, size] = layout[type as keyof typeof layout]
      offset = Math.ceil(offset / align) * align
      if (!name.startsWith('_pad'))
        expect(UNIFORM_FIELDS[name]).toEqual({ offset, type })
      offset += size
    }
    expect(Math.ceil(offset / 16) * 16).toBe(UNIFORM_BUFFER_SIZE)
  })
})
