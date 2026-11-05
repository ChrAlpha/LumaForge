import { describe, expect, it } from 'vitest'

import type {
  ExportColorGraphInput,
  SupportedExportColorGraphDescriptor,
} from './color-graph'
import { resolveExportColorGraph } from './color-graph'
import { generateIdentityLUT, toLUTData } from './cube-parser'
import {
  encodeHdrGainMapRows,
  HDR_GAIN_MAP_ALTERNATE_HEADROOM,
  HDR_GAIN_MAP_LOG2_MAX,
  HDR_GAIN_MAP_LOG2_MIN,
  HDR_GAIN_MAP_NEUTRAL_CODE,
  HDR_GAIN_MAP_OFFSET,
  hdrGainMapLog2FromCode,
  lutHasHdrRendition,
  resolveHdrGainMapSupport,
} from './hdr-gain-map'
import { HDR_NOMINAL_PEAK_LINEAR } from './hdr-reference'
import { logC3Decode, logC3Encode } from './log-encoding'
import { getGamutMatrix } from './matrix'
import type { LUTColorProfile } from './registry'
import { getLUTColorProfile } from './registry'
import {
  createHdrGainMapRowBandProcessor,
  createRowBandProcessor,
} from './row-band-processor'
import type { LUTData } from './types'
import { NEUTRAL_USER_COLOR_INTENT } from './user-color-intent'

function resolvedGraph(
  overrides: Partial<ExportColorGraphInput> = {},
): SupportedExportColorGraphDescriptor {
  const graph = resolveExportColorGraph({
    ...NEUTRAL_USER_COLOR_INTENT,
    styleKind: 'none',
    builtinPreset: null,
    intensity: 1,
    lut: null,
    ...overrides,
  })
  if (!graph.supported) throw new Error(graph.message)
  return graph
}

/** A graph that claims a LUT look; only its profile matters here. */
const lutLookGraph: SupportedExportColorGraphDescriptor = {
  ...resolvedGraph(),
  lutProfile: getLUTColorProfile('display-srgb')!,
}

/** A scene-creative LUT from ARRI LogC3 to LogC3, in ARRI Wide Gamut 3. */
const LOGC3_CREATIVE_PROFILE: LUTColorProfile = {
  ...getLUTColorProfile('arri-awg3-logc3')!,
  role: 'scene-creative',
  outputGamut: 'arri-wide-gamut-3',
  outputTransfer: 'logc3',
  outputRange: 'full',
}

/**
 * A 33-point LogC3 lattice that scales scene light by `gain` (1: identity),
 * confirmed as `profile`.
 */
function logC3Lut(gain: number, profile = LOGC3_CREATIVE_PROFILE): LUTData {
  const lut = toLUTData(generateIdentityLUT(33))
  const data = lut.data.map((code) => logC3Encode(logC3Decode(code) * gain))
  return {
    ...lut,
    data,
    profileResolution: { kind: 'confirmed', confidence: 'user', profile },
  }
}

/** A LUT from Rec.2100 to Rec.2100 in `transfer` that keeps the signal. */
function rec2100IdentityLut(transfer: 'pq' | 'hlg'): LUTData {
  return {
    ...toLUTData(generateIdentityLUT(33)),
    profileResolution: {
      kind: 'confirmed',
      confidence: 'user',
      profile: {
        ...getLUTColorProfile(`rec2100-${transfer}`)!,
        role: 'combined-look-output',
        outputGamut: 'rec2020',
        outputTransfer: transfer,
        outputRange: 'full',
      },
    },
  }
}

function lutGraph(
  lut: LUTData,
  overrides: Partial<ExportColorGraphInput> = {},
): SupportedExportColorGraphDescriptor {
  return resolvedGraph({ styleKind: 'custom', lut, ...overrides })
}

function seededSamples(count: number, seed: number) {
  const samples = new Uint16Array(count)
  let state = seed
  for (let index = 0; index < count; index += 1) {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648
    samples[index] = state % 65_536
  }
  return samples
}

