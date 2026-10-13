import { promises as fs } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { buildReportEntry } from './compatibility-report.mjs'
import {
  fixtureCachePath,
  readFixtureLock,
  selectFixtures,
} from './fixture-registry.mjs'
import {
  createDiagnosticsRuntime,
  diagnoseNativeFixture,
} from './native-diagnostics-runtime.mjs'

const scriptPath = fileURLToPath(import.meta.url)
const scriptDir = path.dirname(scriptPath)
const fixturesDir = path.dirname(scriptDir)
const packageDir = path.dirname(fixturesDir)
const lockPath = path.join(fixturesDir, 'public.lock.json')

export function defaultReportPath(rootFixturesDir = fixturesDir) {
  return path.join(
    rootFixturesDir,
    '.cache',
    'reports',
    'mobile-raw-compatibility.json',
  )
}

export function parseArgs(argv) {
  const result = {
    all: false,
    purpose: 'ci-smoke',
    profile: 'desktop',
    output: undefined,
  }

  let explicitPurpose = false

  for (const arg of argv) {
    if (arg === '--all') {
      result.all = true
      result.purpose = undefined
      continue
    }

    if (arg.startsWith('--purpose=')) {
      explicitPurpose = true
      result.purpose = arg.slice('--purpose='.length)
      continue
    }

    if (arg.startsWith('--profile=')) {
      result.profile = arg.slice('--profile='.length)
      continue
    }

    if (arg.startsWith('--output=')) {
      result.output = arg.slice('--output='.length)
      continue
    }

    throw new TypeError(
      `Unknown diagnose-raw-compatibility argument: ${arg}. Use --all, --purpose=<purpose>, --profile=<profile>, or --output=<path>.`,
    )
  }

  if (result.all && explicitPurpose) {
    throw new TypeError('Use either --all or --purpose=<purpose>, not both.')
  }

  if (result.profile !== 'desktop' && result.profile !== 'low-memory') {
    throw new TypeError('Profile must be desktop or low-memory.')
  }

  return result
}

export function reportPayload({ generatedAt, entries }) {
  return {
    schemaVersion: 1,
    generatedAt,
    entries,
  }
}

async function pathExists(absolutePath) {
  try {
    await fs.stat(absolutePath)
    return true
  } catch {
    return false
  }
}

async function requireCachedFixture(fixture, rootFixturesDir = fixturesDir) {
  const absolutePath = fixtureCachePath(rootFixturesDir, fixture)
  if (await pathExists(absolutePath)) {
    return absolutePath
  }

  throw new Error(
    `Missing cached fixture ${fixture.name}: ${absolutePath}\nRun pnpm --filter @lumaforge/luma-raw-runtime fixtures:fetch-public for CI fixtures or fixtures:fetch-public:all for local compatibility fixtures.`,
  )
}

export async function preflightCachedFixtures(
  fixtures,
  rootFixturesDir = fixturesDir,
) {
  const selectedFixtures = []

  for (const fixture of fixtures) {
    selectedFixtures.push({
      fixture,
      fixturePath: await requireCachedFixture(fixture, rootFixturesDir),
    })
  }

  return selectedFixtures
}

export function nativeArtifactPaths({
  packageDir: rootPackageDir = packageDir,
  profile,
}) {
  const nativeDir = path.join(rootPackageDir, 'dist', 'native', profile)

  return {
    jsPath: path.join(nativeDir, 'luma_raw.js'),
    wasmPath: path.join(nativeDir, 'luma_raw.wasm'),
  }
}

export async function requireNativeArtifacts({
  packageDir: rootPackageDir = packageDir,
  profile,
}) {
  const artifacts = nativeArtifactPaths({
    packageDir: rootPackageDir,
    profile,
  })

  for (const absolutePath of [artifacts.jsPath, artifacts.wasmPath]) {
    if (await pathExists(absolutePath)) {
      continue
    }

    throw new Error(
      `Missing native diagnostics artifact: ${absolutePath}\nRun pnpm --filter @lumaforge/luma-raw-runtime build:native:${profile} and pnpm --filter @lumaforge/luma-raw-runtime build before diagnostics.`,
    )
  }

  return artifacts
}

export async function runDiagnostics(options) {
  const lock = await readFixtureLock(lockPath)
  const fixtures = selectFixtures(lock.fixtures, {
    all: options.all,
    purpose: options.purpose,
  })
  const selectedFixtures = await preflightCachedFixtures(fixtures)
  await requireNativeArtifacts({ profile: options.profile })

  const runtime = await createDiagnosticsRuntime({
    packageDir,
    profile: options.profile,
  })
  const entries = []

  try {
    for (const { fixture, fixturePath } of selectedFixtures) {
      const raw = await diagnoseNativeFixture({
        fixture,
        fixturePath,
        runtime,
        memoryProfile: options.profile,
      })
      entries.push(buildReportEntry(raw))
      console.log(`${fixture.name}: ${entries.at(-1).classification}`)
    }
  } finally {
    runtime.dispose()
  }

  const output = options.output ?? defaultReportPath(fixturesDir)
  await fs.mkdir(path.dirname(output), { recursive: true })
  await fs.writeFile(
    output,
    `${JSON.stringify(
      reportPayload({
        generatedAt: new Date().toISOString(),
        entries,
      }),
      null,
      2,
    )}\n`,
  )
  console.log(`Wrote ${output}`)

  return output
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    await runDiagnostics(parseArgs(process.argv.slice(2)))
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}
