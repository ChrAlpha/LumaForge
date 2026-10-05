import { describe, expect, it } from 'vitest'

import type { UseOnlineLutSourcesResult } from '../../hooks/useOnlineLutSources'
import {
  buildLutStripItems,
  getAppliedStripEntry,
  getAppliedStripKey,
  humanizeLutFamily,
  isLutEntryApplied,
  resolveAppliedLookTitle,
} from './mobile-lut-strip'

type Entry = UseOnlineLutSourcesResult['state']['entries'][number]
type Resource = UseOnlineLutSourcesResult['state']['resources'][number]

const SHA_A = 'a'.repeat(64)
const SHA_B = 'b'.repeat(64)

function resource(id: string, label: string): Resource {
  return {
    id,
    url: `https://${id}.example.com/catalog.json`,
    type: 'catalog',
    label,
    fromQuery: false,
  }
}

function entry(
  id: string,
  resourceId: string,
  sha256: string,
  extra: Partial<Entry> = {},
): Entry {
  return {
    id,
    resourceId,
    title: id,
    sourceUrl: `https://example.com/${id}.json`,
    sourceType: 'catalog-entry',
    cube: { url: `https://example.com/${id}.cube`, sha256 },
    tags: [],
    ...extra,
  }
}

function kinds(items: ReturnType<typeof buildLutStripItems>) {
  return items.map((item) =>
    item.kind === 'group'
      ? `${item.label ?? '-'}@${item.resourceId}[${item.entries.map((e) => e.entry.id).join(',')}]`
      : item.kind,
  )
}

describe('humanizeLutFamily', () => {
  it('keeps a short first token uppercase and title-cases a longer one', () => {
    expect(humanizeLutFamily('arri-look-library')).toBe('ARRI')
    expect(humanizeLutFamily('fujifilm-film-simulation')).toBe('Fujifilm')
    expect(humanizeLutFamily('FUJIFILM-FILM-SIMULATION')).toBe('Fujifilm')
    expect(humanizeLutFamily('kodak_print')).toBe('Kodak')
    expect(humanizeLutFamily('Print Film')).toBe('Print')
    expect(humanizeLutFamily('sony')).toBe('SONY')
    expect(humanizeLutFamily('3d')).toBe('3D')
  })

  it('has no label for a missing or empty family', () => {
    expect(humanizeLutFamily(undefined)).toBeNull()
    expect(humanizeLutFamily(null)).toBeNull()
    expect(humanizeLutFamily('')).toBeNull()
    expect(humanizeLutFamily('  ')).toBeNull()
    expect(humanizeLutFamily('-')).toBeNull()
  })
})

