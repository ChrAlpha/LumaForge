import { describe, expect, it } from 'vitest'

import { groupEntriesByFamily } from './lut-source-grouping'

interface Entry {
  id: string
  family?: string | null
}

describe('groupEntriesByFamily', () => {
  it('groups entries by first-seen family order and keeps the rest in others', () => {
    const entries: Entry[] = [
      { id: 'a', family: 'Kodak' },
      { id: 'b', family: 'Fuji' },
      { id: 'c', family: 'Kodak' },
      { id: 'd' },
      { id: 'e', family: null },
    ]

    const result = groupEntriesByFamily(entries)

    expect(result.families).toEqual([
      { family: 'Kodak', items: [entries[0], entries[2]] },
      { family: 'Fuji', items: [entries[1]] },
    ])
    expect(result.others).toEqual([entries[3], entries[4]])
  })

  it('returns empty groups for an empty input', () => {
    expect(groupEntriesByFamily([])).toEqual({ families: [], others: [] })
  })

  it('treats every entry as ungrouped when no family is set', () => {
    const entries: Entry[] = [{ id: 'a' }, { id: 'b', family: null }]

    expect(groupEntriesByFamily(entries)).toEqual({
      families: [],
      others: entries,
    })
  })

  it('hands back the same entry objects so callers keep their identity', () => {
    const kodak: Entry = { id: 'a', family: 'Kodak' }
    const plain: Entry = { id: 'b' }

    const result = groupEntriesByFamily([kodak, plain])

    expect(result.families[0]?.items[0]).toBe(kodak)
    expect(result.others[0]).toBe(plain)
  })
})
