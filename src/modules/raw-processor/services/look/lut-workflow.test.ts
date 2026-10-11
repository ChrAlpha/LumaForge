import { getLUTColorProfile } from '@lumaforge/luma-color-runtime'
import { describe, expect, it } from 'vitest'

import type { OnlineLUTEntry } from '~/lib/profiles/catalog'

import {
  resolveLUTContractProfile,
  resolveOnlineLUTSourceName,
} from './lut-workflow'

function createOnlineLUTEntry(
  overrides: Partial<OnlineLUTEntry> = {},
): OnlineLUTEntry {
  return {
    id: 'online-lut',
    title: 'Online LUT',
    sourceUrl: 'https://example.com/catalog.json',
    sourceType: 'catalog-entry',
    cube: {
      url: 'https://example.com/luts/client.cube',
      sha256: 'a'.repeat(64),
      bytes: 1024,
    },
    tags: [],
    ...overrides,
  }
}

describe('lut workflow helpers', () => {
  it('passes profile objects through unchanged', () => {
    const profile = getLUTColorProfile('panasonic-vgamut-vlog')!

    expect(resolveLUTContractProfile(profile)).toBe(profile)
  })

  it('resolves registry aliases of a profile to its canonical profile', () => {
    expect(resolveLUTContractProfile('sRGB display')?.id).toBe('display-srgb')
    expect(resolveLUTContractProfile('display_srgb')?.id).toBe('display-srgb')
    expect(resolveLUTContractProfile('Panasonic VLog')?.id).toBe(
      'panasonic-vgamut-vlog',
    )
  })

  it('rejects retired compact names that are not registry ids or aliases', () => {
    expect(resolveLUTContractProfile('V-Log input')).toBeUndefined()
    expect(resolveLUTContractProfile('v-log')).toBeUndefined()
    expect(resolveLUTContractProfile('vlog')).toBeUndefined()
  })

  it('resolves explicit profile ids and leaves unknown strings unresolved', () => {
    expect(resolveLUTContractProfile('sony-sgamut3cine-slog3')?.id).toBe(
      'sony-sgamut3cine-slog3',
    )
    expect(resolveLUTContractProfile('unknown-profile-id')).toBeUndefined()
  })

  it('prefers online LUT entry titles as source names', () => {
    expect(
      resolveOnlineLUTSourceName(
        createOnlineLUTEntry({ title: 'Trusted Registry LUT' }),
      ),
    ).toBe('Trusted Registry LUT')
  })

  it('falls back to a filename from the cube URL path', () => {
    expect(
      resolveOnlineLUTSourceName(
        createOnlineLUTEntry({
          title: '',
          cube: {
            url: 'https://example.com/luts/client-look.cube?download=1',
            sha256: '',
          },
        }),
      ),
    ).toBe('client-look.cube')
  })

  it('falls back to the original URL when parsing does not produce a filename', () => {
    expect(
      resolveOnlineLUTSourceName(
        createOnlineLUTEntry({
          title: '',
          cube: {
            url: 'not a url',
            sha256: '',
          },
        }),
      ),
    ).toBe('not a url')
  })
})
