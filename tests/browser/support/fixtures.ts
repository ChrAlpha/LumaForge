import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

/**
 * RAW fixture resolution for the browser specs.
 *
 * Public coverage runs on the locked CI smoke DNG that
 * `pnpm --filter @lumaforge/luma-raw-runtime fixtures:fetch-public` caches
 * inside the repository. `LUMAFORGE_RAW_FIXTURE` names another file for the
 * specs whose assertions hold for any RAW, and
 * `LUMAFORGE_REQUIRE_PUBLIC_FIXTURE=1` turns a missing public fixture from a
 * skip into a failure.
 *
 * Private coverage (camera- or size-specific files that cannot be published)
 * has no default and never falls back to the public file. It runs only when
 * its own variable names a local file, and otherwise skips as optional private
 * coverage, whatever the public flag says. Acceptance runs set
 * `LUMAFORGE_REQUIRE_PRIVATE_FIXTURES=1`, which fails every selected test whose
 * private variable is unset.
 *
 * An explicitly named file that does not exist always fails, so a mistyped
 * path never turns into a skip or a fallback. Relative paths resolve against
 * the repository root, so nothing here depends on the working directory.
 */

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url))

export const PUBLIC_RAW_FIXTURE_ENV = 'LUMAFORGE_RAW_FIXTURE'
export const REQUIRE_PUBLIC_FIXTURE_ENV = 'LUMAFORGE_REQUIRE_PUBLIC_FIXTURE'
export const REQUIRE_PRIVATE_FIXTURES_ENV = 'LUMAFORGE_REQUIRE_PRIVATE_FIXTURES'
const PUBLIC_RAW_FIXTURE =
  'packages/luma-raw-runtime/fixtures/.cache/public/raw-pixls-iphone-se.dng'
const FETCH_PUBLIC_FIXTURES =
  'pnpm --filter @lumaforge/luma-raw-runtime fixtures:fetch-public'

type Env = Record<string, string | undefined>

type ResolveOptions = {
  env?: Env
  exists?: (path: string) => boolean
  /** Base for the default and for relative paths. */
  rootDir?: string
}

export type RawFixture = {
  /** Public coverage has a fetchable default; private only a named file. */
  coverage: 'public' | 'private'
  /** Absolute path; null when no private file was named. */
  path: string | null
  /** The file exists. */
  ready: boolean
  /** A missing file fails instead of skipping. */
  required: boolean
  /** Why the fixture cannot be used; empty when ready. */
  reason: string
}

function isTruthyFlag(value: string | undefined) {
  return value === '1' || value === 'true'
}

/** A file named by a variable: required, because the caller asked for it. */
function explicitFixture(
  coverage: RawFixture['coverage'],
  envName: string,
  value: string,
  exists: (path: string) => boolean,
  rootDir: string,
): RawFixture {
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

/** The fixture for format- and size-independent browser coverage. */
export function resolvePublicRawFixture({
  env = process.env,
  exists = existsSync,
  rootDir = REPO_ROOT,
}: ResolveOptions = {}): RawFixture {
  const override = env[PUBLIC_RAW_FIXTURE_ENV]?.trim()
  if (override) {
    return explicitFixture(
      'public',
      PUBLIC_RAW_FIXTURE_ENV,
      override,
      exists,
      rootDir,
    )
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

/** A local file that coverage depends on but the repository cannot ship. */
export function resolvePrivateRawFixture(
  envName: string,
  description: string,
  {
    env = process.env,
    exists = existsSync,
    rootDir = REPO_ROOT,
  }: ResolveOptions = {},
): RawFixture {
  const value = env[envName]?.trim()
  if (value) {
    return explicitFixture('private', envName, value, exists, rootDir)
  }
  const required = isTruthyFlag(env[REQUIRE_PRIVATE_FIXTURES_ENV])
  return {
    coverage: 'private',
    path: null,
    ready: false,
    required,
    reason: required
      ? `${REQUIRE_PRIVATE_FIXTURES_ENV} is set, but ${envName} is not: set it to ${description}.`
      : `Optional private coverage: set ${envName} to ${description}.`,
  }
}

/**
 * The fixture's path for one test. A missing required fixture fails the test;
 * a missing optional one skips it with the reason. Playwright's
 * `testInfo.skip` throws, and the final throw keeps any caller whose skip
 * returns from receiving a missing path.
 */
export function gateRawFixture(
  testInfo: { skip: (condition: boolean, description: string) => void },
  fixture: RawFixture,
): string {
  if (fixture.ready && fixture.path) return fixture.path
  if (!fixture.required) testInfo.skip(true, fixture.reason)
  throw new Error(fixture.reason)
}

/**
 * For specs whose assertions hold for any RAW above the quick-preview cap:
 * `LUMAFORGE_RAW_FIXTURE` may name another file.
 */
export const RAW_FIXTURE = resolvePublicRawFixture()

/**
 * The locked public DNG itself, for specs whose assertions name its own facts
 * (camera, support level, size, the tilt of its verticals). No override
 * reaches it, and a missing copy fails instead of skipping.
 */
export const PUBLIC_DNG = resolvePublicRawFixture({
  env: { [REQUIRE_PUBLIC_FIXTURE_ENV]: '1' },
})

/** The 100MP RAF whose size selects the expected export plans. */
export const LARGE_RAF = resolvePrivateRawFixture(
  'LUMAFORGE_100MP_RAF',
  'a local 100MP Fujifilm RAF (GFX100RF, 16-bit lossless compressed)',
)

/** The 61MP, 3:2 Sony ARW behind the output-size and resource assertions. */
export const SONY_ARW = resolvePrivateRawFixture(
  'LUMAFORGE_SONY_ARW',
  'a local 61MP Sony ARW that decodes to 9566x6374',
)

/**
 * The DNG's BaselineExposure decides every frame's exposure on its own, so it
 * cannot show a source keeping its quick frame's estimate. That needs a RAW
 * with no baseline whose quick and bounded HQ frames estimate different
 * exposures from their own pixels.
 */
export const EXPOSURE_RAW = resolvePrivateRawFixture(
  'LUMAFORGE_EXPOSURE_RAW',
  'a local non-DNG RAW whose quick and bounded HQ frames estimate different image-statistics exposures (a Sony FX30 ARW or a Nikon Z 7 NEF does)',
)
