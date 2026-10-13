import { describe, expect, it } from 'vitest'

import type { ProfileSourceResource } from './source-url'
import {
  classifyProfileSourceUrl,
  createLUTResourceShareUrl,
  isProfileTransportUrl,
  parseLUTResourceQuery,
} from './source-url'

describe('profile source URLs', () => {
  it('classifies online profile source resources', () => {
    expect(
      classifyProfileSourceUrl(
        'https://profiles.example.com/channels/stable/catalog.json',
      ),
    ).toBe('catalog')
    expect(
      classifyProfileSourceUrl(
        'https://profiles.example.com/releases/v2026.05.01/catalog.json',
      ),
    ).toBe('catalog')
    expect(
      classifyProfileSourceUrl('https://example.com/lumaforge-profiles.json'),
    ).toBe('catalog')
    expect(
      classifyProfileSourceUrl(
        'https://profiles.example.com/releases/v2026.05.01/entries/org.example.lut.look.json',
      ),
    ).toBe('entry')
    expect(
      classifyProfileSourceUrl(
        'https://example.com/profiles/kodak-2383/manifest.json',
      ),
    ).toBe('entry')
    expect(
      classifyProfileSourceUrl('https://example.com/kodak-2383.cube'),
    ).toBe('cube')
  })

  it.each([
    ['HTTPS', 'https://cdn.example.com/look.cube', true],
    ['localhost HTTP', 'http://localhost:4173/look.cube', true],
    ['loopback IPv4 HTTP', 'http://127.0.0.1:4173/look.cube', true],
    ['loopback IPv6 HTTP', 'http://[::1]:4173/look.cube', true],
    ['remote HTTP', 'http://cdn.example.com/look.cube', false],
    ['a username', 'https://user@cdn.example.com/look.cube', false],
    ['a password', 'https://:secret@cdn.example.com/look.cube', false],
    ['localhost credentials', 'http://user:pass@localhost/look.cube', false],
    ['a query', 'https://cdn.example.com/look.cube?v=2', true],
    ['no extension', 'https://cdn.example.com/blobs/sha256/abc', true],
    ['an unsupported scheme', 'ftp://cdn.example.com/look.cube', false],
    ['a relative path', '/luts/look.cube', false],
    ['an empty value', '', false],
    ['a missing value', undefined, false],
  ])('applies the shared transport rule to %s', (_label, value, expected) => {
    expect(isProfileTransportUrl(value)).toBe(expected)
  })

  it('keeps resource classification separate from the transport rule', () => {
    const extensionless = 'https://cdn.example.com/blobs/sha256/abc'

    expect(isProfileTransportUrl(extensionless)).toBe(true)
    expect(
      parseLUTResourceQuery(`?luts=${encodeURIComponent(extensionless)}`)
        .issues[0]?.code,
    ).toBe('unsupported-resource')
    expect(
      parseLUTResourceQuery(
        `?luts=${encodeURIComponent('http://cdn.example.com/look.cube')}`,
      ).issues[0]?.code,
    ).toBe('unsupported-scheme')
    expect(
      parseLUTResourceQuery(
        `?luts=${encodeURIComponent('https://user@cdn.example.com/look.cube')}`,
      ).issues[0]?.code,
    ).toBe('credentialed-url')
  })

  it('rejects relative source URLs', () => {
    expect(
      parseLUTResourceQuery('?luts=%2Fluts%2Flook.cube').issues[0]?.code,
    ).toBe('invalid-url')
  })

  it('parses repeated luts query params in order and dedupes by normalized URL', () => {
    const result = parseLUTResourceQuery(
      '?luts=https%3A%2F%2Fexample.com%2Flumaforge-profiles.json&luts=https%3A%2F%2Fexample.com%2Fk.cube&luts=https%3A%2F%2Fexample.com%2Fk.cube',
    )

    expect(result.issues).toHaveLength(0)
    expect(result.resources).toHaveLength(2)
    expect(result.resources.map((resource) => resource.type)).toEqual([
      'catalog',
      'cube',
    ])
    expect(result.resources.map((resource) => resource.url)).toEqual([
      'https://example.com/lumaforge-profiles.json',
      'https://example.com/k.cube',
    ])
  })

  it('preserves source URL inner query params', () => {
    const result = parseLUTResourceQuery(
      '?luts=https%3A%2F%2Fcdn.example.com%2Fmanifest.json%3Fv%3D2',
    )

    expect(result.resources[0]?.url).toBe(
      'https://cdn.example.com/manifest.json?v=2',
    )
  })

  it('preserves source URL hash fragments', () => {
    const result = parseLUTResourceQuery(
      '?luts=https%3A%2F%2Fcdn.example.com%2Flook.cube%3Fv%3D2%23film',
    )

    expect(result.resources[0]?.url).toBe(
      'https://cdn.example.com/look.cube?v=2#film',
    )
  })

  it('creates share URLs with only stable luts params', () => {
    const resources: ProfileSourceResource[] = [
      {
        id: 'second',
        url: 'https://example.com/lumaforge-profiles.json',
        type: 'catalog',
        label: 'LumaForge profiles',
        fromQuery: true,
      },
    ]

    expect(createLUTResourceShareUrl('/raw?image=local', resources)).toBe(
      '/raw?luts=https%3A%2F%2Fexample.com%2Flumaforge-profiles.json',
    )
  })

  it('creates share URLs independent of caller resource order', () => {
    const resources: ProfileSourceResource[] = [
      {
        id: 'second',
        url: 'https://example.com/b.cube',
        type: 'cube',
        label: 'B',
        fromQuery: false,
      },
      {
        id: 'first',
        url: 'https://example.com/a.cube',
        type: 'cube',
        label: 'A',
        fromQuery: false,
      },
      {
        id: 'duplicate',
        url: 'https://example.com/b.cube',
        type: 'cube',
        label: 'B duplicate',
        fromQuery: false,
      },
    ]

    const expected =
      '/raw?luts=https%3A%2F%2Fexample.com%2Fa.cube&luts=https%3A%2F%2Fexample.com%2Fb.cube'

    expect(createLUTResourceShareUrl('/raw?image=local', resources)).toBe(
      expected,
    )
    expect(
      createLUTResourceShareUrl('/raw?image=local', [...resources].reverse()),
    ).toBe(expected)
  })
})
