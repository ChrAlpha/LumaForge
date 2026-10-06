import type { ColorGraphIntent } from '@lumaforge/luma-color-runtime'
import {
  NEUTRAL_SELECTIVE_COLOR,
  pickColorGraphIntent,
} from '@lumaforge/luma-color-runtime'
import { describe, expect, expectTypeOf, it } from 'vitest'

import type { GpuPreviewInput } from './contract'
import {
  UNIFORM_BUFFER_SIZE,
  UNIFORM_FIELDS,
  writeUniformMat3x3f,
} from './uniform-layout'
import {
  DEFAULT_GPU_PREVIEW_INPUT,
  DEFAULT_PARAMS,
  gpuPreviewInputParams,
  packGpuPreviewUniforms,
  packUniforms,
} from './uniforms'

function packedBytes(pack: (view: DataView) => void): number[] {
  const data = new ArrayBuffer(UNIFORM_BUFFER_SIZE)
  pack(new DataView(data))
  return [...new Uint8Array(data)]
}

const LOOK: ColorGraphIntent = {
  ...pickColorGraphIntent(DEFAULT_PARAMS),
  styleKind: 'builtin',
  builtinPreset: 'film-soft',
  intensity: 0.37,
  userContrast: 12,
  userSaturation: -8,
}

describe('webGPU uniform ABI', () => {
  it('stores matrix columns at sixteen-byte strides without corrupting padding', () => {
    const data = new ArrayBuffer(UNIFORM_BUFFER_SIZE)
    const view = new DataView(data)
    writeUniformMat3x3f(
      view,
      'inputToLutGamut',
      new Float32Array([1, 2, 3, 4, 5, 6, 7, 8, 9]),
    )
    expect([...new Float32Array(data, 0, 12)]).toEqual([
      1, 2, 3, 0, 4, 5, 6, 0, 7, 8, 9, 0,
    ])
    expect(UNIFORM_BUFFER_SIZE % 16).toBe(0)
  })
  it('packs integer control fields, exposure and neutral adjustments with independent offsets', () => {
    const view = new DataView(new ArrayBuffer(UNIFORM_BUFFER_SIZE))
    packUniforms(
      view,
      {
        ...DEFAULT_PARAMS,
        viewMode: 'processed',
        styleKind: 'builtin',
        builtinPreset: 'mono',
        userExposureEv: 2,
      },
      null,
      4,
      true,
    )
    const f = (name: string) =>
      view.getFloat32(UNIFORM_FIELDS[name].offset, true)
    const i = (name: string) => view.getInt32(UNIFORM_FIELDS[name].offset, true)
    expect(f('rawRenderExposureMultiplier')).toBe(4)
    expect(f('userExposureMultiplier')).toBe(4)
    expect([
      i('viewMode'),
      i('styleKind'),
      i('builtinPreset'),
      i('useLut'),
      i('selectiveColorActive'),
    ]).toEqual([0, 1, 7, 0, 1])
    expect(f('userColorBalanceGain')).toBe(1)
    expect(f('userSaturation')).toBe(0)
  })
})

describe('webGPU preview input', () => {
  it('keeps the legacy default on shader compare until that axis is retired', () => {
    expect(DEFAULT_PARAMS.viewMode).toBe('compare')
    expect(DEFAULT_PARAMS.compareSplit).toBe(0.5)
  })

  it('defaults to the processed output of the app default color', () => {
    expect(DEFAULT_GPU_PREVIEW_INPUT.output).toBe('processed')
    expect(DEFAULT_GPU_PREVIEW_INPUT.color).toEqual(
      pickColorGraphIntent(DEFAULT_PARAMS),
    )
    expect(DEFAULT_GPU_PREVIEW_INPUT.color.intensity).toBe(0.7)
    expect(DEFAULT_GPU_PREVIEW_INPUT.color.selectiveColor).toBe(
      NEUTRAL_SELECTIVE_COLOR,
    )
    expect(Object.isFrozen(DEFAULT_GPU_PREVIEW_INPUT)).toBe(true)
  })

  it('carries color intent apart from the output selection', () => {
    expectTypeOf<keyof GpuPreviewInput>().toEqualTypeOf<'color' | 'output'>()
    expectTypeOf<GpuPreviewInput['color']>().toEqualTypeOf<ColorGraphIntent>()
    expectTypeOf<GpuPreviewInput['color']>().not.toHaveProperty('viewMode')
    expectTypeOf<GpuPreviewInput['color']>().not.toHaveProperty('compareSplit')
  })

  it('packs processed output exactly as the legacy processed params, strength kept continuous', () => {
    const input: GpuPreviewInput = { color: LOOK, output: 'processed' }
    expect(gpuPreviewInputParams(input)).toEqual({
      ...LOOK,
      viewMode: 'processed',
      compareSplit: 0.5,
    })
    const packed = packedBytes((view) =>
      packGpuPreviewUniforms(view, input, null, 2, false),
    )
    expect(packed).toEqual(
      packedBytes((view) =>
        packUniforms(
          view,
          { ...LOOK, viewMode: 'processed', compareSplit: 0.5 },
          null,
          2,
          false,
        ),
      ),
    )
    const view = new DataView(new Uint8Array(packed).buffer)
    expect(view.getInt32(UNIFORM_FIELDS.viewMode.offset, true)).toBe(0)
    expect(view.getFloat32(UNIFORM_FIELDS.intensity.offset, true)).toBe(
      Math.fround(0.37),
    )
  })

  it('selects the technical original without rewriting the color intent', () => {
    const input: GpuPreviewInput = { color: LOOK, output: 'technical-original' }
    const params = gpuPreviewInputParams(input)
    expect(params).toEqual({
      ...LOOK,
      viewMode: 'original',
      compareSplit: 0.5,
    })
    expect(pickColorGraphIntent(params)).toEqual(LOOK)
    const packed = packedBytes((view) =>
      packGpuPreviewUniforms(view, input, null, 2, false),
    )
    expect(packed).toEqual(
      packedBytes((view) =>
        packUniforms(
          view,
          { ...LOOK, viewMode: 'original', compareSplit: 0.5 },
          null,
          2,
          false,
        ),
      ),
    )
    const view = new DataView(new Uint8Array(packed).buffer)
    expect(view.getInt32(UNIFORM_FIELDS.viewMode.offset, true)).toBe(1)
    expect(view.getInt32(UNIFORM_FIELDS.styleKind.offset, true)).toBe(1)
    expect(view.getFloat32(UNIFORM_FIELDS.intensity.offset, true)).toBe(
      Math.fround(0.37),
    )
  })

  it('never selects the shader compare from a preview input', () => {
    for (const output of ['processed', 'technical-original'] as const) {
      expect(gpuPreviewInputParams({ color: LOOK, output }).viewMode).not.toBe(
        'compare',
      )
    }
  })
})
