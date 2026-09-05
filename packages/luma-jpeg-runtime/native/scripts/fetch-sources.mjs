import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, promises as fs } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { downloadToFile } from './download.mjs'

const scriptPath = fileURLToPath(import.meta.url)
const scriptDir = path.dirname(scriptPath)
const nativeDir = path.dirname(scriptDir)
const lockPath = path.join(nativeDir, 'sources.lock.json')
const cacheDir = path.join(nativeDir, '.cache', 'sources')
const vendorDir = path.join(nativeDir, 'vendor')
const vendorTempDir = path.join(nativeDir, `vendor.tmp-${process.pid}`)
function readPositiveIntEnv(name, fallback) {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return fallback
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new TypeError(`${name} must be a positive integer, got ${JSON.stringify(raw)}`)
  }
  return parsed
}

const downloadTimeoutMs = readPositiveIntEnv('LUMAFORGE_NATIVE_FETCH_TIMEOUT_MS', 120_000)
const downloadAttempts = readPositiveIntEnv('LUMAFORGE_NATIVE_FETCH_ATTEMPTS', 3)
const sha256Pattern = /^[0-9a-f]{64}$/
const sourceFields = [
  'name',
  'version',
  'url',
  'sha256',
  'archiveName',
  'extractDir',
]

function formatSource(source) {
  return `${source.name}@${source.version}`
}

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

async function downloadArchive(source, archivePath) {
  const urls = [source.url, ...(source.mirrors ?? [])]
  const { url, attempt } = await downloadToFile({
    urls,
    destination: archivePath,
    timeoutMs: downloadTimeoutMs,
    attempts: downloadAttempts,
    log: (line) => console.warn(line),
  })
  if (url !== source.url || attempt > 1) {
    console.warn(`Downloaded ${formatSource(source)} from ${url} (attempt ${attempt})`)
  }
}

function hashMismatchError(source, actual) {
  return new Error(
    `SHA-256 mismatch for ${formatSource(source)}\nExpected: ${source.sha256}\nActual:   ${actual}`,
  )
}

async function ensureArchive(source) {
  const archivePath = path.join(cacheDir, source.archiveName)

  if (await pathExists(archivePath)) {
    const cachedHash = await sha256File(archivePath)
    if (cachedHash === source.sha256) {
      return archivePath
    }

    await fs.rm(archivePath, { force: true })
  }

  await downloadArchive(source, archivePath)

  const downloadedHash = await sha256File(archivePath)
  if (downloadedHash !== source.sha256) {
    await fs.rm(archivePath, { force: true })
    throw hashMismatchError(source, downloadedHash)
  }

  return archivePath
}

function isUnsafeArchiveEntry(entry) {
  const normalizedEntry = entry.replace(/\\/g, '/')
  return (
    path.posix.isAbsolute(normalizedEntry) ||
    path.win32.isAbsolute(entry) ||
    normalizedEntry.split('/').includes('..')
  )
}

function isWhitespaceChar(value) {
  return value === ' ' || value === '\t'
}

function parseTarVerboseEntry(line) {
  let index = 0
  for (let field = 0; field < 6; field += 1) {
    while (index < line.length && !isWhitespaceChar(line[index])) index += 1
    while (index < line.length && isWhitespaceChar(line[index])) index += 1
  }

  if (index >= line.length) {
    return {
      type: '?',
      path: line,
      raw: line,
    }
  }

  const type = line[0]
  const entry = line.slice(index)
  const pathValue =
    type === 'l' || type === 'h' ? entry.split(' -> ')[0] : entry

  return {
    type,
    path: pathValue,
    raw: line,
  }
}