const PROPHOTO_TO_REC2020 = getGamutMatrix('prophoto-rgb', 'rec2020')
const SRGB_TO_REC2020 = getGamutMatrix('srgb-rec709', 'rec2020')

function srgbDecode(code: number) {
  const encoded = code / 255
  return encoded <= 0.04045
    ? encoded / 12.92
    : Math.pow((encoded + 0.055) / 1.055, 2.4)
}

function times(matrix: ArrayLike<number>, rgb: readonly number[]) {
  return [0, 1, 2].map(
    (row) =>
      matrix[row * 3] * rgb[0] +
      matrix[row * 3 + 1] * rgb[1] +
      matrix[row * 3 + 2] * rgb[2],
  )
}

/** What an ISO 21496-1 decoder shows at full headroom, in linear BT.2020. */
function reconstructHdr(sdr: readonly number[], codes: readonly number[]) {
  const base = times(SRGB_TO_REC2020, sdr.map(srgbDecode))
  return base.map(
    (value, channel) =>
      (value + HDR_GAIN_MAP_OFFSET) *
        2 ** hdrGainMapLog2FromCode(codes[channel]) -
      HDR_GAIN_MAP_OFFSET,
  )
}

/** One pixel of linear ProPhoto through the gain-map processor. */
function processPixel(scene: readonly number[], graph = resolvedGraph()) {
  const processor = createHdrGainMapRowBandProcessor({
    width: 1,
    rowBandRows: 1,
    graph,
  })
  const rows = processor.processUint16Rows(
    Uint16Array.from(scene, (value) => Math.round(value * 65_535)),
    1,
  )
  return { sdr: Array.from(rows.sdr), gainMap: Array.from(rows.gainMap) }
}

describe('the gain map range', () => {
  it('codes zero gain exactly and covers every gain the rendition needs', () => {
    expect(Number.isInteger(HDR_GAIN_MAP_NEUTRAL_CODE)).toBe(true)
    expect(hdrGainMapLog2FromCode(HDR_GAIN_MAP_NEUTRAL_CODE)).toBeCloseTo(0, 12)
    expect(HDR_GAIN_MAP_LOG2_MIN).toBeLessThanOrEqual(
      Math.log2(HDR_GAIN_MAP_OFFSET / (1 + HDR_GAIN_MAP_OFFSET)),
    )
    expect(HDR_GAIN_MAP_LOG2_MAX).toBeGreaterThanOrEqual(
      Math.log2(
        (HDR_NOMINAL_PEAK_LINEAR + HDR_GAIN_MAP_OFFSET) / HDR_GAIN_MAP_OFFSET,
      ),
    )
    expect(HDR_GAIN_MAP_ALTERNATE_HEADROOM).toBeCloseTo(
      Math.log2(1000 / 203),
      12,
    )
  })
})

