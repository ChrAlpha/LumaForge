import { describe, expect, it, vi } from 'vitest'

import { resolveExportColorGraph } from './color-graph'
import {
  generateIdentityLUT,
  parseCubeLUT,
  toLUTData,
  validateLUT,
} from './cube-parser'
import type { LUTColorProfile } from './registry'
import { getLUTColorProfile } from './registry'
import { NEUTRAL_USER_COLOR_INTENT } from './user-color-intent'

const V_LOG_TO_REC709_METADATA = [
  'LUMAFORGE_INPUT_PROFILE=panasonic-vgamut-vlog',
  'LUMAFORGE_ROLE=combined-look-output',
  'LUMAFORGE_OUTPUT_GAMUT=srgb-rec709',
  'LUMAFORGE_OUTPUT_TRANSFER=bt709',
  'LUMAFORGE_OUTPUT_RANGE=full',
]

/** Identity rows in .cube order: red varies fastest, blue slowest. */
function identityRows(size: number): string[] {
  const rows: string[] = []
  const step = 1 / (size - 1)
  for (let b = 0; b < size; b++) {
    for (let g = 0; g < size; g++) {
      for (let r = 0; r < size; r++) {
        rows.push(
          [r * step, g * step, b * step].map((v) => v.toFixed(6)).join(' '),
        )
      }
    }
  }
  return rows
}

/** A .cube laid out the way grading tools export one: header, then rows. */
function cubeText({
  comments = [],
  domainMax,
  domainMin,
  rows,
  size = 2,
  title,
}: {
  comments?: string[]
  domainMax?: string
  domainMin?: string
  rows?: string[]
  size?: number | string
  title?: string
} = {}): string {
  const numericSize = typeof size === 'number' ? size : 2
  return [
    ...comments.map((comment) => `# ${comment}`),
    ...(title === undefined ? [] : [`TITLE "${title}"`]),
    ...(domainMin === undefined ? [] : [`DOMAIN_MIN ${domainMin}`]),
    ...(domainMax === undefined ? [] : [`DOMAIN_MAX ${domainMax}`]),
    `LUT_3D_SIZE ${size}`,
    '',
    ...(rows ?? identityRows(numericSize)),
  ].join('\n')
}

function registryProfile(id: string): LUTColorProfile {
  const profile = getLUTColorProfile(id)
  if (!profile) throw new Error(`Missing registry profile ${id}`)
  return profile
}

describe('parseCubeLUT size and data count', () => {
  it('reads a size-N cube into N^3 RGB triples in file order', () => {
    const lut = parseCubeLUT(cubeText({ size: 3 }))

    expect(lut.size).toBe(3)
    expect(lut.data).toBeInstanceOf(Float32Array)
    expect(lut.data.length).toBe(3 * 3 * 3 * 3)
    // Entry 1 is r=1/2 g=0 b=0; entry 3 is r=0 g=1/2 b=0; entry 9 is b=1/2.
    expect(Array.from(lut.data.subarray(3, 6))).toEqual([0.5, 0, 0])
    expect(Array.from(lut.data.subarray(9, 12))).toEqual([0, 0.5, 0])
    expect(Array.from(lut.data.subarray(27, 30))).toEqual([0, 0, 0.5])
    expect(Array.from(lut.data.subarray(-3))).toEqual([1, 1, 1])
    expect(validateLUT(lut)).toEqual({
      valid: false,
      errors: [
        'Unsupported LUT size: 3. Only 17, 33, and 65 are allowed in phase 1.',
      ],
    })
  })

  it('parses a supported 17-point cube that validates cleanly', () => {
    const lut = parseCubeLUT(cubeText({ size: 17 }))

    expect(lut.data.length).toBe(17 * 17 * 17 * 3)
    expect(validateLUT(lut)).toEqual({ valid: true, errors: [] })
  })

  it('rejects a cube without LUT_3D_SIZE', () => {
    const content = ['TITLE "No Size"', ...identityRows(2)].join('\n')

    expect(() => parseCubeLUT(content)).toThrow(
      'Invalid .cube file: LUT_3D_SIZE not found',
    )
  })

  it('treats a zero or non-integer LUT_3D_SIZE as missing', () => {
    expect(() => parseCubeLUT(cubeText({ size: 0, rows: [] }))).toThrow(
      'LUT_3D_SIZE not found',
    )
    expect(() => parseCubeLUT(cubeText({ size: 'two' }))).toThrow(
      'LUT_3D_SIZE not found',
    )
  })

  it('rejects a cube with fewer rows than size^3 and reports both counts', () => {
    const rows = identityRows(2).slice(0, 7)

    expect(() => parseCubeLUT(cubeText({ rows }))).toThrow(
      'Invalid .cube file: expected 8 entries, got 7',
    )
  })

  it('ignores rows past size^3', () => {
    const rows = [...identityRows(2), '0.25 0.25 0.25', '0.75 0.75 0.75']
    const lut = parseCubeLUT(cubeText({ rows }))

    expect(lut.data.length).toBe(2 * 2 * 2 * 3)
    expect(Array.from(lut.data.subarray(-3))).toEqual([1, 1, 1])
  })

  it('does not count numeric rows that appear before LUT_3D_SIZE', () => {
    const content = [
      '0.5 0.5 0.5',
      'LUT_3D_SIZE 2',
      ...identityRows(2).slice(0, 7),
    ].join('\n')

    expect(() => parseCubeLUT(content)).toThrow('expected 8 entries, got 7')
  })

  it('accepts CRLF line endings, blank lines and interleaved comments', () => {
    const rows = identityRows(2)
    const content = [
      'TITLE "Windows Export"',
      'LUT_3D_SIZE 2',
      '',
      ...rows.slice(0, 4),
      '# halfway',
      '   ',
      ...rows.slice(4),
    ].join('\r\n')
    const lut = parseCubeLUT(content)

    expect(lut.title).toBe('Windows Export')
    expect(lut.comments).toEqual(['halfway'])
    expect(Array.from(lut.data.subarray(-3))).toEqual([1, 1, 1])
  })

  it('skips 1D size and input-range keywords without counting them as rows', () => {
    const content = [
      'LUT_1D_SIZE 1024',
      'LUT_1D_INPUT_RANGE 0.0 1.0',
      'LUT_3D_INPUT_RANGE 0.0 1.0',
      cubeText(),
    ].join('\n')
    const lut = parseCubeLUT(content)

    expect(lut.size).toBe(2)
    expect(lut.data.length).toBe(24)
  })
})

