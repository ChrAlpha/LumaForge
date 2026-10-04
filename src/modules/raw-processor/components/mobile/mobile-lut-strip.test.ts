import { describe, expect, it } from 'vitest'

import type { UseOnlineLutSourcesResult } from '../../hooks/useOnlineLutSources'
import {
  buildLutStripItems,
  getAppliedStripKey,
  isLutEntryApplied,
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
    item.kind === 'source'
      ? `source:${item.resourceId}[${item.entries.map((e) => e.entry.id).join(',')}]`
      : item.kind,
  )
}

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
    expect(kinds(items)).toEqual([
      'original',
      'source:one[a1,a2]',
      'source:two[b1]',
      'import',
    ])
    // Nothing applied: the Original is.
    expect(items[0]).toMatchObject({ kind: 'original', applied: true })
    // Two sources have entries, so each gets its label.
    expect(items[1]).toMatchObject({ labelled: true, label: 'One' })
  })

  it('labels no source when only one has entries, and skips empty sources', () => {
    const items = buildLutStripItems({
      resources: [resource('one', 'One'), resource('empty', 'Empty')],
      entries: [entry('a1', 'one', SHA_A)],
      applied: null,
    })
    expect(kinds(items)).toEqual(['original', 'source:one[a1]', 'import'])
    expect(items[1]).toMatchObject({ labelled: false })
  })

  it('uses the family as eyebrow, else the source label', () => {
    const items = buildLutStripItems({
      resources: [resource('one', 'LumaForge Profiles')],
      entries: [
        entry('a1', 'one', SHA_A, { family: 'Print Film' }),
        entry('a2', 'one', SHA_A),
      ],
      applied: null,
    })
    const source = items[1]
    expect(
      source.kind === 'source' && source.entries.map((e) => e.eyebrow),
    ).toEqual(['Print Film', 'LumaForge Profiles'])
  })

  it('puts the applied file after the Original when no entry matches it', () => {
    const items = buildLutStripItems({
      resources: [resource('one', 'One')],
      entries: [entry('a1', 'one', SHA_A)],
      applied: { name: 'Film', sha256: SHA_B, sourceName: 'film.cube' },
    })
    expect(kinds(items)).toEqual([
      'original',
      'custom',
      'source:one[a1]',
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
    expect(kinds(items)).toEqual(['original', 'source:one[a1,b1]', 'import'])
    const source = items[1]
    expect(
      source.kind === 'source' && source.entries.map((e) => e.applied),
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
