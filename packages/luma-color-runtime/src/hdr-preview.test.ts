import { describe, expect, it } from 'vitest'

import type { SupportedExportColorGraphDescriptor } from './color-graph'
import { resolveExportColorGraph } from './color-graph'
import {
  encodeHdrPreviewRows,
  HDR_ABOVE_SDR_BASE_SCALE,
  HDR_ABOVE_SDR_HIGH_TINT,
  HDR_ABOVE_SDR_LOW_TINT,
  LUMA_COLOR_HDR_PREVIEW_WGSL,
} from './hdr-preview'
import { HDR_NOMINAL_PEAK_LINEAR } from './hdr-reference'
import { getGamutMatrix } from './matrix'
import { getLUTColorProfile } from './registry'
import {
  createHdrPreviewRowBandProcessor,
  createRowBandProcessor,
} from './row-band-processor'
import { NEUTRAL_USER_COLOR_INTENT } from './user-color-intent'

function srgbByte(linear: number) {
  const value = Math.min(1, Math.max(0, linear))
  const encoded =
    value <= 0.0031308 ? value * 12.92 : 1.055 * value ** (1 / 2.4) - 0.055
  return Math.round(encoded * 255)
}

function srgbLinear(code: number) {
  const encoded = code / 255
  return encoded <= 0.04045
    ? encoded / 12.92
    : ((encoded + 0.055) / 1.055) ** 2.4
}

/** One pixel through the view, from a neutral scene value and its SDR byte. */
function view(name: 'above-sdr' | 'stop-down', scene: number) {
  const out = new Uint8Array(3)
  const sdr = srgbByte(scene)
  encodeHdrPreviewRows(
    Float32Array.of(scene, scene, scene),
    Uint8Array.of(sdr, sdr, sdr),
    name,
    out,
    3,
  )
  return Array.from(out)
}

const graph = (() => {
  const resolved = resolveExportColorGraph({
    ...NEUTRAL_USER_COLOR_INTENT,
    styleKind: 'none',
    builtinPreset: null,
    intensity: 1,
    lut: null,
  })
  if (!resolved.supported) throw new Error(resolved.message)
  return resolved
})()

describe('encodeHdrPreviewRows', () => {
  it('stops the HDR rendition down so its peak lands on SDR white', () => {
    expect(view('stop-down', HDR_NOMINAL_PEAK_LINEAR)).toEqual([255, 255, 255])
    // A highlight past the peak clips there, as the gain map records it.
    expect(view('stop-down', HDR_NOMINAL_PEAK_LINEAR * 2)).toEqual([
      255, 255, 255,
    ])
    const white = srgbByte(1 / HDR_NOMINAL_PEAK_LINEAR)
    expect(view('stop-down', 1)).toEqual([white, white, white])
    expect(view('stop-down', 0)).toEqual([0, 0, 0])
  })

  it('dims the SDR picture to gray and tints only what rises above SDR white', () => {
    // Below SDR white: the SDR picture's luminance, dimmed, no tint.
    const sdr = srgbByte(0.5)
    const gray = srgbByte(HDR_ABOVE_SDR_BASE_SCALE * srgbLinear(sdr))
    expect(view('above-sdr', 0.5)).toEqual([gray, gray, gray])
    // At the nominal peak: the high tint alone.
    expect(view('above-sdr', HDR_NOMINAL_PEAK_LINEAR)).toEqual(
      HDR_ABOVE_SDR_HIGH_TINT.map(srgbByte),
    )
    // One stop above white: the tint, a stop of the way toward the peak.
    const toward = 1 / Math.log2(HDR_NOMINAL_PEAK_LINEAR)
    expect(view('above-sdr', 2)).toEqual(
      HDR_ABOVE_SDR_LOW_TINT.map((low, channel) =>
        srgbByte(low + (HDR_ABOVE_SDR_HIGH_TINT[channel] - low) * toward),
      ),
    )
  })

  it('fades the tint in just above SDR white, with no edge at white', () => {
    const [atWhite] = view('above-sdr', 1)
    const [justAbove] = view('above-sdr', 1.001)
    expect(Math.abs(justAbove - atWhite)).toBeLessThanOrEqual(1)
  })
})

describe('createHdrPreviewRowBandProcessor', () => {
  it('draws each view from the scene and the SDR bytes the export writes', () => {
    const width = 4
    const source = Uint16Array.from(
      { length: width * 3 },
      (_, index) => (index * 5461) % 65_536,
    )
    const sdr = createRowBandProcessor({
      width,
      rowBandRows: 1,
      graph,
    }).processUint16Rows(source, 1)
    const scene = Float32Array.from(source, (value) => value / 65_535)
    for (const name of ['above-sdr', 'stop-down'] as const) {
      const expected = new Uint8Array(scene.length)
      encodeHdrPreviewRows(scene, sdr, name, expected, scene.length)
      const processor = createHdrPreviewRowBandProcessor({
        width,
        rowBandRows: 1,
        graph,
        view: name,
      })
      expect(processor.processUint16Rows(source, 1)).toEqual(expected)
    }
  })

  it('refuses a look without an HDR rendition', () => {
    const lutLook: SupportedExportColorGraphDescriptor = {
      ...graph,
      lutProfile: getLUTColorProfile('display-srgb')!,
    }
    expect(() =>
      createHdrPreviewRowBandProcessor({
        width: 1,
        rowBandRows: 1,
        graph: lutLook,
        view: 'stop-down',
      }),
    ).toThrow('HDR_GAIN_MAP_UNSUPPORTED_PIPELINE')
  })
})

describe('lUMA_COLOR_HDR_PREVIEW_WGSL', () => {
  it('serializes the gamut matrices in shader column-major order', () => {
    for (const [name, matrix] of [
      ['HDR_PROPHOTO_TO_REC2020', getGamutMatrix('prophoto-rgb', 'rec2020')],
      ['HDR_REC2020_TO_SRGB', getGamutMatrix('rec2020', 'srgb-rec709')],
    ] as const) {
      const source = LUMA_COLOR_HDR_PREVIEW_WGSL.split(
        `${name}: mat3x3f = mat3x3f(`,
      )[1]
      expect(source, name).toBeDefined()
      expect(source.split(');')[0].split(',').map(Number)).toEqual(
        [0, 3, 6, 1, 4, 7, 2, 5, 8].map((index) => matrix[index]),
      )
    }
    expect(LUMA_COLOR_HDR_PREVIEW_WGSL).toContain(
      `const HDR_NOMINAL_PEAK: f32 = ${HDR_NOMINAL_PEAK_LINEAR};`,
    )
  })
})
