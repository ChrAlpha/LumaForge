// Processed windows must not depend on the decoded region. Reading the export
// frame as 256-row strips, 512-row strips or one full-height window, each with
// the 2px halo the full-resolution exporter requests, has to produce
// byte-identical RGB16 rows in any read order. A window-local white point or
// any other region-dependent normalization breaks this and shows up as
// brightness bands between export strips.
//
// Usage:
//   node native/scripts/check-window-normalization.mjs --profile <profile>
//     [--native-dir <dir>]
//
// The built package Node entry (dist/node.js) is required. By default it loads
// the artifacts @lumaforge/luma-native-artifacts resolves; --native-dir loads
// <dir>/<profile>/luma_raw.{js,wasm} instead (for example dist/native before
// syncing the artifact package). Runs serially and exits non-zero on any
// mismatch.
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const packageDir = path.resolve(scriptDir, '..', '..')
const repoRoot = path.resolve(packageDir, '..', '..')
const nodeEntryPath = path.join(packageDir, 'dist', 'node.js')
const fixturesDir = path.join(packageDir, 'fixtures')
const fixtureLockPath = path.join(fixturesDir, 'public.lock.json')
const fixtureName = 'raw-pixls-iphone-se-dng'
const nativeProfiles = ['desktop', 'low-memory']
const stripRowCounts = [256, 512]
const halo = { left: 2, top: 2, right: 2, bottom: 2 }
const quickMaxOutputPixels = 2_500_000
const channels = 3

function parseArgs(args) {
  let profile
  let nativeDir
  const unknownArgs = []

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--profile' || arg === '--native-dir') {
      const value = args[index + 1]
      if (!value || value.startsWith('--')) {
        throw new Error(`${arg} requires a value`)
      }
      if (arg === '--profile') profile = value
      else nativeDir = value
      index += 1
      continue
    }
    if (arg.startsWith('--profile=')) {
      profile = arg.slice('--profile='.length)
      continue
    }
    if (arg.startsWith('--native-dir=')) {
      nativeDir = arg.slice('--native-dir='.length)
      continue
    }
    unknownArgs.push(arg)
  }

  if (unknownArgs.length > 0) {
    throw new Error(`Unknown arguments: ${unknownArgs.join(', ')}`)
  }
  if (!nativeProfiles.includes(profile)) {
    throw new Error(
      `--profile must be one of ${nativeProfiles.join(', ')}, got ${JSON.stringify(profile)}`,
    )
  }

  return {
    profile,
    nativeDir: nativeDir ? path.resolve(nativeDir) : undefined,
  }
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function sampleBytes(samples) {
  return new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength)
}

function displayPath(absolutePath) {
  return path.relative(repoRoot, absolutePath) || absolutePath
}

async function loadFixture() {
  const lock = JSON.parse(await readFile(fixtureLockPath, 'utf8'))
  const fixture = lock.fixtures?.find((entry) => entry.name === fixtureName)
  if (
    typeof fixture?.file !== 'string' ||
    path.basename(fixture.file) !== fixture.file ||
    typeof fixture.sha256 !== 'string'
  ) {
    throw new Error(
      `Public fixture ${fixtureName} is not in ${fixtureLockPath}`,
    )
  }

  const fixturePath = path.join(fixturesDir, '.cache', 'public', fixture.file)
  if (!existsSync(fixturePath)) {
    throw new Error(
      `Missing public RAW fixture: ${fixturePath}\nRun \`pnpm --filter @lumaforge/luma-raw-runtime fixtures:fetch-public\` first.`,
    )
  }

  const buffer = await readFile(fixturePath)
  const data = new Uint8Array(
    buffer.buffer,
    buffer.byteOffset,
    buffer.byteLength,
  )
  const actualSha256 = sha256(data)
  if (actualSha256 !== fixture.sha256) {
    throw new Error(
      `Public RAW fixture SHA-256 mismatch: ${fixturePath}\nExpected: ${fixture.sha256}\nActual:   ${actualSha256}`,
    )
  }

  return {
    input: { data, name: fixture.file, size: data.byteLength },
    summary: { file: fixture.file, sha256: actualSha256 },
  }
}

