import { describe, expect, it } from 'vitest'

import type { OnlineLutEntryLoadProgress } from '../../hooks/useOnlineLutSources'
import { entryLoadPercent } from './lut-entry-progress'

describe('entryLoadPercent', () => {
  it('reports no percent without progress', () => {
    expect(entryLoadPercent(null)).toBeNull()
  })

  it('reports no percent while the total size is unknown', () => {
    expect(entryLoadPercent({ receivedBytes: 4096 })).toBeNull()
    expect(entryLoadPercent({ receivedBytes: 4096, totalBytes: 0 })).toBeNull()
  })

  it('rounds partial progress to a whole percent', () => {
    expect(entryLoadPercent({ receivedBytes: 0, totalBytes: 1000 })).toBe(0)
    expect(entryLoadPercent({ receivedBytes: 333, totalBytes: 1000 })).toBe(33)
    expect(entryLoadPercent({ receivedBytes: 2, totalBytes: 3 })).toBe(67)
  })

  it('reports a completed download as 100', () => {
    expect(entryLoadPercent({ receivedBytes: 1000, totalBytes: 1000 })).toBe(
      100,
    )
  })

  it('caps a download that outgrows its declared size at 100', () => {
    expect(entryLoadPercent({ receivedBytes: 1500, totalBytes: 1000 })).toBe(
      100,
    )
  })

  it('reads the progress the catalog hook reports', () => {
    const progress: OnlineLutEntryLoadProgress = {
      entryId: 'a',
      receivedBytes: 50,
      totalBytes: 200,
    }
    expect(entryLoadPercent(progress)).toBe(25)
  })
})