describe('resolveHdrGainMapSupport', () => {
  it('gives a graph without a LUT an HDR rendition', () => {
    expect(resolveHdrGainMapSupport(resolvedGraph())).toEqual({
      supported: true,
    })
  })

  it('gives a scene-creative LUT that outputs camera log an HDR rendition', () => {
    expect(resolveHdrGainMapSupport(lutGraph(logC3Lut(1)))).toEqual({
      supported: true,
    })
  })

  it('refuses a LUT that outputs a display signal', () => {
    const displayOutputs: LUTColorProfile[] = [
      getLUTColorProfile('display-srgb')!,
      { ...LOGC3_CREATIVE_PROFILE, role: 'combined-look-output' },
      { ...LOGC3_CREATIVE_PROFILE, role: 'technical-output' },
      {
        ...LOGC3_CREATIVE_PROFILE,
        outputGamut: 'srgb-rec709',
        outputTransfer: 'gamma24',
      },
    ]
    for (const profile of displayOutputs) {
      expect(lutHasHdrRendition(profile), profile.role).toBe(false)
    }
    expect(resolveHdrGainMapSupport(lutLookGraph)).toEqual({
      supported: false,
      reason: 'lut-display-output',
    })
    expect(
      resolveHdrGainMapSupport(
        lutGraph(
          logC3Lut(1, {
            ...LOGC3_CREATIVE_PROFILE,
            role: 'combined-look-output',
            outputGamut: 'srgb-rec709',
            outputTransfer: 'bt709',
          }),
        ),
      ),
    ).toEqual({ supported: false, reason: 'lut-display-output' })
  })

  it('gives a LUT with an HDR (PQ or HLG) output an HDR rendition', () => {
    for (const transfer of ['pq', 'hlg'] as const) {
      const lut = rec2100IdentityLut(transfer)
      if (lut.profileResolution.kind !== 'confirmed')
        throw new Error('confirmed')
      for (const role of [
        'display-look',
        'scene-creative',
        'technical-output',
        'combined-look-output',
      ] as const) {
        expect(
          lutHasHdrRendition({ ...lut.profileResolution.profile, role }),
        ).toBe(true)
      }
      expect(resolveHdrGainMapSupport(lutGraph(lut))).toEqual({
        supported: true,
      })
    }
  })

  it('refuses an unsupported graph', () => {
    expect(
      resolveHdrGainMapSupport({
        supported: false,
        reason: 'unsupported-pipeline',
        message: 'Built-in presets are not exportable.',
        steps: [],
      }),
    ).toEqual({ supported: false, reason: 'unsupported-pipeline' })
  })
})

