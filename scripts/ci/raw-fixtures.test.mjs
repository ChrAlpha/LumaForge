// @vitest-environment node
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import {
  fixtureCachePath,
  readFixtureLock,
} from '../../packages/luma-raw-runtime/fixtures/scripts/fixture-registry.mjs'
import {
  gateRawFixture,
  PUBLIC_RAW_FIXTURE_ENV,
  REQUIRE_PRIVATE_FIXTURES_ENV,
  REQUIRE_PUBLIC_FIXTURE_ENV,
  resolvePrivateRawFixture,
  resolvePublicRawFixture,
} from './raw-fixtures.mjs'

// Runs under `node --test` and under the Vitest app gate.
const { describe, it } = process.env.VITEST
  ? await import('vitest')
  : await import('node:test')

const repoRoot = fileURLToPath(new URL('../../', import.meta.url))
const fixturesDir = join(repoRoot, 'packages/luma-raw-runtime/fixtures')
const lock = await readFixtureLock(join(fixturesDir, 'public.lock.json'))
const defaultPath = resolve(
  repoRoot,
  'packages/luma-raw-runtime/fixtures/.cache/public/raw-pixls-iphone-se.dng',
)

/** A file-existence check that only knows `paths` and records each query. */
function filesystem(...paths) {
  const queried = []
  const exists = (path) => {
    queried.push(path)
    return paths.includes(path)
  }
  return { exists, queried }
}

function fakeTestInfo({ skipThrows = true } = {}) {
  const skips = []
  const sentinel = new Error('skipped')
  return {
    sentinel,
    skips,
    skip(condition, description) {
      skips.push({ condition, description })
      if (skipThrows) throw sentinel
    },
  }
}

describe('public RAW fixture resolution', () => {
  it('defaults to the locked CI smoke DNG under the repository root', () => {
    const fs = filesystem(defaultPath)
    const fixture = resolvePublicRawFixture({ env: {}, exists: fs.exists })

    assert.deepEqual(fixture, {
      coverage: 'public',
      path: defaultPath,
      ready: true,
      required: false,
      reason: '',
    })
    // The default is a file `fixtures:fetch-public` actually downloads.
    const ciSmoke = lock.fixtures.filter((f) => f.purpose === 'ci-smoke')
    assert.ok(
      ciSmoke.some((f) => fixtureCachePath(fixturesDir, f) === fixture.path),
      `${fixture.path} is not a cached ci-smoke fixture`,
    )
  })

  it('skips a missing default unless the public fixture is required', () => {
    for (const flag of [undefined, '', '0', 'false']) {
      const fixture = resolvePublicRawFixture({
        env: { [REQUIRE_PUBLIC_FIXTURE_ENV]: flag },
        exists: filesystem().exists,
      })
      assert.equal(fixture.coverage, 'public')
      assert.equal(fixture.path, defaultPath)
      assert.equal(fixture.ready, false)
      assert.equal(fixture.required, false, `flag ${flag} must not require`)
      assert.match(fixture.reason, /^Public RAW fixture is missing/)
      assert.ok(fixture.reason.includes(defaultPath))
      assert.ok(fixture.reason.includes('fixtures:fetch-public'))
    }
  })

  it('fails a missing default when the public fixture is required', () => {
    for (const flag of ['1', 'true']) {
      const fixture = resolvePublicRawFixture({
        env: { [REQUIRE_PUBLIC_FIXTURE_ENV]: flag },
        exists: filesystem().exists,
      })
      assert.equal(fixture.ready, false)
      assert.equal(fixture.required, true, `flag ${flag} must require`)
      assert.ok(fixture.reason.includes(REQUIRE_PUBLIC_FIXTURE_ENV))
      assert.ok(fixture.reason.includes(defaultPath))
      assert.ok(fixture.reason.includes('fixtures:fetch-public'))
    }
  })

  it('uses an explicit override without consulting the default', () => {
    const override = resolve('/fixtures/local/SGL00940.ARW')
    const fs = filesystem(override, defaultPath)
    const fixture = resolvePublicRawFixture({
      env: { [PUBLIC_RAW_FIXTURE_ENV]: override },
      exists: fs.exists,
    })

    assert.equal(fixture.path, override)
    assert.equal(fixture.ready, true)
    assert.equal(fixture.reason, '')
    assert.deepEqual(fs.queried, [override])
  })

  it('fails an override that is supplied but absent, even when not required', () => {
    const fixture = resolvePublicRawFixture({
      env: { [PUBLIC_RAW_FIXTURE_ENV]: '/nonexistent/raw.dng' },
      // The default exists: a mistyped override must not fall back to it.
      exists: filesystem(defaultPath).exists,
    })

    assert.equal(fixture.path, resolve('/nonexistent/raw.dng'))
    assert.equal(fixture.ready, false)
    assert.equal(fixture.required, true)
    assert.ok(fixture.reason.includes(PUBLIC_RAW_FIXTURE_ENV))
    assert.ok(fixture.reason.includes(resolve('/nonexistent/raw.dng')))
  })

  it('resolves a relative override against the repository root', () => {
    const rootDir = resolve('/checkout')
    const expected = resolve(rootDir, 'local/SGL_1998.NEF')
    const fixture = resolvePublicRawFixture({
      env: { [PUBLIC_RAW_FIXTURE_ENV]: 'local/SGL_1998.NEF' },
      exists: filesystem(expected).exists,
      rootDir,
    })

    assert.equal(fixture.path, expected)
    assert.equal(fixture.ready, true)
  })

  it('treats a blank override as unset', () => {
    const fixture = resolvePublicRawFixture({
      env: { [PUBLIC_RAW_FIXTURE_ENV]: '  ' },
      exists: filesystem(defaultPath).exists,
    })

    assert.equal(fixture.path, defaultPath)
    assert.equal(fixture.ready, true)
  })
})