describe('parseCubeLUT DOMAIN', () => {
  it('defaults to the unit domain when DOMAIN lines are absent', () => {
    const lut = parseCubeLUT(cubeText())

    expect(lut.domainMin).toEqual([0, 0, 0])
    expect(lut.domainMax).toEqual([1, 1, 1])
  })

  it('reads per-channel DOMAIN_MIN and DOMAIN_MAX including signed exponents', () => {
    const lut = parseCubeLUT(
      cubeText({
        domainMin: '-0.125 0 -1.5e-1',
        domainMax: '1.5 2E0 +4.0',
      }),
    )

    expect(lut.domainMin).toEqual([-0.125, 0, -0.15])
    expect(lut.domainMax).toEqual([1.5, 2, 4])
    expect(toLUTData(lut)).toMatchObject({
      domainMin: [-0.125, 0, -0.15],
      domainMax: [1.5, 2, 4],
    })
  })

  it('keeps the default domain when a DOMAIN line is malformed', () => {
    const lut = parseCubeLUT(
      cubeText({ domainMin: '0 0', domainMax: 'one one one' }),
    )

    expect(lut.domainMin).toEqual([0, 0, 0])
    expect(lut.domainMax).toEqual([1, 1, 1])
  })

  it('reads DOMAIN lines that follow LUT_3D_SIZE', () => {
    const content = [
      'LUT_3D_SIZE 2',
      'DOMAIN_MIN 0 0 0',
      'DOMAIN_MAX 4 4 4',
      ...identityRows(2),
    ].join('\n')

    expect(parseCubeLUT(content).domainMax).toEqual([4, 4, 4])
  })
})

