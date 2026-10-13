import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import ts from 'typescript'

/**
 * Keeps retired public API retired. Three checks:
 * - no entry a checked package publishes exports a retired name, and no
 *   exported type regains a retired member (read with the TypeScript
 *   checker over the entry sources, so re-export chains count);
 * - no repository code or document outside a test names a retired
 *   identifier, and no code outside a test carries a `@deprecated` tag;
 * - the readers of data the deployed build writes to users' devices are
 *   still in place.
 *
 * Tests may name retired identifiers, since a test that asserts their
 * absence has to, and so may CHANGELOGs, which record their history. An
 * identifier is listed only when it can mean nothing but the retired API; a
 * generic export name (`OutputSink`) is retired from its package's surface
 * without being banned elsewhere.
 *
 * A listed type or reader that no longer exists, a published subpath missing
 * from `PACKAGE_ENTRIES`, and a re-export that does not resolve are errors,
 * so a rename never turns the check into a silent pass.
 */

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const SELF = 'scripts/quality/check-retired-api.mjs'

/** Names no published entry of the package may export. */
const RETIRED_EXPORTS = Object.freeze({
  '@lumaforge/render-engine': Object.freeze([
    // The context object and checkpoint journal no engine function took.
    'CheckpointStore',
    'ExportCheckpointManifest',
    'ExportInProgress',
    'JpegResumeState',
    'LumaRenderContext',
    'ManifestStore',
    'OutputIntent',
    'OutputSink',
    'OutputSinkHandle',
    'OutputSinkMeta',
    'OutputSinkResult',
    'ProfileCache',
    'ProfileFetchOptions',
    'ProfileFetcher',
    'RenderEvent',
    'ResumeFingerprint',
    'SourceReacquisitionMode',
    // Policy aliases and the Node default capability.
    'ExportFidelity',
    'NODE_DEFAULT_CAPABILITY',
    'RenderBudget',
    // The whole-buffer hash helper and in-memory JPEG sink.
    'BytesJpegEncoder',
    'BytesJpegRuntime',
    'createNodeJpegRowSink',
    'sourceContentIdFromFile',
    // The hash-only manifest params reader.
    'VerifiedManifestRenderParamsFailure',
    'VerifiedManifestRenderParamsResult',
    'readVerifiedManifestRenderParams',
    // Policy copy and inputs for a source reselection and a streaming sink.
    'ExportOrchestrationCopy',
    'ExportRuntimeResourcesInput',
  ]),
  '@lumaforge/luma-color-runtime': Object.freeze([
    // The duplicate color graph intent.
    'ProcessingParams',
    // Color intent whose HSL may be missing.
    'ColorGraphIntentSource',
    'UserColorIntentSource',
    // The binary LUT input projection.
    'LUTInputProfile',
    'inferLUTInputProfile',
    'toCompatInputProfile',
  ]),
  '@lumaforge/luma-raw-runtime': Object.freeze([
    // The SDR/HDR analysis that drove neither preview nor export.
    'RawDynamicRangeInfo',
    'analyzeRawDynamicRange',
    // The raw-mosaic window path.
    'LumaRawWindow',
    // The worker client and error normalizer behind createLumaRawRuntime.
    'LumaRawWorkerClient',
    'normalizeRawRuntimeError',
    // Runtime info and capability facts nothing read.
    'LumaRawExportDiagnostics',
    'LumaRawExportLevelFacts',
    'LumaRawMemoryTier',
  ]),
})