async function listArchiveEntries(source, archivePath) {
  return new Promise((resolve, reject) => {
    const tar = spawn('tar', ['-tvzf', archivePath], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''
    tar.stdout.setEncoding('utf8')
    tar.stderr.setEncoding('utf8')
    tar.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    tar.stderr.on('data', (chunk) => {
      stderr += chunk
    })

    tar.on('error', reject)
    tar.on('close', (code) => {
      if (code === 0) {
        resolve(
          stdout
            .split('\n')
            .filter((entry) => entry.length > 0)
            .map(parseTarVerboseEntry),
        )
        return
      }

      const details = stderr.trim() ? `: ${stderr.trim()}` : ''
      reject(
        new Error(
          `tar -tvzf failed for ${formatSource(source)} with exit code ${code}${details}`,
        ),
      )
    })
  })
}

async function validateArchiveEntries(source, archivePath) {
  const entries = await listArchiveEntries(source, archivePath)
  const linkedEntry = entries.find(
    (entry) => entry.type === 'l' || entry.type === 'h',
  )
  if (linkedEntry) {
    throw new Error(
      `Unsafe archive link entry for ${formatSource(source)}: ${linkedEntry.raw}`,
    )
  }

  const unsafeEntry = entries.find((entry) => isUnsafeArchiveEntry(entry.path))
  if (unsafeEntry) {
    throw new Error(
      `Unsafe archive entry for ${formatSource(source)}: ${unsafeEntry.path}`,
    )
  }
}

async function extractArchive(source, archivePath, destinationDir) {
  await new Promise((resolve, reject) => {
    const tar = spawn(
      'tar',
      [
        '--no-same-owner',
        '--no-same-permissions',
        '-xzf',
        archivePath,
        '-C',
        destinationDir,
      ],
      {
        stdio: 'inherit',
      },
    )

    tar.on('error', reject)
    tar.on('close', (code) => {
      if (code === 0) {
        resolve()
        return
      }

      reject(
        new Error(
          `tar -xzf failed for ${formatSource(source)} with exit code ${code}`,
        ),
      )
    })
  })

  const extractedPath = path.join(destinationDir, source.extractDir)
  if (!(await pathExists(extractedPath))) {
    throw new Error(`Missing extracted source directory: ${extractedPath}`)
  }
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function validateBasenameOnlyField(source, index, field) {
  const value = source[field]
  if (
    value.length === 0 ||
    value === '.' ||
    value === '..' ||
    path.posix.isAbsolute(value) ||
    path.win32.isAbsolute(value) ||
    value.includes('/') ||
    value.includes('\\')
  ) {
    throw new TypeError(
      `Invalid native source lockfile: sources[${index}].${field} must be a basename-only relative name`,
    )
  }
}

function validateSource(source, index) {
  if (!isObject(source)) {
    throw new TypeError(
      `Invalid native source lockfile: sources[${index}] must be an object`,
    )
  }

  for (const field of sourceFields) {
    if (typeof source[field] !== 'string') {
      throw new TypeError(
        `Invalid native source lockfile: sources[${index}].${field} must be a string`,
      )
    }
  }

  if (!sha256Pattern.test(source.sha256)) {
    throw new TypeError(
      `Invalid native source lockfile: sources[${index}].sha256 must be 64 lowercase hex characters`,
    )
  }

  let url
  try {
    url = new URL(source.url)
  } catch {
    throw new TypeError(
      `Invalid native source lockfile: sources[${index}].url must be a valid URL`,
    )
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new TypeError(
      `Invalid native source lockfile: sources[${index}].url must use http or https`,
    )
  }

  if (source.mirrors !== undefined) {
    if (!Array.isArray(source.mirrors)) {
      throw new TypeError(`Invalid native source lockfile: sources[${index}].mirrors must be an array of URLs`)
    }
    source.mirrors.forEach((mirror, mirrorIndex) => {
      let mirrorUrl
      try {
        mirrorUrl = new URL(mirror)
      } catch {
        throw new TypeError(`Invalid native source lockfile: sources[${index}].mirrors[${mirrorIndex}] must be a valid URL`)
      }
      if (mirrorUrl.protocol !== 'http:' && mirrorUrl.protocol !== 'https:') {
        throw new TypeError(`Invalid native source lockfile: sources[${index}].mirrors[${mirrorIndex}] must use http or https`)
      }
    })
  }

  validateBasenameOnlyField(source, index, 'archiveName')
  validateBasenameOnlyField(source, index, 'extractDir')
}

function validateLockfile(lock) {
  if (!isObject(lock)) {
    throw new TypeError(`Invalid native source lockfile: ${lockPath}`)
  }
  if (lock.schemaVersion !== 1) {
    throw new TypeError(
      'Invalid native source lockfile: schemaVersion must be 1',
    )
  }
  if (!Array.isArray(lock.sources) || lock.sources.length === 0) {
    throw new TypeError(
      'Invalid native source lockfile: sources must be a non-empty array',
    )
  }

  lock.sources.forEach(validateSource)
}

async function readLockfile() {
  const lock = JSON.parse(await fs.readFile(lockPath, 'utf8'))
  validateLockfile(lock)
  return lock
}

async function replaceVendorDirectory() {
  const vendorBackupDir = path.join(nativeDir, `vendor.previous-${process.pid}`)
  await fs.rm(vendorBackupDir, { force: true, recursive: true })

  let hasBackup = false
  if (await pathExists(vendorDir)) {
    await fs.rename(vendorDir, vendorBackupDir)
    hasBackup = true
  }

  try {
    await fs.rename(vendorTempDir, vendorDir)
  } catch (error) {
    if (hasBackup && !(await pathExists(vendorDir))) {
      await fs.rename(vendorBackupDir, vendorDir)
    }
    throw error
  }

  await fs.rm(vendorBackupDir, { force: true, recursive: true })
}

let createdVendorTemp = false

try {
  const lock = await readLockfile()

  await fs.mkdir(cacheDir, { recursive: true })
  await fs.rm(vendorTempDir, { force: true, recursive: true })
  await fs.mkdir(vendorTempDir, { recursive: true })
  createdVendorTemp = true

  const fetchedSources = []
  for (const source of lock.sources) {
    const archivePath = await ensureArchive(source)
    await validateArchiveEntries(source, archivePath)
    await extractArchive(source, archivePath, vendorTempDir)
    fetchedSources.push(formatSource(source))
  }

  await replaceVendorDirectory()
  for (const source of fetchedSources) {
    console.log(`Fetched ${source}`)
  }
} catch (error) {
  if (createdVendorTemp) {
    await fs.rm(vendorTempDir, { force: true, recursive: true })
  }
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
}