describe('parseCubeLUT title and comments', () => {
  it('reads quoted and unquoted TITLE values', () => {
    expect(parseCubeLUT(cubeText({ title: 'Kodak 2383 Print' })).title).toBe(
      'Kodak 2383 Print',
    )
    const unquoted = ['TITLE Plain Name', cubeText()].join('\n')
    expect(parseCubeLUT(unquoted).title).toBe('Plain Name')
  })

  it('falls back to the source name without its .cube extension, then to Untitled LUT', () => {
    const named = parseCubeLUT(cubeText(), { sourceName: 'Teal Orange.CUBE' })
    const emptyTitle = parseCubeLUT(cubeText({ title: '' }), {
      sourceName: 'Empty Title.cube',
    })

    expect(named.title).toBe('Teal Orange')
    expect(named.sourceName).toBe('Teal Orange.CUBE')
    expect(emptyTitle.title).toBe('Empty Title')
    expect(parseCubeLUT(cubeText()).title).toBe('Untitled LUT')
    expect(parseCubeLUT(cubeText()).sourceName).toBeUndefined()
  })

  it('keeps comment text in order and drops markers and empty comments', () => {
    const content = [
      '# Created by Resolve',
      '##   Double marker',
      '#',
      '#    ',
      '#NoSpace',
      cubeText(),
    ].join('\n')

    expect(parseCubeLUT(content).comments).toEqual([
      'Created by Resolve',
      'Double marker',
      'NoSpace',
    ])
  })

  it('fingerprints content, not the source name', () => {
    const content = cubeText({ title: 'Same Look' })
    const first = parseCubeLUT(content, { sourceName: 'first.cube' })
    const renamed = parseCubeLUT(content, { sourceName: 'renamed.cube' })
    const recommented = parseCubeLUT(
      cubeText({ title: 'Same Look', comments: ['edited'] }),
      { sourceName: 'first.cube' },
    )

    const interiorRows = identityRows(3)
    interiorRows[13] = '0.123450 0.500000 0.500000'
    const interior = parseCubeLUT(
      cubeText({ title: 'Same Look', size: 3, rows: interiorRows }),
    )

    expect(first.fingerprint).toMatch(/^lut-[0-9a-z]+$/)
    expect(renamed.fingerprint).toBe(first.fingerprint)
    expect(recommented.fingerprint).not.toBe(first.fingerprint)
    expect(interior.fingerprint).not.toBe(
      parseCubeLUT(cubeText({ title: 'Same Look', size: 3 })).fingerprint,
    )
  })
})

describe('parseCubeLUT numeric rows', () => {
  it('accepts signed, leading-dot and exponent forms', () => {
    const rows = identityRows(2)
    rows[1] = '+.5 -0.25 1.0e-5'
    rows[2] = '5. 1E+1 -2e-2'
    const lut = parseCubeLUT(cubeText({ rows }))

    expect(lut.data[3]).toBe(0.5)
    expect(lut.data[4]).toBe(-0.25)
    expect(lut.data[5]).toBeCloseTo(1e-5, 10)
    expect(Array.from(lut.data.subarray(6, 9))).toEqual([
      5,
      10,
      Math.fround(-0.02),
    ])
  })

  it('reads the first three values of a row with trailing tokens', () => {
    const rows = identityRows(2)
    rows[1] = '0.5 0.25 0.125 # inline note'
    rows[2] = '0.1 0.2 0.3 0.4'
    const lut = parseCubeLUT(cubeText({ rows }))

    expect(Array.from(lut.data.subarray(3, 6))).toEqual([0.5, 0.25, 0.125])
    expect(Array.from(lut.data.subarray(6, 9))).toEqual(
      [0.1, 0.2, 0.3].map(Math.fround),
    )
  })

  it.each([
    ['a non-numeric token', '0.5 abc 0.5'],
    ['a two-value row', '0.5 0.5'],
    ['a number glued to letters', '0.5 0.5 0.5abc'],
    ['a hexadecimal value', '0x1 0 0'],
    ['comma separators', '0.5,0.5,0.5'],
    ['a NaN token', 'NaN 0 0'],
    ['an Infinity token', 'Infinity 0 0'],
  ])('skips a row with %s, so the cube comes up one entry short', (_, row) => {
    const rows = identityRows(2)
    rows[3] = row

    expect(() => parseCubeLUT(cubeText({ rows }))).toThrow(
      'Invalid .cube file: expected 8 entries, got 7',
    )
  })

  it('lets a skipped malformed row be backfilled by a trailing extra row', () => {
    const rows = [...identityRows(2), '0.25 0.25 0.25']
    rows.splice(3, 1, 'not a row')
    const lut = parseCubeLUT(cubeText({ rows }))

    expect(Array.from(lut.data.subarray(-3))).toEqual([0.25, 0.25, 0.25])
  })
})

describe('parseCubeLUT non-finite values', () => {
  it('parses overflowing exponents to Infinity and leaves rejection to validateLUT', () => {
    const rows = identityRows(17)
    rows[0] = '1e999 0 0'
    rows[1] = '1e39 0 0'
    const lut = parseCubeLUT(cubeText({ rows, size: 17 }))

    expect(lut.data[0]).toBe(Number.POSITIVE_INFINITY)
    // 1e39 is finite as a double but exceeds float32 range.
    expect(lut.data[3]).toBe(Number.POSITIVE_INFINITY)
    expect(validateLUT(lut)).toEqual({
      valid: false,
      errors: ['Invalid value at index 0: Infinity'],
    })
  })

  it('accepts negative and above-one values as finite data', () => {
    const rows = identityRows(17)
    rows[0] = '-0.05 1.25 0'
    const lut = parseCubeLUT(cubeText({ rows, size: 17 }))

    expect(Array.from(lut.data.subarray(0, 3))).toEqual([
      Math.fround(-0.05),
      1.25,
      0,
    ])
    expect(validateLUT(lut).valid).toBe(true)
  })
})

