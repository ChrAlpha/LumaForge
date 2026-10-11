import type { RawRenderExposure } from '@lumaforge/luma-color-runtime'
import {
  createRowBandProcessor,
  exposureMultiplierFromEv,
  NEUTRAL_SELECTIVE_COLOR,
  resolveExportColorGraph,
} from '@lumaforge/luma-color-runtime'
import { describe, expect, it } from 'vitest'

import { renderCpuPreviewFrame } from './preview-render'

function makeExposure(ev: number): RawRenderExposure {
  return { ev, multiplier: exposureMultiplierFromEv(ev), source: 'user' }
}

function buildGraph(
  over: Partial<Parameters<typeof resolveExportColorGraph>[0]>,
) {
  const g = resolveExportColorGraph({
    styleKind: 'none',
    intensity: 0,
    builtinPreset: null,
    lut: null,
    ...over,
    selectiveColor: over.selectiveColor ?? NEUTRAL_SELECTIVE_COLOR,
  })
  if (!g.supported) throw new Error('expected supported graph')
  return g
}

const width = 4
const height = 4
const source = new Uint16Array(width * height * 3)
for (let i = 0; i < source.length; i += 1) source[i] = (i * 911) % 65536

function exportRgb(graph: ReturnType<typeof buildGraph>) {
  const proc = createRowBandProcessor({ width, rowBandRows: height, graph })
  return proc.processUint16Rows(source, height)
}

function assertParity(graph: ReturnType<typeof buildGraph>) {
  const rgba = renderCpuPreviewFrame({ data: source, width, height, graph })
  const rgb = exportRgb(graph)
  for (let p = 0; p < width * height; p += 1) {
    expect(rgba[p * 4 + 0]).toBe(rgb[p * 3 + 0])
    expect(rgba[p * 4 + 1]).toBe(rgb[p * 3 + 1])
    expect(rgba[p * 4 + 2]).toBe(rgb[p * 3 + 2])
  }
}

describe('cPU preview == export parity', () => {
  it('matches with render-exposure < 1', () => {
    assertParity(buildGraph({ rawRenderExposure: makeExposure(-1.5) }))
  })
  it('matches with render-exposure > 1 (highlight clipping)', () => {
    assertParity(buildGraph({ rawRenderExposure: makeExposure(2.5) }))
  })
  it('matches with tone adjustments', () => {
    assertParity(
      buildGraph({ userContrast: 40, userHighlights: -30, userShadows: 25 }),
    )
  })
})
