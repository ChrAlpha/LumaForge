import { describe, expect, it } from 'vitest'

import { getFileExtension, isSupportedRaw } from './decoder'

describe('raw shared helpers', () => {
  it('accepts common camera RAW extensions case-insensitively', () => {
    expect(isSupportedRaw(new File(['raw'], 'sony.ARW'))).toBe(true)
    expect(isSupportedRaw('nikon.nef')).toBe(true)
    expect(isSupportedRaw('lut.cube')).toBe(false)
  })

  it('returns lowercase file extensions', () => {
    expect(getFileExtension('Frame.NEF')).toBe('nef')
    expect(getFileExtension('no-extension')).toBe('')
  })
})
