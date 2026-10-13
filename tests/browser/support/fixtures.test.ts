import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import {
  fixtureCachePath,
  readFixtureLock,
} from '../../../packages/luma-raw-runtime/fixtures/scripts/fixture-registry.mjs'
import {
  gateRawFixture,
  PUBLIC_RAW_FIXTURE_ENV,
  REQUIRE_PRIVATE_FIXTURES_ENV,
  REQUIRE_PUBLIC_FIXTURE_ENV,
  resolvePrivateRawFixture,
  resolvePublicRawFixture,
} from './fixtures'

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url))
const fixturesDir = join(repoRoot, 'packages/luma-raw-runtime/fixtures')
const defaultPath = join(fixturesDir, '.cache/public/raw-pixls-iphone-se.dng')
const only =
  (...paths: string[]) =>
  (path: string) =>
    paths.includes(path)

/** A Playwright `testInfo` whose skip throws, as Playwright's does. */
function fakeTestInfo() {
  const skips: string[] = []
  return {
    skips,
    skip(_condition: boolean, description: string) {
      skips.push(description)
      throw new Error(`skipped: ${description}`)
    },
  }
}

describe('public RAW fixture', () => {
  it('defaults to the locked CI smoke DNG the fetch script caches', async () => {
    const fixture = resolvePublicRawFixture({
      env: {},
      exists: only(defaultPath),
    })
    expect(fixture).toEqual({
      coverage: 'public',
      path: defaultPath,
      ready: true,
      required: false,
      reason: '',
    })
    const lock = await readFixtureLock(join(fixturesDir, 'public.lock.json'))
    const fixtures = lock.fixtures as Array<{ purpose: string; file: string }>
    const smoke = fixtures.filter((fixture) => fixture.purpose === 'ci-smoke')
    expect(
      smoke.map((fixture) => fixtureCachePath(fixturesDir, fixture)),
    ).toContain(defaultPath)
  })

  it('skips a missing default unless its flag requires it', () => {
    for (const [flag, required] of [
      [undefined, false],
      ['0', false],
      ['1', true],
      ['true', true],
    ] as const) {
      const fixture = resolvePublicRawFixture({
        env: { [REQUIRE_PUBLIC_FIXTURE_ENV]: flag },
        exists: only(),
      })
      expect(fixture).toMatchObject({ ready: false, required })
      expect(fixture.reason).toContain(defaultPath)
      expect(fixture.reason).toContain('fixtures:fetch-public')
    }
  })

  it('uses an override, relative to the root, and fails one that is absent', () => {
    const rootDir = resolve('/checkout')
    const named = resolve(rootDir, 'local/SGL_1998.NEF')
    const env = { [PUBLIC_RAW_FIXTURE_ENV]: 'local/SGL_1998.NEF' }
    expect(
      resolvePublicRawFixture({ env, exists: only(named), rootDir }),
    ).toMatchObject({ path: named, ready: true, reason: '' })
    // A mistyped override never falls back to the default that exists.
    const absent = resolvePublicRawFixture({
      env: { [PUBLIC_RAW_FIXTURE_ENV]: '/nonexistent/raw.dng' },
      exists: only(defaultPath),
    })
    expect(absent).toMatchObject({
      path: resolve('/nonexistent/raw.dng'),
      ready: false,
      required: true,
    })
    expect(absent.reason).toContain(PUBLIC_RAW_FIXTURE_ENV)
    // A blank override is unset.
    expect(
      resolvePublicRawFixture({
        env: { [PUBLIC_RAW_FIXTURE_ENV]: '  ' },
        exists: only(defaultPath),
      }).path,
    ).toBe(defaultPath)
  })
})

describe('private RAW fixture', () => {
  const name = 'LUMAFORGE_100MP_RAF'

  it('is optional when unset, apart from the public flag, and required in acceptance runs', () => {
    expect(
      resolvePrivateRawFixture(name, 'a RAF', {
        env: { [REQUIRE_PUBLIC_FIXTURE_ENV]: '1' },
      }),
    ).toEqual({
      coverage: 'private',
      path: null,
      ready: false,
      required: false,
      reason: `Optional private coverage: set ${name} to a RAF.`,
    })
    const required = resolvePrivateRawFixture(name, 'a RAF', {
      env: { [REQUIRE_PRIVATE_FIXTURES_ENV]: '1' },
    })
    expect(required).toMatchObject({ ready: false, required: true })
    expect(required.reason).toContain(REQUIRE_PRIVATE_FIXTURES_ENV)
  })

  it('runs on a named file and fails one that is absent', () => {
    const path = resolve('/fixtures/GFX100RF.RAF')
    const env = { [name]: path }
    expect(
      resolvePrivateRawFixture(name, 'a RAF', { env, exists: only(path) }),
    ).toMatchObject({ path, ready: true })
    expect(
      resolvePrivateRawFixture(name, 'a RAF', { env, exists: only() }),
    ).toMatchObject({ path, ready: false, required: true })
  })
})

describe('fixture gate', () => {
  it('hands a test the path of a ready fixture', () => {
    const testInfo = fakeTestInfo()
    const fixture = resolvePublicRawFixture({
      env: {},
      exists: only(defaultPath),
    })
    expect(gateRawFixture(testInfo, fixture)).toBe(defaultPath)
    expect(testInfo.skips).toEqual([])
  })

  it('skips an optional fixture and fails a required one with its reason', () => {
    const optional = resolvePublicRawFixture({ env: {}, exists: only() })
    const skipped = fakeTestInfo()
    expect(() => gateRawFixture(skipped, optional)).toThrow('skipped')
    expect(skipped.skips).toEqual([optional.reason])

    const required = resolvePublicRawFixture({
      env: { [REQUIRE_PUBLIC_FIXTURE_ENV]: '1' },
      exists: only(),
    })
    const failed = fakeTestInfo()
    expect(() => gateRawFixture(failed, required)).toThrow(required.reason)
    expect(failed.skips).toEqual([])
  })

  it('never hands a missing path to a test whose skip returns', () => {
    const fixture = resolvePrivateRawFixture('LUMAFORGE_SONY_ARW', 'an ARW', {
      env: {},
    })
    expect(() => gateRawFixture({ skip: () => {} }, fixture)).toThrow(
      fixture.reason,
    )
  })
})