describe('buildLutStripItems', () => {
  it('orders Original, then every source in source order, then Import', () => {
    const items = buildLutStripItems({
      resources: [resource('one', 'One'), resource('two', 'Two')],
      entries: [
        entry('b1', 'two', SHA_B),
        entry('a1', 'one', SHA_A),
        entry('a2', 'one', SHA_A),
      ],
      applied: null,
    })
    // Family-less entries fall back to their source label.
    expect(kinds(items)).toEqual([
      'original',
      'One@one[a1,a2]',
      'Two@two[b1]',
      'import',
    ])
    // Nothing applied: the Original is.
    expect(items[0]).toMatchObject({ kind: 'original', applied: true })
  })

  it('draws no divider for a lone family-less group, and skips empty sources', () => {
    const items = buildLutStripItems({
      resources: [resource('one', 'One'), resource('empty', 'Empty')],
      entries: [entry('a1', 'one', SHA_A)],
      applied: null,
    })
    expect(kinds(items)).toEqual(['original', '-@one[a1]', 'import'])
  })

  it('groups consecutive entries by their humanized family, one divider each', () => {
    const items = buildLutStripItems({
      resources: [resource('one', 'LumaForge Profiles')],
      entries: [
        entry('a1', 'one', SHA_A, { family: 'arri-look-library' }),
        entry('a2', 'one', SHA_A, { family: 'arri-look-library' }),
        entry('f1', 'one', SHA_A, { family: 'fujifilm-film-simulation' }),
        entry('f2', 'one', SHA_A, { family: 'fujifilm-film-simulation' }),
        entry('n1', 'one', SHA_A),
        // Two slugs that read the same stay one group when they meet.
        entry('a3', 'one', SHA_A, { family: 'arri-legacy' }),
        entry('a4', 'one', SHA_A, { family: 'arri-look-library' }),
      ],
      applied: null,
    })
    expect(kinds(items)).toEqual([
      'original',
      'ARRI@one[a1,a2]',
      'Fujifilm@one[f1,f2]',
      'LumaForge Profiles@one[n1]',
      'ARRI@one[a3,a4]',
      'import',
    ])
    // Keys stay unique when a family label comes back later in the list.
    const keys = items.map((item) => item.key)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('labels a lone group that has a family', () => {
    const items = buildLutStripItems({
      resources: [resource('one', 'LumaForge Profiles')],
      entries: [entry('a1', 'one', SHA_A, { family: 'arri-look-library' })],
      applied: null,
    })
    expect(kinds(items)).toEqual(['original', 'ARRI@one[a1]', 'import'])
  })

  it('titles every entry tile by its catalog title alone', () => {
    const items = buildLutStripItems({
      resources: [resource('one', 'LumaForge Profiles')],
      entries: [
        entry('a1', 'one', SHA_A, {
          family: 'arri-look-library',
          title: 'ARRI 3110 Film A',
        }),
      ],
      applied: { name: '3110 Film A', sha256: SHA_A },
    })
    const group = items[1]
    expect(group.kind === 'group' && group.entries[0]).toEqual({
      key: 'one:a1',
      entry: expect.objectContaining({ title: 'ARRI 3110 Film A' }),
      applied: true,
    })
    expect(getAppliedStripEntry(items)?.entry.title).toBe('ARRI 3110 Film A')
  })

  it('puts the applied file after the Original when no entry matches it', () => {
    const items = buildLutStripItems({
      resources: [resource('one', 'One')],
      entries: [entry('a1', 'one', SHA_A)],
      applied: { name: 'Film', sha256: SHA_B, sourceName: 'film.cube' },
    })
    // The file tile carries its own My file divider, so the catalog
    // after it keeps one too.
    expect(kinds(items)).toEqual([
      'original',
      'custom',
      'One@one[a1]',
      'import',
    ])
    expect(items[0]).toMatchObject({ applied: false })
    expect(items[1]).toMatchObject({ kind: 'custom', title: 'film.cube' })
    expect(getAppliedStripKey(items)).toBe('custom')
  })

  it('marks the catalog entry whose cube hash is the applied one, with no file tile', () => {
    const items = buildLutStripItems({
      resources: [resource('one', 'One')],
      entries: [entry('a1', 'one', SHA_A), entry('b1', 'one', SHA_B)],
      applied: { name: 'B', sha256: SHA_B.toUpperCase() },
    })
    expect(kinds(items)).toEqual(['original', '-@one[a1,b1]', 'import'])
    const group = items[1]
    expect(
      group.kind === 'group' && group.entries.map((e) => e.applied),
    ).toEqual([false, true])
    expect(getAppliedStripKey(items)).toBe('one:b1')
  })
})

describe('isLutEntryApplied', () => {
  it('matches by SHA-256 only', () => {
    const a = entry('a1', 'one', SHA_A)
    expect(isLutEntryApplied(a, { name: 'x', sha256: SHA_A }, null)).toBe(true)
    expect(isLutEntryApplied(a, { name: 'x', sha256: SHA_B }, null)).toBe(false)
    // Same name, no hash on the applied style: not a match.
    expect(isLutEntryApplied(a, { name: 'a1' }, null)).toBe(false)
    expect(isLutEntryApplied(a, null, null)).toBe(false)
  })

  it('matches an entry without a declared hash only through its recorded load', () => {
    const direct = entry('direct', 'one', '', { sourceType: 'direct-cube' })
    const applied = { name: 'direct', sha256: SHA_A }
    expect(isLutEntryApplied(direct, applied, null)).toBe(false)
    expect(
      isLutEntryApplied(direct, applied, { entryId: 'direct', sha256: SHA_A }),
    ).toBe(true)
    expect(
      isLutEntryApplied(direct, applied, { entryId: 'direct', sha256: SHA_B }),
    ).toBe(false)
    expect(
      isLutEntryApplied(direct, applied, { entryId: 'other', sha256: SHA_A }),
    ).toBe(false)
  })
})

describe('resolveAppliedLookTitle', () => {
  const catalog = [
    entry('3110', 'one', SHA_A, { title: 'ARRI 3110 Film A' }),
    entry('direct', 'one', '', {
      sourceType: 'direct-cube',
      title: 'teal.cube',
    }),
  ]

  it('names a catalog look by its catalog title, not the LUT title', () => {
    expect(
      resolveAppliedLookTitle({
        entries: catalog,
        applied: {
          name: '3110 Film A',
          sha256: SHA_A,
          sourceName: '3110 Film A',
        },
      }),
    ).toBe('ARRI 3110 Film A')
    // An entry without a declared hash, through the load the strip made.
    expect(
      resolveAppliedLookTitle({
        entries: [
          entry('direct', 'one', '', {
            sourceType: 'direct-cube',
            title: 'Teal Direct',
          }),
        ],
        applied: { name: 'TEAL', sha256: SHA_B, sourceName: 'teal.cube' },
        loaded: { entryId: 'direct', sha256: SHA_B },
      }),
    ).toBe('Teal Direct')
  })

  it("names the user's file by its file name, else the LUT title", () => {
    expect(
      resolveAppliedLookTitle({
        entries: catalog,
        applied: {
          name: 'Client Look',
          sha256: SHA_B,
          sourceName: 'client-look.cube',
        },
      }),
    ).toBe('client-look.cube')
    expect(
      resolveAppliedLookTitle({
        entries: catalog,
        applied: { name: 'Client Look' },
      }),
    ).toBe('Client Look')
    expect(resolveAppliedLookTitle({ entries: catalog, applied: null })).toBe(
      null,
    )
  })
})