function resolveArtifact(profile, nativeDir) {
  if (nativeDir) {
    const profileDir = path.join(nativeDir, profile)
    return {
      gluePath: path.join(profileDir, 'luma_raw.js'),
      wasmPath: path.join(profileDir, 'luma_raw.wasm'),
    }
  }

  // Same files @lumaforge/luma-native-artifacts/load-for-node reads for the
  // package Node entry.
  const loaderUrl = import.meta
    .resolve('@lumaforge/luma-native-artifacts/load-for-node')
  return {
    gluePath: fileURLToPath(
      new URL(`./native/${profile}/luma_raw.js`, loaderUrl),
    ),
    wasmPath: fileURLToPath(
      new URL(`./native/${profile}/luma_raw.wasm`, loaderUrl),
    ),
  }
}

function createDirectoryLoader(artifact) {
  return async () => {
    const wasmBinary = await readFile(artifact.wasmPath)
    const glueModule = await import(pathToFileURL(artifact.gluePath).href)
    return glueModule.default({ wasmBinary })
  }
}

function assertProcessedCapability(capability) {
  if (
    capability?.supported !== true ||
    capability.strategy !== 'libraw-processed-window' ||
    capability.windows?.librawProcessed !== true
  ) {
    throw new Error(
      `Processed-window export is unavailable for the fixture: ${JSON.stringify(
        {
          supported: capability?.supported,
          strategy: capability?.strategy,
          windows: capability?.windows,
          reasons: capability?.reasons,
        },
      )}`,
    )
  }
  if (
    !Number.isInteger(capability.width) ||
    !Number.isInteger(capability.height) ||
    capability.width <= 0 ||
    capability.height <= 0
  ) {
    throw new Error('Processed-window export capability has no frame size.')
  }
}

function planStrips(frame, stripRows) {
  const strips = []
  for (let y = 0; y < frame.height; y += stripRows) {
    strips.push({
      x: 0,
      y,
      width: frame.width,
      height: Math.min(stripRows, frame.height - y),
    })
  }
  return strips
}

function assertWindowShape(window, rect) {
  const rowSamples = rect.width * channels
  if (
    window.rect?.x !== rect.x ||
    window.rect?.y !== rect.y ||
    window.rect?.width !== rect.width ||
    window.rect?.height !== rect.height ||
    window.width !== rect.width ||
    window.height !== rect.height ||
    !(window.data instanceof Uint16Array) ||
    !Number.isInteger(window.stride) ||
    window.stride < rowSamples ||
    window.data.length < (rect.height - 1) * window.stride + rowSamples
  ) {
    throw new Error(
      `Processed window does not match the requested rect ${JSON.stringify(rect)}.`,
    )
  }
}

async function readAssembly(session, frame, stripRows, order) {
  const strips = planStrips(frame, stripRows)
  const readOrder = order === 'reverse' ? [...strips].reverse() : strips
  const rowSamples = frame.width * channels
  const samples = new Uint16Array(rowSamples * frame.height)

  for (const rect of readOrder) {
    const window = await session.readProcessedWindow({ outputRect: rect, halo })
    assertWindowShape(window, rect)
    for (let row = 0; row < rect.height; row += 1) {
      const start = row * window.stride
      samples.set(
        window.data.subarray(start, start + rowSamples),
        (rect.y + row) * rowSamples,
      )
    }
  }

  return {
    order,
    stripRows,
    strips,
    samples,
    sha256: sha256(sampleBytes(samples)),
  }
}

function compareStrip(reference, candidate, frame, strip) {
  const rowSamples = frame.width * channels
  const start = strip.y * rowSamples
  const end = start + strip.height * rowSamples
  let mismatchedSamples = 0
  let maxDelta = 0
  let referenceSum = 0
  let candidateSum = 0

  for (let index = start; index < end; index += 1) {
    const expected = reference[index]
    const actual = candidate[index]
    referenceSum += expected
    candidateSum += actual
    if (expected !== actual) {
      mismatchedSamples += 1
      const delta = Math.abs(expected - actual)
      if (delta > maxDelta) maxDelta = delta
    }
  }

  return {
    y: strip.y,
    rows: strip.height,
    mismatchedSamples,
    maxDelta,
    evOffset:
      referenceSum > 0 && candidateSum > 0
        ? Number(Math.log2(candidateSum / referenceSum).toFixed(6))
        : null,
  }
}