describe('parseCubeLUT profile metadata', () => {
  it('confirms a full structured contract from LUMAFORGE_ comments', () => {
    const lookupStoredProfile = vi.fn(() => registryProfile('display-srgb'))
    const lut = parseCubeLUT(
      cubeText({ title: 'Trusted', comments: V_LOG_TO_REC709_METADATA }),
      { sourceName: 'renamed.cube', lookupStoredProfile },
    )

    expect(lut.profileResolution).toMatchObject({
      kind: 'confirmed',
      confidence: 'metadata',
      profile: {
        inputGamut: 'v-gamut',
        inputTransfer: 'v-log',
        role: 'combined-look-output',
        outputGamut: 'srgb-rec709',
        outputTransfer: 'bt709',
        outputRange: 'full',
      },
    })
    expect(lookupStoredProfile).not.toHaveBeenCalled()
  })

  it('parses an incomplete contract but leaves it unconfirmed', () => {
    const lut = parseCubeLUT(
      cubeText({
        title: 'Incomplete',
        comments: [
          'LUMAFORGE_INPUT_PROFILE=panasonic-vgamut-vlog',
          'LUMAFORGE_ROLE=display-look',
        ],
      }),
    )

    expect(lut.data.length).toBe(24)
    expect(lut.profileResolution.kind).not.toBe('confirmed')
  })

  it('resolves an unmarked cube as unknown', () => {
    const lut = parseCubeLUT(cubeText({ title: 'Client Look' }), {
      sourceName: 'client-look.cube',
    })

    expect(lut.profileResolution).toEqual({ kind: 'unknown' })
  })

  it('looks up a stored contract by the content fingerprint', () => {
    const stored = registryProfile('sony-sgamut3cine-slog3')
    const lookupStoredProfile = vi.fn(() => stored)
    const lut = parseCubeLUT(cubeText({ title: 'Stored' }), {
      sourceName: 'stored.cube',
      lookupStoredProfile,
    })

    expect(lookupStoredProfile).toHaveBeenCalledWith(lut.fingerprint)
    expect(lut.profileResolution).toEqual({
      kind: 'confirmed',
      confidence: 'persisted-user',
      profile: stored,
    })
  })

  it('recommends but does not confirm a profile named only in the file name', () => {
    const lut = parseCubeLUT(cubeText({ title: 'Generated' }), {
      sourceName: 'SLog3_SGamut3Cine_to_Rec709.cube',
    })

    expect(lut.profileResolution).toMatchObject({
      kind: 'recommended',
      recommendations: expect.arrayContaining([
        expect.objectContaining({ id: 'sony-sgamut3cine-slog3' }),
      ]),
    })
  })
})

describe('toLUTData', () => {
  it('projects the parsed LUT onto the runtime LUT data contract', () => {
    const lut = parseCubeLUT(
      cubeText({
        title: 'Projected',
        comments: V_LOG_TO_REC709_METADATA,
        domainMax: '2 2 2',
      }),
      { sourceName: 'projected.cube' },
    )
    const data = toLUTData(lut)

    expect(data).toMatchObject({
      size: 2,
      data: lut.data,
      domainMin: [0, 0, 0],
      domainMax: [2, 2, 2],
      title: 'Projected',
      profileResolution: lut.profileResolution,
    })
    expect(data.data).toBe(lut.data)
    expect(data).not.toHaveProperty('comments')
    expect(data).not.toHaveProperty('fingerprint')
  })
})

describe('lUT contract carrier', () => {
  it('carries the contract only as the profile resolution', () => {
    const parsed = [
      parseCubeLUT(cubeText({ comments: V_LOG_TO_REC709_METADATA })),
      parseCubeLUT(cubeText({ title: 'Client Look' })),
      generateIdentityLUT(2),
    ]

    for (const lut of parsed) {
      expect(lut).not.toHaveProperty('inputProfile')
      expect(toLUTData(lut)).not.toHaveProperty('inputProfile')
    }
  })

  it('lets the export graph read the profile resolution alone', () => {
    const lut = toLUTData(
      parseCubeLUT(cubeText({ comments: V_LOG_TO_REC709_METADATA })),
    )
    const intent = {
      ...NEUTRAL_USER_COLOR_INTENT,
      styleKind: 'custom',
      builtinPreset: null,
      intensity: 1,
    } as const

    expect(resolveExportColorGraph({ ...intent, lut }).supported).toBe(true)
    expect(
      resolveExportColorGraph({
        ...intent,
        lut: { ...lut, profileResolution: { kind: 'unknown' } },
      }),
    ).toMatchObject({ supported: false, reason: 'unsupported-pipeline' })
  })
})
