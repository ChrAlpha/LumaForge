import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

/**
 * RAW fixture resolution for the browser specs.
 *
 * Public coverage runs on the locked CI smoke DNG that
 * `pnpm --filter @lumaforge/luma-raw-runtime fixtures:fetch-public` caches
 * inside the repository. `LUMAFORGE_RAW_FIXTURE` names another file instead,
 * and `LUMAFORGE_REQUIRE_PUBLIC_FIXTURE=1` turns a missing public fixture from
 * a skip into a failure.
 *
 * Private coverage (camera- or size-specific files that cannot be published)
 * has no default. It runs only when its own variable names a local file, and
 * otherwise skips as optional private coverage, whatever the public flag says.
 *
 * An explicitly named file that does not exist always fails, so a mistyped
 * path never turns into a skip or a fallback. Relative paths resolve against
 * the repository root, so nothing here depends on the working directory.
 */

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url))

export const PUBLIC_RAW_FIXTURE_ENV = 'LUMAFORGE_RAW_FIXTURE'
export const REQUIRE_PUBLIC_FIXTURE_ENV = 'LUMAFORGE_REQUIRE_PUBLIC_FIXTURE'
export const PUBLIC_RAW_FIXTURE =
  'packages/luma-raw-runtime/fixtures/.cache/public/raw-pixls-iphone-se.dng'

const FETCH_PUBLIC_FIXTURES =
  'pnpm --filter @lumaforge/luma-raw-runtime fixtures:fetch-public'

/**
 * @typedef {object} ResolveOptions
 * @property {Record<string, string | undefined>} [env] Variables to read.
 * @property {(path: string) => boolean} [exists] File-existence check.
 * @property {string} [rootDir] Base for the default and for relative paths.
 */

/**
 * @template {string | null} Path
 * @typedef {object} RawFixture
 * @property {'public' | 'private'} coverage Public coverage has a fetchable
 *   default; private coverage only runs on a named local file.
 * @property {Path} path Absolute path; null when no private file was named.
 * @property {boolean} ready The file exists.
 * @property {boolean} required A missing file fails instead of skipping.
 * @property {string} reason Why the fixture cannot be used; empty when ready.
 */

/** @param {string | undefined} value */
function isTruthyFlag(value) {
  return value === '1' || value === 'true'
}

/**
 * A file named by a variable: required, because the caller asked for it.
 * @param {'public' | 'private'} coverage
 * @param {string} envName
 * @param {string} value
 * @param {{ exists: (path: string) => boolean, rootDir: string }} options
 * @returns {RawFixture<string>}
 */
function explicitFixture(coverage, envName, value, { exists, rootDir }) {
  const path = resolve(rootDir, value)
  const ready = exists(path)
  return {
    coverage,
    path,
    ready,
    required: true,
    reason: ready
      ? ''
      : `${envName} is set to "${value}", but ${path} does not exist.`,
  }
}

/**
 * The fixture for format- and size-independent browser coverage.
 * @param {ResolveOptions} [options]
 * @returns {RawFixture<string>}
 */
export function resolvePublicRawFixture({
  env = process.env,
  exists = existsSync,
  rootDir = REPO_ROOT,
} = {}) {
  const override = env[PUBLIC_RAW_FIXTURE_ENV]?.trim()
  if (override) {
    return explicitFixture('public', PUBLIC_RAW_FIXTURE_ENV, override, {
      exists,
      rootDir,
    })
  }

  const path = resolve(rootDir, PUBLIC_RAW_FIXTURE)
  const ready = exists(path)
  const required = isTruthyFlag(env[REQUIRE_PUBLIC_FIXTURE_ENV])
  let reason = ''
  if (!ready) {
    reason = required
      ? `${REQUIRE_PUBLIC_FIXTURE_ENV} is set, but the public RAW fixture is missing: ${path}. Run ${FETCH_PUBLIC_FIXTURES}.`
      : `Public RAW fixture is missing: ${path}. Run ${FETCH_PUBLIC_FIXTURES} (${REQUIRE_PUBLIC_FIXTURE_ENV}=1 makes this a failure).`
  }
  return { coverage: 'public', path, ready, required, reason }
}

/**
 * A local file that coverage depends on but the repository cannot ship.
 * @param {string} envName Variable that names the file.
 * @param {string} description What the file must be, for the skip reason.
 * @param {ResolveOptions} [options]
 * @returns {RawFixture<string | null>}
 */
export function resolvePrivateRawFixture(
  envName,
  description,
  { env = process.env, exists = existsSync, rootDir = REPO_ROOT } = {},
) {
  const value = env[envName]?.trim()
  if (value) {
    return explicitFixture('private', envName, value, { exists, rootDir })
  }
  return {
    coverage: 'private',
    path: null,
    ready: false,
    required: false,
    reason: `Optional private coverage: set ${envName} to ${description}.`,
  }
}

/**
 * The fixture's path for one test. A missing required fixture fails the test;
 * a missing optional one skips it with the reason. Playwright's
 * `testInfo.skip` throws, and the final throw keeps any caller whose skip
 * returns from receiving a missing path.
 * @param {{ skip: (condition: boolean, description: string) => void }} testInfo
 * @param {RawFixture<string | null>} fixture
 * @returns {string}
 */
export function gateRawFixture(testInfo, fixture) {
  if (fixture.ready && fixture.path) return fixture.path
  if (!fixture.required) testInfo.skip(true, fixture.reason)
  throw new Error(fixture.reason)
}