/** Members an exported type of the package may not regain. */
const RETIRED_MEMBERS = Object.freeze({
  '@lumaforge/luma-color-runtime': Object.freeze({
    // View state is not color.
    ColorGraphIntent: Object.freeze(['compareSplit', 'viewMode']),
    // The binary LUT input projection.
    LUTData: Object.freeze(['inputProfile']),
    ParsedLUT: Object.freeze(['inputProfile']),
    // The parser reads no stored contracts; the host restores them.
    ParseCubeOptions: Object.freeze(['lookupStoredProfile']),
    ResolveLUTProfileInput: Object.freeze([
      'fingerprint',
      'lookupStoredProfile',
    ]),
  }),
  '@lumaforge/render-engine': Object.freeze({
    // No writer records a Kelvin temperature.
    ColorBalanceParams: Object.freeze(['temp_k']),
    // No export state outlives an attempt and no host wires a streaming sink.
    ExportPolicy: Object.freeze(['persistEveryNRows']),
    ExportIntent: Object.freeze(['previousUserInterrupted']),
    ExportRuntimeResources: Object.freeze(['streamingSinkAvailable']),
    InteractivePolicy: Object.freeze(['allowConcurrentDecodeAndLutParse']),
  }),
  '@lumaforge/luma-raw-runtime': Object.freeze({
    // Decode through a session, not one-shot from the file.
    LumaRawRuntime: Object.freeze([
      'probe',
      'extractEmbeddedPreview',
      'decodeQuick',
      'decodeBoundedHq',
    ]),
    LumaRawDecodeSession: Object.freeze([
      'beginProcessedWindowExport',
      'endProcessedWindowExport',
      'readRawWindow',
    ]),
    // Facts and timings nothing read or wrote.
    LumaRawExportCapability: Object.freeze(['cfa', 'levels', 'diagnostics']),
    LumaRawExportSensorFacts: Object.freeze(['colorCount', 'phaseIsWindowLocal']),
    LumaRawRuntimeInfo: Object.freeze([
      'simd',
      'pthreads',
      'memoryTier',
      'workerPoolSize',
    ]),
    LumaRawTimings: Object.freeze([
      'transferToWorker',
      'process',
      'makeMemImage',
      'outputCopy',
      'transfer',
    ]),
  }),
})

/**
 * Identifiers no code or document outside a test may name: each can only
 * mean the retired API.
 */
const RETIRED_IDENTIFIERS = Object.freeze([
  'BytesJpegEncoder',
  'BytesJpegRuntime',
  'ColorGraphIntentSource',
  'ExportCheckpointManifest',
  'ExportFidelity',
  'ExportOrchestrationCopy',
  'ExportRuntimeResourcesInput',
  'JpegResumeState',
  'LUTInputProfile',
  'LumaRenderContext',
  'NODE_DEFAULT_CAPABILITY',
  'ProcessingParams',
  'RawDynamicRangeInfo',
  'RenderBudget',
  'ResumeFingerprint',
  'SourceReacquisitionMode',
  'UserColorIntentSource',
  'VerifiedManifestRenderParamsFailure',
  'VerifiedManifestRenderParamsResult',
  '__TEST_ONLY__',
  'analyzeRawDynamicRange',
  'createNodeJpegRowSink',
  'inferLUTInputProfile',
  'readVerifiedManifestRenderParams',
  'sourceContentIdFromFile',
  'toCompatInputProfile',
])

/**
 * Readers of data the deployed build writes to users' devices. They are
 * supported production code, not compatibility shims, and stay until that
 * data no longer exists.
 */
const SUPPORTED_DEVICE_DATA_READERS = Object.freeze([
  Object.freeze({
    file: 'src/lib/export/output-sink.ts',
    data: 'OPFS export outputs under .lumaforge-exports/active',
    names: Object.freeze(['OPFS_ACTIVE_DIRECTORY', 'OPFS_EXPORTS_DIRECTORY']),
  }),
  Object.freeze({
    file: 'src/lib/export/opfs-output-lifetime.ts',
    data: 'OPFS outputs written directly under active/ before tab directories',
    names: Object.freeze([
      'LEGACY_OPFS_OUTPUT_MAX_AGE_MS',
      'collectLegacyEntry',
      'readLegacyOutputTime',
    ]),
  }),
  Object.freeze({
    file: 'src/modules/raw-processor/services/look/online-lut-sources.ts',
    data: 'the online LUT source registry and its removed-default tombstones',
    names: Object.freeze([
      'LEGACY_DEFAULT_LUT_SOURCE_URLS',
      'removedDefaultUrls',
    ]),
  }),
])