describe('createHdrGainMapRowBandProcessor', () => {
  it('writes the SDR bytes the SDR export writes, for any edit', () => {
    const width = 7
    const rows = 5
    const source = seededSamples(width * rows * 3, 20_261_020)
    for (const overrides of [
      {},
      { userExposureEv: 1.5, userContrast: 40 },
      { userHighlights: -60, userShadows: 50, userSaturation: 30 },
      { userTemperature: 25, userTint: -15, userVibrance: 45 },
    ] satisfies Array<Partial<ExportColorGraphInput>>) {
      const graph = resolvedGraph(overrides)
      const sdr = createRowBandProcessor({ width, rowBandRows: rows, graph })
        .processUint16Rows(source, rows)
        .slice()
      const gainMapRows = createHdrGainMapRowBandProcessor({
        width,
        rowBandRows: rows,
        graph,
      }).processUint16Rows(source, rows)

      expect(gainMapRows.sdr).toEqual(sdr)
      expect(gainMapRows.gainMap).toHaveLength(sdr.length)
    }
  })

  it('records no gain for colors the SDR export already shows', () => {
    for (const scene of [
      [0, 0, 0],
      [0.001, 0.001, 0.001],
      [0.18, 0.18, 0.18],
      [0.9, 0.9, 0.9],
    ]) {
      expect(processPixel(scene).gainMap).toEqual([
        HDR_GAIN_MAP_NEUTRAL_CODE,
        HDR_GAIN_MAP_NEUTRAL_CODE,
        HDR_GAIN_MAP_NEUTRAL_CODE,
      ])
    }
  })

  it('lifts highlights above SDR white and clips them at the nominal peak', () => {
    const highlight = processPixel(
      [0.5, 0.5, 0.5],
      resolvedGraph({
        userExposureEv: 2,
      }),
    )
    expect(highlight.sdr).toEqual([255, 255, 255])
    for (const value of reconstructHdr(highlight.sdr, highlight.gainMap)) {
      expect(value).toBeCloseTo(2, 1)
    }

    const beyondPeak = processPixel(
      [1, 1, 1],
      resolvedGraph({
        userExposureEv: 4,
      }),
    )
    for (const value of reconstructHdr(beyondPeak.sdr, beyondPeak.gainMap)) {
      expect(value).toBeGreaterThan(HDR_NOMINAL_PEAK_LINEAR * 0.97)
      expect(value).toBeLessThan(HDR_NOMINAL_PEAK_LINEAR * 1.03)
    }
  })

  it('reconstructs the HDR rendition within half a code step', () => {
    const width = 64
    const graph = resolvedGraph({ userExposureEv: 2.5 })
    const source = seededSamples(width * 3, 7)
    const { sdr, gainMap } = createHdrGainMapRowBandProcessor({
      width,
      rowBandRows: 1,
      graph,
    }).processUint16Rows(source, 1)
    const exposure = 2 ** 2.5
    const halfStep =
      2 ** ((HDR_GAIN_MAP_LOG2_MAX - HDR_GAIN_MAP_LOG2_MIN) / 255 / 2) - 1

    for (let pixel = 0; pixel < width; pixel += 1) {
      const offset = pixel * 3
      const scene = [0, 1, 2].map(
        (channel) => (source[offset + channel] / 65_535) * exposure,
      )
      const expected = times(PROPHOTO_TO_REC2020, scene).map((value) =>
        Math.min(HDR_NOMINAL_PEAK_LINEAR, Math.max(0, value)),
      )
      const reconstructed = reconstructHdr(
        Array.from(sdr.subarray(offset, offset + 3)),
        Array.from(gainMap.subarray(offset, offset + 3)),
      )
      for (let channel = 0; channel < 3; channel += 1) {
        expect(
          Math.abs(reconstructed[channel] - expected[channel]),
        ).toBeLessThanOrEqual(
          (expected[channel] + HDR_GAIN_MAP_OFFSET) * halfStep + 1e-6,
        )
      }
    }
  })

  it('writes the SDR bytes a scene-creative LUT export writes', () => {
    const width = 7
    const rows = 5
    const source = seededSamples(width * rows * 3, 20_261_102)
    for (const graph of [
      lutGraph(logC3Lut(0.5), { intensity: 1, userExposureEv: 1.5 }),
      lutGraph(logC3Lut(2), { intensity: 0.6, userSaturation: 30 }),
    ]) {
      const sdr = createRowBandProcessor({ width, rowBandRows: rows, graph })
        .processUint16Rows(source, rows)
        .slice()
      expect(
        createHdrGainMapRowBandProcessor({
          width,
          rowBandRows: rows,
          graph,
        }).processUint16Rows(source, rows).sdr,
      ).toEqual(sdr)
    }
  })

  it('records the scene a scene-creative LUT look renders', () => {
    const highlight = [0.5, 0.5, 0.5]
    // 3 EV over 0.5: a scene of 4 times SDR white.
    const exposure = { userExposureEv: 3 }
    // An identity log LUT keeps the scene: the same rendition as no LUT.
    const identity = processPixel(
      highlight,
      lutGraph(logC3Lut(1), { intensity: 1, ...exposure }),
    )
    expect(identity).toEqual(processPixel(highlight, resolvedGraph(exposure)))

    // A LUT that takes a stop of scene light halves the HDR highlight.
    const stopDown = processPixel(
      highlight,
      lutGraph(logC3Lut(0.5), { intensity: 1, ...exposure }),
    )
    expect(stopDown.sdr).toEqual([255, 255, 255])
    for (const value of reconstructHdr(stopDown.sdr, stopDown.gainMap)) {
      expect(value).toBeCloseTo(2, 1)
    }

    // The look strength mixes the LUT's scene with the edited one.
    const halfStrength = processPixel(
      highlight,
      lutGraph(logC3Lut(0.5), { intensity: 0.5, ...exposure }),
    )
    for (const value of reconstructHdr(
      halfStrength.sdr,
      halfStrength.gainMap,
    )) {
      expect(value).toBeCloseTo(3, 1)
    }

    // At zero strength the rendition is the edited scene's.
    expect(
      processPixel(
        highlight,
        lutGraph(logC3Lut(0.5), { intensity: 0, ...exposure }),
      ),
    ).toEqual(processPixel(highlight, resolvedGraph(exposure)))
  })

  it('rolls an HDR LUT output off into the SDR picture and keeps its light', () => {
    const graph = lutGraph(rec2100IdentityLut('pq'), { intensity: 1 })
    // Below the knee the SDR picture is the light itself: the export
    // without a look.
    const midtone = [0.2, 0.15, 0.1]
    expect(processPixel(midtone, graph).sdr).toEqual(processPixel(midtone).sdr)

    // One and two times reference white, which the SDR export without a
    // look clips alike; the PQ output's SDR picture keeps them apart below
    // SDR white, and its gain map restores each.
    const pixels = [1, 2].map((ev) => ({
      plain: processPixel(
        [0.5, 0.5, 0.5],
        resolvedGraph({ userExposureEv: ev }),
      ),
      pq: processPixel(
        [0.5, 0.5, 0.5],
        lutGraph(rec2100IdentityLut('pq'), {
          intensity: 1,
          userExposureEv: ev,
        }),
      ),
    }))
    for (const { plain } of pixels) expect(plain.sdr).toEqual([255, 255, 255])
    const [white, twice] = pixels.map(({ pq }) => pq)
    expect(white.sdr[0]).toBeLessThan(twice.sdr[0])
    expect(twice.sdr[0]).toBeLessThan(255)
    for (const value of reconstructHdr(white.sdr, white.gainMap)) {
      expect(value).toBeCloseTo(1, 1)
    }
    for (const value of reconstructHdr(twice.sdr, twice.gainMap)) {
      expect(value).toBeCloseTo(2, 1)
    }
  })

  it('shows an HLG output on its reference display', () => {
    const lut = rec2100IdentityLut('hlg')
    // A LUT that outputs 75% HLG everywhere: HDR Reference White.
    const white = { ...lut, data: lut.data.map(() => 0.75) }
    const pixel = processPixel([0.1, 0.1, 0.1], lutGraph(white))
    for (const value of reconstructHdr(pixel.sdr, pixel.gainMap)) {
      expect(value).toBeCloseTo(1, 1)
    }
    // Reference white sits below SDR white in the SDR picture.
    for (const code of pixel.sdr) {
      expect(code).toBeGreaterThan(225)
      expect(code).toBeLessThan(235)
    }
  })

  it('writes the export without a look for an HDR LUT output at zero strength', () => {
    const width = 7
    const rows = 5
    const source = seededSamples(width * rows * 3, 20_261_105)
    for (const transfer of ['pq', 'hlg'] as const) {
      const edits = { userExposureEv: 2, userSaturation: 20 }
      const lut = lutGraph(rec2100IdentityLut(transfer), {
        intensity: 0,
        ...edits,
      })
      const plain = createHdrGainMapRowBandProcessor({
        width,
        rowBandRows: rows,
        graph: resolvedGraph(edits),
      }).processUint16Rows(source, rows)
      const expected = {
        sdr: plain.sdr.slice(),
        gainMap: plain.gainMap.slice(),
      }
      const rendered = createHdrGainMapRowBandProcessor({
        width,
        rowBandRows: rows,
        graph: lut,
      }).processUint16Rows(source, rows)
      expect(rendered.sdr).toEqual(expected.sdr)
      expect(rendered.gainMap).toEqual(expected.gainMap)
      // The SDR export of the graph writes the gain-map export's primary.
      expect(
        createRowBandProcessor({
          width,
          rowBandRows: rows,
          graph: lut,
        }).processUint16Rows(source, rows),
      ).toEqual(expected.sdr)
    }
  })

  it('refuses a graph without an HDR rendition', () => {
    expect(() =>
      createHdrGainMapRowBandProcessor({
        width: 1,
        rowBandRows: 1,
        graph: lutLookGraph,
      }),
    ).toThrow('HDR_GAIN_MAP_UNSUPPORTED_PIPELINE')
  })

  it('refuses to record a gain that is not a number', () => {
    expect(() =>
      encodeHdrGainMapRows(
        new Float32Array([Number.NaN, 0, 0]),
        new Uint8Array(3),
        new Uint8Array(3),
        3,
      ),
    ).toThrow('HDR_GAIN_MAP_OUT_OF_RANGE')
  })
})
