import { describe, expect, it } from 'vitest'

import * as glsl from './glsl'
import { TRANSFER_FUNCTIONS } from './log-encoding'
import {
  M_LMS_TO_OKLAB,
  M_LMS_TO_PROPHOTO,
  M_OKLAB_TO_LMS,
  M_PROPHOTO_TO_LMS,
} from './oklab'
import { LUT_SIZE } from './selective-color'
import { LINEAR_PROPHOTO_LUMINANCE } from './tone'
import * as wgsl from './wgsl'

describe('wGSL color contract', () => {
  it('shares enum values with the existing shader and CPU registry', () => {
    expect(wgsl.LUT_TRANSFER_UNIFORMS).toBe(glsl.LUT_TRANSFER_UNIFORMS)
    expect(wgsl.LUT_RANGE_UNIFORMS).toBe(glsl.LUT_RANGE_UNIFORMS)
    expect(wgsl.LUT_ROLE_UNIFORMS).toBe(glsl.LUT_ROLE_UNIFORMS)
    expect(Object.keys(wgsl.LUT_TRANSFER_UNIFORMS).sort()).toEqual(
      Object.keys(TRANSFER_FUNCTIONS).sort(),
    )
    for (const [uniforms, source, prefix] of [
      [wgsl.LUT_TRANSFER_UNIFORMS, wgsl.LUMA_COLOR_TRANSFER_WGSL, 'TRANSFER'],
      [wgsl.LUT_RANGE_UNIFORMS, wgsl.LUMA_COLOR_RANGE_WGSL, 'LUT_RANGE'],
      [wgsl.LUT_ROLE_UNIFORMS, wgsl.LUMA_COLOR_LUT_WGSL, 'LUT_ROLE'],
    ] as const) {
      for (const [key, value] of Object.entries(uniforms)) {
        const token = key.toUpperCase().replace(/-/g, '_')
        expect(source).toContain(`const ${prefix}_${token}: i32 = ${value};`)
      }
    }
  })

  it('serializes CPU Oklab matrices in shader column-major order', () => {
    for (const [name, matrix] of Object.entries({
      M_PROPHOTO_TO_LMS,
      M_LMS_TO_PROPHOTO,
      M_LMS_TO_OKLAB,
      M_OKLAB_TO_LMS,
    })) {
      const source = wgsl.LUMA_COLOR_OKLAB_WGSL.split(`${name}_W = mat3x3f(`)[1]
      expect(source, name).toBeDefined()
      const columns = [...source.split(');')[0].matchAll(/vec3f\(([^)]+)\)/g)]
      expect(columns).toHaveLength(3)
      columns.forEach((column, col) => {
        expect(column[1].split(',').map(Number)).toEqual([
          matrix[col],
          matrix[col + 3],
          matrix[col + 6],
        ])
      })
    }
    expect(wgsl.LUMA_COLOR_OKLAB_WGSL).toContain(
      'sign(v) * pow(abs(v), vec3f(1.0 / 3.0))',
    )
  })

  it('preserves neutral controls and shares tone and hue-table constants', () => {
    expect(wgsl.LUMA_COLOR_TONE_WGSL).toContain(
      `vec3f(${LINEAR_PROPHOTO_LUMINANCE.join(', ')})`,
    )
    expect(wgsl.LUMA_COLOR_TONE_WGSL).toContain(
      'if (contrastAmount == 0.0) {\n    return exposedSceneLinear;',
    )
    expect(wgsl.LUMA_COLOR_USER_SATURATION_WGSL).toContain(
      'if (saturation == 0.0 && vibrance == 0.0)',
    )
    expect(wgsl.LUMA_COLOR_SELECTIVE_COLOR_WGSL).toContain(
      `fract(hNorm) * ${LUT_SIZE.toFixed(1)}`,
    )
    expect(wgsl.LUMA_COLOR_SELECTIVE_COLOR_WGSL).toContain(
      `(i0 + 1u) % ${LUT_SIZE}u`,
    )
  })

  it('keeps the LUT host ABI and explicit level-zero sampling', () => {
    for (const name of [
      'lutSize',
      'lutDomainMin',
      'lutDomainMax',
      'lutRole',
      'lutInputRange',
      'lutOutputRange',
      'lutInputTransfer',
      'lutOutputTransfer',
      'inputToLutGamut',
      'lutOutputToDisplayGamut',
    ]) {
      expect(wgsl.LUMA_COLOR_LUT_WGSL).toContain(`params.${name}`)
    }
    expect(wgsl.LUMA_COLOR_LUT_WGSL).toContain(
      'textureSampleLevel(lutTexture, lutSampler, lutTextureCoordinate(normalizedColor), 0.0)',
    )
    expect(wgsl.LUMA_COLOR_LUT_WGSL).toContain('1.0 / max(peak, 1.0)')
    expect(wgsl.LUMA_COLOR_LUT_WGSL).not.toContain('1.0 / peak')
    expect(wgsl.LUMA_COLOR_SELECTIVE_COLOR_WGSL).toContain(
      'textureLoad(selectiveColorTexture',
    )
  })
})