/** The source file of every subpath each checked package publishes. */
const PACKAGE_ENTRIES = Object.freeze({
  '@lumaforge/luma-color-runtime': {
    '.': 'packages/luma-color-runtime/src/index.ts',
    './wgsl': 'packages/luma-color-runtime/src/wgsl.ts',
  },
  '@lumaforge/luma-raw-runtime': {
    '.': 'packages/luma-raw-runtime/src/index.ts',
    './node': 'packages/luma-raw-runtime/src/runtime-node.ts',
  },
  '@lumaforge/render-engine': {
    './export': 'packages/render-engine/src/export/index.ts',
    './geometry': 'packages/render-engine/src/geometry/index.ts',
    './manifest': 'packages/render-engine/src/manifest/index.ts',
    './policy': 'packages/render-engine/src/policy/index.ts',
    './preview': 'packages/render-engine/src/preview/index.ts',
  },
})

const CODE = /\.(?:[cm]?[jt]s|[jt]sx|wgsl)$/
const SCANNED = /\.(?:[cm]?[jt]s|[jt]sx|wgsl|md)$/
const TEST_FILE = /(?:^|\/)__tests__\/|\.(?:test|spec)\.[cm]?[jt]sx?$/
const CHANGELOG = /(?:^|\/)CHANGELOG\.md$/
const DEPRECATED_TAG = /@deprecated\b/

function wordPattern(names) {
  const alternatives = names.map((name) => name.replaceAll('$', '\\$'))
  return new RegExp(`(?<![\\w$])(?:${alternatives.join('|')})(?![\\w$])`, 'g')
}

/**
 * Retired identifiers and `@deprecated` tags outside tests.
 * @param {{ files: string[], readFile: (path: string) => string,
 *   identifiers?: readonly string[] }} input
 */
export function scanSources({
  files,
  readFile,
  identifiers = RETIRED_IDENTIFIERS,
}) {
  const problems = []
  const pattern = wordPattern(identifiers)
  for (const file of files) {
    if (!SCANNED.test(file) || TEST_FILE.test(file)) continue
    if (CHANGELOG.test(file) || file === SELF) continue
    readFile(file)
      .split('\n')
      .forEach((line, index) => {
        for (const [name] of line.matchAll(pattern)) {
          problems.push(`${file}:${index + 1} names retired ${name}`)
        }
        if (CODE.test(file) && DEPRECATED_TAG.test(line)) {
          problems.push(
            `${file}:${index + 1} declares @deprecated; remove the export instead`,
          )
        }
      })
  }
  return problems
}

/** The supported device-data readers that are gone. */
export function checkSupportedReaders({
  files,
  readFile,
  readers = SUPPORTED_DEVICE_DATA_READERS,
}) {
  const problems = []
  for (const reader of readers) {
    if (!files.includes(reader.file)) {
      problems.push(`${reader.file} is gone, but it reads ${reader.data}`)
      continue
    }
    const text = readFile(reader.file)
    for (const name of reader.names) {
      if (!wordPattern([name]).test(text)) {
        problems.push(
          `${reader.file} no longer has ${name}, which reads ${reader.data}`,
        )
      }
    }
  }
  return problems
}

/**
 * Retired exports and members on the published entries, read by one
 * TypeScript program in which workspace packages resolve to their sources
 * through `paths`.
 * @param {{ root: string, entries?: Record<string, Record<string, string>>,
 *   paths?: Record<string, string[]>,
 *   retiredExports?: Record<string, readonly string[]>,
 *   retiredMembers?: Record<string, Record<string, readonly string[]>> }} input
 */