function compareAssembly(reference, candidate, frame) {
  const strips = candidate.strips.map((strip) =>
    compareStrip(reference.samples, candidate.samples, frame, strip),
  )
  const mismatchedSamples = strips.reduce(
    (total, strip) => total + strip.mismatchedSamples,
    0,
  )
  const maxDelta = strips.reduce(
    (largest, strip) => Math.max(largest, strip.maxDelta),
    0,
  )
  const lastStrip = strips.at(-1)
  const identical =
    mismatchedSamples === 0 &&
    maxDelta === 0 &&
    candidate.sha256 === reference.sha256

  return {
    order: candidate.order,
    stripRows: candidate.stripRows,
    windows: candidate.strips.length,
    sha256: candidate.sha256,
    mismatchedSamples,
    maxDelta,
    identical,
    lastStrip: {
      y: lastStrip.y,
      rows: lastStrip.rows,
      mismatchedSamples: lastStrip.mismatchedSamples,
    },
    differingStrips: strips.filter((strip) => strip.mismatchedSamples > 0),
  }
}

async function withExportSession(runtime, input, run) {
  const session = await runtime.openSession(input, {
    maxOutputPixels: quickMaxOutputPixels,
  })
  try {
    const capability = await session.probeExportCapability()
    assertProcessedCapability(capability)
    const frame = { width: capability.width, height: capability.height }
    await session.beginProcessedWindowExport()
    try {
      return await run(session, frame)
    } finally {
      await session.endProcessedWindowExport()
    }
  } finally {
    session.dispose()
  }
}

async function main() {
  const { profile, nativeDir } = parseArgs(process.argv.slice(2))

  if (!existsSync(nodeEntryPath)) {
    throw new Error(
      `Missing package Node entry: ${nodeEntryPath}\nRun \`pnpm --filter @lumaforge/luma-raw-runtime build\` first.`,
    )
  }
  const artifact = resolveArtifact(profile, nativeDir)
  for (const file of [artifact.gluePath, artifact.wasmPath]) {
    if (!existsSync(file)) {
      throw new Error(`Missing ${profile} native artifact: ${file}`)
    }
  }

  const fixture = await loadFixture()
  const { createLumaRawRuntimeForNode } = await import(
    pathToFileURL(nodeEntryPath).href
  )
  const runtime = await createLumaRawRuntimeForNode({
    memoryProfile: profile,
    ...(nativeDir ? { nativeLoader: createDirectoryLoader(artifact) } : {}),
  })

  try {
    const info = await runtime.init()

    const forward = await withExportSession(
      runtime,
      fixture.input,
      async (session, frame) => {
        const reference = await readAssembly(
          session,
          frame,
          frame.height,
          'forward',
        )
        const comparisons = []
        const sha256ByStripRows = new Map()
        for (const stripRows of stripRowCounts) {
          const assembly = await readAssembly(
            session,
            frame,
            stripRows,
            'forward',
          )
          sha256ByStripRows.set(stripRows, assembly.sha256)
          comparisons.push(compareAssembly(reference, assembly, frame))
        }
        return { frame, reference, comparisons, sha256ByStripRows }
      },
    )

    // A fresh session reading strips bottom-up must reproduce the same bytes,
    // so no state carries over between windows or sessions.
    const reverse = await withExportSession(
      runtime,
      fixture.input,
      async (session, frame) => {
        const comparisons = []
        for (const stripRows of stripRowCounts) {
          const assembly = await readAssembly(
            session,
            frame,
            stripRows,
            'reverse',
          )
          comparisons.push({
            ...compareAssembly(forward.reference, assembly, frame),
            matchesForwardOrder:
              assembly.sha256 === forward.sha256ByStripRows.get(stripRows),
          })
        }
        return comparisons
      },
    )

    const comparisons = [...forward.comparisons, ...reverse]
    const passed = comparisons.every(
      (comparison) =>
        comparison.identical && comparison.matchesForwardOrder !== false,
    )
    const summary = {
      check: 'window-normalization',
      passed,
      profile,
      runtime: { version: info.version, memoryProfile: info.memoryProfile },
      artifact: {
        wasm: displayPath(artifact.wasmPath),
        wasmSha256: sha256(await readFile(artifact.wasmPath)),
      },
      fixture: fixture.summary,
      frame: forward.frame,
      halo,
      reference: {
        stripRows: forward.frame.height,
        windows: 1,
        sha256: forward.reference.sha256,
      },
      comparisons,
      maxRssMiB: Math.round(process.resourceUsage().maxRSS / 1024),
    }

    console.log(JSON.stringify(summary, null, 2))
    if (!passed) {
      console.error(
        `Processed windows depend on the decoded region for the ${profile} profile.`,
      )
      process.exitCode = 1
    }
  } finally {
    runtime.dispose()
  }
}

try {
  await main()
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}