describe('private RAW fixture resolution', () => {
  const name = 'LUMAFORGE_100MP_RAF'
  const description = 'a local 100MP RAF'

  it('labels unset private coverage optional, apart from public coverage', () => {
    for (const flag of [undefined, '', '0', 'false']) {
      const fixture = resolvePrivateRawFixture(name, description, {
        // The public requirement does not extend to private coverage.
        env: {
          [REQUIRE_PUBLIC_FIXTURE_ENV]: '1',
          [REQUIRE_PRIVATE_FIXTURES_ENV]: flag,
        },
        exists: () => assert.fail('no private path was named'),
      })

      assert.deepEqual(
        fixture,
        {
          coverage: 'private',
          path: null,
          ready: false,
          required: false,
          reason: `Optional private coverage: set ${name} to ${description}.`,
        },
        `flag ${flag} must not require`,
      )
    }
  })

  it('fails unset private coverage in the required-private mode', () => {
    for (const flag of ['1', 'true']) {
      const fixture = resolvePrivateRawFixture(name, description, {
        env: { [REQUIRE_PRIVATE_FIXTURES_ENV]: flag },
        exists: () => assert.fail('no private path was named'),
      })

      assert.equal(fixture.coverage, 'private')
      assert.equal(fixture.path, null)
      assert.equal(fixture.ready, false)
      assert.equal(fixture.required, true, `flag ${flag} must require`)
      assert.ok(fixture.reason.includes(REQUIRE_PRIVATE_FIXTURES_ENV))
      assert.ok(fixture.reason.includes(name))
      assert.ok(fixture.reason.includes(description))
    }
  })

  it('leaves the public requirement to its own flag', () => {
    const fixture = resolvePublicRawFixture({
      env: { [REQUIRE_PRIVATE_FIXTURES_ENV]: '1' },
      exists: filesystem().exists,
    })

    assert.equal(fixture.ready, false)
    assert.equal(fixture.required, false)
  })

  it('runs private coverage when its explicit path exists', () => {
    const path = resolve('/fixtures/local/GFX100RF.RAF')
    const fixture = resolvePrivateRawFixture(name, description, {
      env: { [name]: path },
      exists: filesystem(path).exists,
    })

    assert.equal(fixture.coverage, 'private')
    assert.equal(fixture.path, path)
    assert.equal(fixture.ready, true)
  })

  it('fails a private path that is supplied but absent', () => {
    const fixture = resolvePrivateRawFixture(name, description, {
      env: { [name]: '/nonexistent/GFX100RF.RAF' },
      exists: filesystem().exists,
    })

    assert.equal(fixture.ready, false)
    assert.equal(fixture.required, true)
    assert.ok(fixture.reason.includes(name))
    assert.ok(fixture.reason.includes(resolve('/nonexistent/GFX100RF.RAF')))
  })
})