export function checkPublicSurface({
  root,
  entries = PACKAGE_ENTRIES,
  paths = {},
  retiredExports = RETIRED_EXPORTS,
  retiredMembers = RETIRED_MEMBERS,
}) {
  const problems = []
  const options = {
    allowJs: true,
    baseUrl: root,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    noEmit: true,
    paths,
    skipLibCheck: true,
    target: ts.ScriptTarget.ESNext,
    types: [],
  }
  const rootNames = Object.values(entries).flatMap((subpaths) =>
    Object.values(subpaths).map((file) => join(root, file)),
  )
  const program = ts.createProgram({ rootNames, options })
  const checker = program.getTypeChecker()
  const repoPath = (file) => relative(root, file).split(sep).join('/')

  // A re-export the checker cannot follow would hide the names behind it.
  for (const source of program.getSourceFiles()) {
    const file = repoPath(source.fileName)
    if (file.startsWith('../') || file.includes('node_modules/')) continue
    for (const statement of source.statements) {
      const specifier = ts.isExportDeclaration(statement)
        ? statement.moduleSpecifier
        : undefined
      if (!specifier || !ts.isStringLiteral(specifier)) continue
      const { resolvedModule } = ts.resolveModuleName(
        specifier.text,
        source.fileName,
        options,
        ts.sys,
      )
      if (!resolvedModule) {
        problems.push(
          `${file} re-exports ${specifier.text}, which does not resolve`,
        )
      }
    }
  }

  // A union's own properties are only those every branch shares, so each
  // part of a union or intersection is read on its own.
  const membersOf = (type) =>
    type.isUnionOrIntersection()
      ? type.types.flatMap(membersOf)
      : checker.getPropertiesOfType(type).map((property) => property.name)

  for (const [name, subpaths] of Object.entries(entries)) {
    const typesFound = new Set()
    for (const [subpath, file] of Object.entries(subpaths)) {
      const specifier = subpath === '.' ? name : `${name}/${subpath.slice(2)}`
      const source = program.getSourceFile(join(root, file))
      const moduleSymbol = source && checker.getSymbolAtLocation(source)
      if (!moduleSymbol) {
        problems.push(`${specifier} (${file}) is not a module`)
        continue
      }
      for (const retired of retiredExports[name] ?? []) {
        if (checker.tryGetMemberInModuleExports(retired, moduleSymbol)) {
          problems.push(`${specifier} exports retired ${retired}`)
        }
      }
      for (const [typeName, members] of Object.entries(
        retiredMembers[name] ?? {},
      )) {
        let exported = checker.tryGetMemberInModuleExports(
          typeName,
          moduleSymbol,
        )
        if (!exported) continue
        typesFound.add(typeName)
        if (exported.flags & ts.SymbolFlags.Alias) {
          exported = checker.getAliasedSymbol(exported)
        }
        const found = membersOf(checker.getDeclaredTypeOfSymbol(exported))
        for (const member of members) {
          if (found.includes(member)) {
            problems.push(
              `${specifier} ${typeName} has retired member ${member}`,
            )
          }
        }
      }
    }
    for (const typeName of Object.keys(retiredMembers[name] ?? {})) {
      if (!typesFound.has(typeName)) {
        problems.push(
          `${name} exports no ${typeName}; update its retired members`,
        )
      }
    }
  }
  return problems
}

/** Published subpaths of the checked packages that `entries` does not map. */
function checkEntryList({
  root,
  entries = PACKAGE_ENTRIES,
  retiredExports = RETIRED_EXPORTS,
  retiredMembers = RETIRED_MEMBERS,
}) {
  const problems = []
  const checked = new Set([
    ...Object.keys(retiredExports),
    ...Object.keys(retiredMembers),
  ])
  for (const name of checked) {
    const dir = `packages/${name.split('/')[1]}`
    const manifest = JSON.parse(
      readFileSync(join(root, dir, 'package.json'), 'utf8'),
    )
    const published = Object.keys(manifest.exports ?? {}).sort()
    const mapped = Object.keys(entries[name] ?? {}).sort()
    if (manifest.name !== name || published.join() !== mapped.join()) {
      problems.push(
        `${dir} publishes ${published.join(', ')}; map exactly those in PACKAGE_ENTRIES`,
      )
    }
  }
  return problems
}

function listRepoFiles(root) {
  const output = execFileSync(
    'git',
    ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
    { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  )
  return output
    .split('\0')
    .filter((file) => file && existsSync(join(root, file)))
}

function runRetiredApiCheck(root = ROOT) {
  const files = listRepoFiles(root)
  const readFile = (path) => readFileSync(join(root, path), 'utf8')
  const tsconfig = ts.readConfigFile(
    join(root, 'tsconfig.json'),
    ts.sys.readFile,
  )
  return [
    ...scanSources({ files, readFile }),
    ...checkSupportedReaders({ files, readFile }),
    ...checkEntryList({ root }),
    ...checkPublicSurface({
      root,
      paths: tsconfig.config.compilerOptions.paths,
    }),
  ]
}

if (import.meta.main) {
  const problems = runRetiredApiCheck()
  for (const problem of problems) console.error(problem)
  if (problems.length === 0) console.log('retired API: none in use')
  process.exitCode = problems.length === 0 ? 0 : 1
}
