import { describe, expect, it } from 'vitest'

import {
  UNIFORM_BUFFER_SIZE,
  UNIFORM_FIELDS,
  writeUniformMat3x3f,
} from './uniform-layout'
import { DEFAULT_PARAMS, packUniforms } from './uniforms'

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
