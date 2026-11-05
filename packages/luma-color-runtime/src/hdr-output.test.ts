import { describe, expect, it } from 'vitest'

import {
  createHdrDisplayLightDecoder,
  HDR_TO_SDR_KNEE_LINEAR,
  toneMapHdrToSdr,
} from './hdr-output'
import { HDR_NOMINAL_PEAK_LINEAR } from './hdr-reference'
import { hlgEncode, pqEncode } from './log-encoding'
import { getGamutMatrix } from './matrix'

const REC2020_TO_SRGB = getGamutMatrix('rec2020', 'srgb-rec709')

function decode(
  transfer: 'pq' | 'hlg',
  encoded: readonly [number, number, number],
) {
  const out: [number, number, number] = [0, 0, 0]
  createHdrDisplayLightDecoder(transfer, REC2020_TO_SRGB)(...encoded, out)
  return out
}

function toneMap(rgb: readonly [number, number, number]) {
  return toneMapHdrToSdr(rgb[0], rgb[1], rgb[2], [0, 0, 0])
}

describe('createHdrDisplayLightDecoder', () => {
  it('reads PQ as absolute light over reference white', () => {
    const white = pqEncode(1)
    for (const value of decode('pq', [white, white, white])) {
      expect(value).toBeCloseTo(1, 6)
    }
    const peak = pqEncode(HDR_NOMINAL_PEAK_LINEAR)
    expect(decode('pq', [peak, white, 0])).toEqual([
      expect.closeTo(HDR_NOMINAL_PEAK_LINEAR, 5),
      expect.closeTo(1, 6),
      0,
    ])
  })

  it('shows HLG on the 1000 cd/m² reference display with system gamma 1.2', () => {
    // 75% HLG is HDR Reference White on that display, within its rounding.
    for (const value of decode('hlg', [0.75, 0.75, 0.75])) {
      expect(value).toBeCloseTo(1, 2)
    }
    // Full signal is the display peak.
    for (const value of decode('hlg', [1, 1, 1])) {
      expect(value).toBeCloseTo(HDR_NOMINAL_PEAK_LINEAR, 4)
    }
    // The OOTF scales a color by its luminance, so it keeps the color's
    // channel ratios, and a stop of scene light is 1.2 stops of display.
    const gray = decode('hlg', [hlgEncode(0.5), hlgEncode(0.5), hlgEncode(0.5)])
    const half = decode('hlg', [
      hlgEncode(0.25),
      hlgEncode(0.25),
      hlgEncode(0.25),
    ])
    expect(gray[0] / half[0]).toBeCloseTo(2 ** 1.2, 5)
    const color = decode('hlg', [hlgEncode(0.6), hlgEncode(0.3), 0])
    expect(color[0] / color[1]).toBeCloseTo(2, 5)
    expect(color[2]).toBe(0)
  })

  it('decodes HLG black as black', () => {
    expect(decode('hlg', [0, 0, 0])).toEqual([0, 0, 0])
  })
})

describe('toneMapHdrToSdr', () => {
  it('passes light up to the knee unchanged', () => {
    expect(HDR_TO_SDR_KNEE_LINEAR).toBeGreaterThan(0.4)
    expect(HDR_TO_SDR_KNEE_LINEAR).toBeLessThan(0.5)
    expect(toneMap([0.18, 0.3, HDR_TO_SDR_KNEE_LINEAR])).toEqual([
      0.18,
      0.3,
      HDR_TO_SDR_KNEE_LINEAR,
    ])
  })

  it('rolls light above the knee off onto SDR white at the nominal peak', () => {
    let previous = HDR_TO_SDR_KNEE_LINEAR
    for (let linear = 0.5; linear <= HDR_NOMINAL_PEAK_LINEAR; linear += 0.25) {
      const [value] = toneMap([linear, 0, 0])
      expect(value).toBeGreaterThan(previous)
      expect(value).toBeLessThan(linear)
      previous = value
    }
    expect(toneMap([1, 1, 1])[0]).toBeCloseTo(0.78, 2)
    expect(toneMap([HDR_NOMINAL_PEAK_LINEAR, 0, 0])[0]).toBeCloseTo(1, 6)
    expect(toneMap([40, 0, 0])[0]).toBeCloseTo(1, 6)
  })

  it('keeps the hue of a color it rolls off', () => {
    const [r, g, b] = toneMap([3, 1.5, 0.3])
    expect(g / r).toBeCloseTo(0.5, 10)
    expect(b / r).toBeCloseTo(0.1, 10)
    expect(Math.max(r, g, b)).toBeLessThanOrEqual(1)
  })
})
