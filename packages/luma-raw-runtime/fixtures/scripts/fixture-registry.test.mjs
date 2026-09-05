// @vitest-environment node
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import {
  fixtureCachePath,
  readFixtureLock,
  resolveFixtureUrls,
  selectFixtures,
  validateFixtureLock,
} from './fixture-registry.mjs'

const validLock = {
  schemaVersion: 1,
  fixtures: [
    {
      name: 'raw-pixls-iphone-se-dng',
      file: 'raw-pixls-iphone-se.dng',
      url: 'https://raw.pixls.us/data/Apple/iPhone%20SE/A4973FFB-9CBD-4ED8-805D-E30F4AE08A95.dng',
      sha256:
        '7a2a9747a0cb1537007233ce7e8b7233c5ee641d683b7b3da29e22387994a0d7',
      license: 'CC0/public-domain declaration on raw.pixls.us upload flow',
      source: 'raw.pixls.us',
      deviceBrand: 'Apple',
      deviceModel: 'iPhone SE',
      rawFamily: 'apple-dng',
      purpose: 'ci-smoke',
    },
    {
      name: 'raw-pixls-pixel-8-pro-dng',
      file: 'raw-pixls-pixel-8-pro.dng',
      url: 'https://raw.pixls.us/data/Google/Pixel%208%20Pro/PXL_20240415_103400204.RAW-02.ORIGINAL.dng',
      sha256:
        '45420c595401547cca950ae58d552bc82b32d31ce1d58c082df33004016197f5',
      license: 'CC0/public-domain declaration on raw.pixls.us upload flow',
      source: 'raw.pixls.us',
      deviceBrand: 'Google',
      deviceModel: 'Pixel 8 Pro',
      rawFamily: 'android-dng',
      purpose: 'local-compatibility',
    },
  ],
}

function lockWithFixture(overrides) {
  return {
    ...validLock,
    fixtures: [{ ...validLock.fixtures[0], ...overrides }],
  }
}

describe('fixture registry', () => {
  it('validates extended public fixture metadata', () => {
    expect(validateFixtureLock(validLock, 'public.lock.json')).toBe(validLock)
  })

  it('selects fixtures by purpose without mutating lockfile', () => {
    expect(selectFixtures(validLock.fixtures, { purpose: 'ci-smoke' })).toEqual([
      validLock.fixtures[0],
    ])
    expect(
      selectFixtures(validLock.fixtures, { purpose: 'local-compatibility' }),
    ).toEqual([validLock.fixtures[1]])

    const selected = selectFixtures(validLock.fixtures, { all: true })
    expect(selected).toEqual(validLock.fixtures)
    expect(selected).not.toBe(validLock.fixtures)
  })

  it('rejects duplicate fixture names', () => {
    const lock = {
      ...validLock,
      fixtures: [
        validLock.fixtures[0],
        { ...validLock.fixtures[1], name: 'raw-pixls-iphone-se-dng' },
      ],
    }

    expect(() => validateFixtureLock(lock, 'public.lock.json')).toThrow(
      'Invalid public fixture lockfile: duplicate fixture name raw-pixls-iphone-se-dng',
    )
  })

  it('rejects duplicate fixture files', () => {
    const lock = {
      ...validLock,
      fixtures: [
        validLock.fixtures[0],
        { ...validLock.fixtures[1], file: 'raw-pixls-iphone-se.dng' },
      ],
    }

    expect(() => validateFixtureLock(lock, 'public.lock.json')).toThrow(
      'Invalid public fixture lockfile: duplicate fixture file raw-pixls-iphone-se.dng',
    )
  })

  it('rejects unknown raw families and purposes', () => {
    expect(() =>
      validateFixtureLock(lockWithFixture({ rawFamily: 'vendor-dng' })),
    ).toThrow(
      'Invalid public fixture lockfile: fixtures[0].rawFamily must be one of apple-dng, apple-proraw-dng, android-dng, generic-dng',
    )

    expect(() =>
      validateFixtureLock(lockWithFixture({ purpose: 'manual' })),
    ).toThrow(
      'Invalid public fixture lockfile: fixtures[0].purpose must be one of ci-smoke, local-compatibility',
    )
  })

  it('builds cache paths under fixture cache dir', () => {
    expect(
      fixtureCachePath('/repo/packages/luma-raw-runtime/fixtures', {
        file: 'raw-pixls-iphone-se.dng',
      }),
    ).toBe(
      '/repo/packages/luma-raw-runtime/fixtures/.cache/public/raw-pixls-iphone-se.dng',
    )
  })

  it('validates the checked-in public fixture lockfile and phone RAW family split', async () => {
    const publicLockPath = fileURLToPath(
      new URL('../public.lock.json', import.meta.url),
    )
    const lock = await readFixtureLock(publicLockPath)

    expect(lock.fixtures.map((fixture) => fixture.name)).toEqual([
      'raw-pixls-iphone-se-dng',
      'raw-pixls-iphone-12-pro-dng',
      'raw-pixls-pixel-8-pro-dng',
      'raw-pixls-galaxy-s23-ultra-dng',
    ])
    expect(lock.fixtures.map((fixture) => fixture.rawFamily)).toEqual([
      'apple-dng',
      'apple-proraw-dng',
      'android-dng',
      'android-dng',
    ])
    expect(selectFixtures(lock.fixtures, { purpose: 'ci-smoke' })).toHaveLength(
      1,
    )
    expect(
      selectFixtures(lock.fixtures, { purpose: 'local-compatibility' }),
    ).toHaveLength(3)
  })
})

describe('fixture mirrors', () => {
  const fixture = validLock.fixtures[0]

  it('accepts and validates optional mirrors', () => {
    const lock = {
      ...validLock,
      fixtures: [{ ...fixture, mirrors: ['https://mirror.example/raw.dng'] }],
    }
    expect(validateFixtureLock(lock).fixtures[0].mirrors).toEqual([
      'https://mirror.example/raw.dng',
    ])
    expect(() =>
      validateFixtureLock({ ...validLock, fixtures: [{ ...fixture, mirrors: ['ftp://x'] }] }),
    ).toThrow(/mirrors\[0\] must use http or https/)
    expect(() =>
      validateFixtureLock({ ...validLock, fixtures: [{ ...fixture, mirrors: 'nope' }] }),
    ).toThrow(/mirrors must be an array/)
  })

  it('orders urls as env mirror, canonical, lockfile mirrors', () => {
    const withMirrors = { ...fixture, mirrors: ['https://mirror.example/raw.dng'] }
    expect(resolveFixtureUrls(withMirrors, {})).toEqual([
      fixture.url,
      'https://mirror.example/raw.dng',
    ])
    expect(
      resolveFixtureUrls(withMirrors, { LUMAFORGE_FIXTURE_MIRROR: 'https://cache.example/fixtures/' }),
    ).toEqual([
      'https://cache.example/fixtures/raw-pixls-iphone-se.dng',
      fixture.url,
      'https://mirror.example/raw.dng',
    ])
  })
})
