import { createHash } from 'node:crypto'
import { createReadStream, promises as fs } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { downloadToFile } from '../../native/scripts/download.mjs'
import {
  fixtureCacheDir,
  fixtureCachePath,
  readFixtureLock,
  resolveFixtureUrls,
  selectFixtures,
} from './fixture-registry.mjs'

const scriptPath = fileURLToPath(import.meta.url)
const scriptDir = path.dirname(scriptPath)
const fixturesDir = path.dirname(scriptDir)
const lockPath = path.join(fixturesDir, 'public.lock.json')
const cacheDir = fixtureCacheDir(fixturesDir)

function readPositiveIntEnv(name, fallback) {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return fallback
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new TypeError(`${name} must be a positive integer, got ${JSON.stringify(raw)}`)
  }
  return parsed
}

const downloadTimeoutMs = readPositiveIntEnv('LUMAFORGE_FIXTURE_TIMEOUT_MS', 120_000)
const downloadAttempts = readPositiveIntEnv('LUMAFORGE_FIXTURE_ATTEMPTS', 3)

async function pathExists(absolutePath) {
  try {
    await fs.lstat(absolutePath)
    return true
  } catch {
    return false
  }
}

async function sha256File(absolutePath) {
  const hash = createHash('sha256')

  for await (const chunk of createReadStream(absolutePath)) {
    hash.update(chunk)
  }

  return hash.digest('hex')
}

async function downloadFixture(fixture, fixturePath) {
  const urls = resolveFixtureUrls(fixture, process.env)
  const { url, attempt } = await downloadToFile({
    urls,
    destination: fixturePath,
    timeoutMs: downloadTimeoutMs,
    attempts: downloadAttempts,
    log: (line) => console.warn(line),
  })
  if (url !== fixture.url || attempt > 1) {
    console.warn(`Downloaded ${fixture.name} from ${url} (attempt ${attempt})`)
  }
}

function hashMismatchError(fixture, actual) {
  return new Error(
    `SHA-256 mismatch for ${fixture.name}\nExpected: ${fixture.sha256}\nActual:   ${actual}`,
  )
}

async function ensureFixture(fixture) {
  const fixturePath = fixtureCachePath(fixturesDir, fixture)

  if (await pathExists(fixturePath)) {
    const cachedHash = await sha256File(fixturePath)
    if (cachedHash === fixture.sha256) {
      return fixturePath
    }

    await fs.rm(fixturePath, { force: true })
  }

  await downloadFixture(fixture, fixturePath)

  const downloadedHash = await sha256File(fixturePath)
  if (downloadedHash !== fixture.sha256) {
    await fs.rm(fixturePath, { force: true })
    throw hashMismatchError(fixture, downloadedHash)
  }

  return fixturePath
}

function parseArgs(argv) {
  const result = { all: false, purpose: undefined }
  for (const arg of argv) {
    if (arg === '--all') {
      result.all = true
      continue
    }
    if (arg.startsWith('--purpose=')) {
      result.purpose = arg.slice('--purpose='.length)
      continue
    }
    throw new TypeError(
      `Unknown fetch-public-fixtures argument: ${arg}. Use --all or --purpose=<purpose>.`,
    )
  }
  if (result.all && result.purpose) {
    throw new TypeError('Use either --all or --purpose=<purpose>, not both.')
  }
  return result
}

try {
  const lock = await readFixtureLock(lockPath)
  const selectedFixtures = selectFixtures(
    lock.fixtures,
    parseArgs(process.argv.slice(2)),
  )

  await fs.mkdir(cacheDir, { recursive: true })

  for (const fixture of selectedFixtures) {
    await ensureFixture(fixture)
    console.log(`Fetched ${fixture.name}`)
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
}
