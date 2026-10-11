import type { SupportedExportColorGraphDescriptor } from '@lumaforge/luma-color-runtime'
import {
  createRowBandProcessor,
  NEUTRAL_SELECTIVE_COLOR,
  resolveExportColorGraph,
} from '@lumaforge/luma-color-runtime'
import { describe, expect, it } from 'vitest'

import { renderCpuPreviewFrame } from './preview-render'

function neutralGraph(): SupportedExportColorGraphDescriptor {
  const g = resolveExportColorGraph({
    styleKind: 'none',
    intensity: 0,
    builtinPreset: null,
    lut: null,
    selectiveColor: NEUTRAL_SELECTIVE_COLOR,
  })
  if (!g.supported) throw new Error('expected supported graph')
  return g
}

describe('renderCpuPreviewFrame', () => {
  it('produces width*height*4 RGBA with alpha=255 and matches row-band RGB output', () => {
    const width = 2
    const height = 2
    const source = new Uint16Array([
      1000, 2000, 3000, 4000, 5000, 6000, 7000, 8000, 9000, 10000, 11000, 12000,
    ])
    const graph = neutralGraph()

    const rgba = renderCpuPreviewFrame({ data: source, width, height, graph })

    expect(rgba).toBeInstanceOf(Uint8ClampedArray)
    expect(rgba.length).toBe(width * height * 4)
    for (let p = 0; p < width * height; p += 1) {
      expect(rgba[p * 4 + 3]).toBe(255)
    }

    const proc = createRowBandProcessor({ width, rowBandRows: height, graph })
    const rgb = proc.processUint16Rows(source, height)
    for (let p = 0; p < width * height; p += 1) {
      expect(rgba[p * 4 + 0]).toBe(rgb[p * 3 + 0])
      expect(rgba[p * 4 + 1]).toBe(rgb[p * 3 + 1])
      expect(rgba[p * 4 + 2]).toBe(rgb[p * 3 + 2])
    }
  })
})