describe('fixture gate for a browser test', () => {
  it('returns the path of a ready fixture', () => {
    const testInfo = fakeTestInfo()
    const fixture = resolvePublicRawFixture({
      env: {},
      exists: filesystem(defaultPath).exists,
    })

    assert.equal(gateRawFixture(testInfo, fixture), defaultPath)
    assert.deepEqual(testInfo.skips, [])
  })

  it('skips an optional fixture with its reason', () => {
    const testInfo = fakeTestInfo()
    const fixture = resolvePublicRawFixture({
      env: {},
      exists: filesystem().exists,
    })

    assert.throws(() => gateRawFixture(testInfo, fixture), testInfo.sentinel)
    assert.deepEqual(testInfo.skips, [
      { condition: true, description: fixture.reason },
    ])
  })

  it('fails a required fixture instead of skipping it', () => {
    for (const fixture of [
      resolvePublicRawFixture({
        env: { [REQUIRE_PUBLIC_FIXTURE_ENV]: '1' },
        exists: filesystem().exists,
      }),
      resolvePublicRawFixture({
        env: { [PUBLIC_RAW_FIXTURE_ENV]: '/nonexistent/raw.dng' },
        exists: filesystem().exists,
      }),
      resolvePrivateRawFixture('LUMAFORGE_SONY_ARW', 'an ARW', {
        env: { [REQUIRE_PRIVATE_FIXTURES_ENV]: '1' },
      }),
    ]) {
      const testInfo = fakeTestInfo()
      assert.throws(() => gateRawFixture(testInfo, fixture), {
        message: fixture.reason,
      })
      assert.deepEqual(testInfo.skips, [])
    }
  })

  it('never hands a missing path to a test whose skip returns', () => {
    const testInfo = fakeTestInfo({ skipThrows: false })
    const fixture = resolvePrivateRawFixture('LUMAFORGE_SONY_ARW', 'an ARW', {
      env: {},
    })

    assert.throws(() => gateRawFixture(testInfo, fixture), {
      message: fixture.reason,
    })
  })
})

describe('working-directory independence', () => {
  it('resolves the same paths from any working directory', () => {
    const moduleUrl = new URL('./raw-fixtures.mjs', import.meta.url).href
    const script = [
      `const m = await import(${JSON.stringify(moduleUrl)})`,
      'const relative = { [m.PUBLIC_RAW_FIXTURE_ENV]: "local/raw.dng" }',
      'console.log(JSON.stringify({',
      '  defaultPath: m.resolvePublicRawFixture({ env: {} }).path,',
      '  relativePath: m.resolvePublicRawFixture({ env: relative }).path,',
      '}))',
    ].join('\n')
    const output = execFileSync(
      process.execPath,
      ['--input-type=module', '--eval', script],
      { cwd: tmpdir(), encoding: 'utf8' },
    )

    assert.deepEqual(JSON.parse(output), {
      defaultPath,
      relativePath: resolve(repoRoot, 'local/raw.dng'),
    })
  })
})

describe('browser specs', () => {
  const browserDir = fileURLToPath(
    new URL('../../tests/browser/', import.meta.url),
  )
  const readSpec = (file) => readFileSync(join(browserDir, file), 'utf8')
  const machinePath = /['"`](?:\/(?:workspaces|home|Users)\/|[a-z]:[\\/])/i

  it('keep machine-specific fixture paths out of the specs', () => {
    const offenders = readdirSync(browserDir)
      .filter((file) => file.endsWith('.ts'))
      .filter((file) => machinePath.test(readSpec(file)))

    assert.deepEqual(offenders, [])
  })

  it('keep size- and camera-specific expectations on private fixtures', () => {
    // Compare holds for any RAW above the quick-preview cap. The export specs
    // expect one file's plan, output size, aspect or resource load, so they
    // name that file privately instead of inheriting the public default.
    const coverage = {
      'raw-dual-layer-compare.spec.ts': 'resolvePublicRawFixture',
      'raw-export-lifecycle-resources.spec.ts': 'resolveSonyArwFixture',
      'raw-hq-preview-export.spec.ts': 'resolveSonyArwFixture',
      'raw-ios-safe-export-output.spec.ts': 'resolveSonyArwFixture',
      'raw-ios-safe-export.spec.ts': 'resolveRawFixture',
    }
    for (const [file, resolver] of Object.entries(coverage)) {
      const source = readSpec(file)
      assert.ok(source.includes(`${resolver}(`), `${file} uses ${resolver}`)
      if (resolver !== 'resolvePublicRawFixture') {
        assert.ok(!source.includes('resolvePublicRawFixture'), file)
      }
    }

    const registry = readSpec('raw-export-fixtures.ts')
    assert.match(registry, /resolvePrivateRawFixture\(\s*'LUMAFORGE_100MP_RAF'/)
    assert.match(registry, /resolvePrivateRawFixture\(\s*'LUMAFORGE_SONY_ARW'/)
    assert.ok(!registry.includes('resolvePublicRawFixture'))
  })
})
