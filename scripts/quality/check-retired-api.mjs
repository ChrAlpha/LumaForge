import { readFileSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import {
  listRepoFiles,
  loadTypeScript as loadCompiler,
  publishedEntries,
  readWorkspacePackages,
} from './check-structure.mjs'
import { isMainModule } from './is-main-module.mjs'

/**
 * Keeps retired public API retired. Three bounded checks:
 * - no entry a workspace package publishes exports a retired name, and no
 *   exported type regains a retired member (read with the TypeScript
 *   checker, so re-export chains count);
 * - no repository code or document outside a test names a retired
 *   identifier, and no code outside a test carries a `@deprecated` tag;
 * - the readers of data the deployed build writes to users' devices are
 *   still in place.
 *
 * Only the names listed below are retired. Tests may name them, since a
 * test that asserts their absence has to, and so may CHANGELOGs, which
 * record their history. An identifier is listed only when it can mean
 * nothing but the retired API: words such as `legacy`, `optional`, or
 * `compat` are never banned, and a generic export name (`OutputSink`) is
 * retired from its package's surface without being banned elsewhere.
 *
 * A listed package, type, or reader that no longer exists is an error, as
 * is a re-export the checker cannot resolve, so a rename never turns the
 * check into a silent pass.
 */

const REPO_ROOT = resolve(fileURLToPath(new URL('../../', import.meta.url)))
const SELF = 'scripts/quality/check-retired-api.mjs'

/** Names no published entry of the package may export. */
export const RETIRED_EXPORTS = Object.freeze({
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
  ]),
  '@lumaforge/luma-color-runtime': Object.freeze([
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
  ]),
})

/** Members an exported type of the package may not regain. */
export const RETIRED_MEMBERS = Object.freeze({
  '@lumaforge/luma-color-runtime': Object.freeze({
    // View state is not color.
    ColorGraphIntent: Object.freeze(['compareSplit', 'viewMode']),
    ProcessingParams: Object.freeze(['compareSplit', 'viewMode']),
    // The binary LUT input projection.
    LUTData: Object.freeze(['inputProfile']),
    ParsedLUT: Object.freeze(['inputProfile']),
  }),
  '@lumaforge/render-engine': Object.freeze({
    // No writer records a Kelvin temperature.
    ColorBalanceParams: Object.freeze(['temp_k']),
  }),
})

/**
 * Identifiers no code or document outside a test may name: each can only
 * mean the retired API.
 */
export const RETIRED_IDENTIFIERS = Object.freeze([
  'BytesJpegEncoder',
  'BytesJpegRuntime',
  'ColorGraphIntentSource',
  'ExportCheckpointManifest',
  'ExportFidelity',
  'JpegResumeState',
  'LUTInputProfile',
  'LumaRenderContext',
  'NODE_DEFAULT_CAPABILITY',
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
export const SUPPORTED_DEVICE_DATA_READERS = Object.freeze([
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

const CODE = /\.(?:[cm]?[jt]s|[jt]sx|wgsl)$/
const SCANNED = /\.(?:[cm]?[jt]s|[jt]sx|wgsl|md)$/
const TEST_FILE = /(?:^|\/)__tests__\/|\.(?:test|spec)\.[cm]?[jt]sx?$/
const CHANGELOG = /(?:^|\/)CHANGELOG\.md$/
const IDENTIFIER = /^[a-z_$][\w$]*$/i
const DEPRECATED_TAG = /@deprecated\b/

/**
 * The most combinations of the files forked package specifiers lead to that
 * one check reads, each with a program of its own.
 */
const MAX_RESOLUTIONS = 16

/** A file that may name retired identifiers: a test, a CHANGELOG, or this list. */
export function mayNameRetired(file) {
  return TEST_FILE.test(file) || CHANGELOG.test(file) || file === SELF
}

/** Matches any of `names` as a whole identifier; `names` is not empty. */
function wordPattern(names) {
  const alternatives = [...names]
    .sort((a, b) => b.length - a.length)
    .map((name) => name.replaceAll('$', '\\$'))
  return new RegExp(`(?<![\\w$])(?:${alternatives.join('|')})(?![\\w$])`, 'g')
}

/**
 * Problems in the lists themselves: a malformed or generic identifier, or a
 * supported reader name that is also retired.
 */
export function checkLists({
  retiredExports = RETIRED_EXPORTS,
  retiredMembers = RETIRED_MEMBERS,
  identifiers = RETIRED_IDENTIFIERS,
  readers = SUPPORTED_DEVICE_DATA_READERS,
} = {}) {
  const problems = []
  const exported = Object.values(retiredExports).flat()
  for (const name of [
    ...exported,
    ...identifiers,
    ...Object.values(retiredMembers).flatMap((types) => [
      ...Object.keys(types),
      ...Object.values(types).flat(),
    ]),
  ]) {
    if (typeof name !== 'string' || !IDENTIFIER.test(name)) {
      problems.push(`retired name ${JSON.stringify(name)} is not an identifier`)
    }
  }
  for (const name of identifiers) {
    // A compound name (a case change or an underscore) cannot be a plain
    // word such as `legacy` or `optional`.
    if (typeof name === 'string' && !/[a-z][A-Z]|_/.test(name)) {
      problems.push(
        `retired identifier ${name} is a plain word; retire it from a package surface instead`,
      )
    }
  }
  const retired = new Set([...exported, ...identifiers])
  for (const reader of readers) {
    for (const name of reader.names) {
      if (retired.has(name)) {
        problems.push(`${name} reads ${reader.data} and cannot also be retired`)
      }
    }
  }
  return problems
}

/**
 * Retired identifiers outside tests and `@deprecated` tags outside tests.
 * @param {{ files: string[], readFile: (path: string) => string,
 *   identifiers?: readonly string[] }} input
 * @returns {string[]}
 */
export function scanSources({
  files,
  readFile,
  identifiers = RETIRED_IDENTIFIERS,
}) {
  const problems = []
  const pattern = identifiers.length > 0 ? wordPattern(identifiers) : null
  for (const file of files) {
    if (!SCANNED.test(file) || mayNameRetired(file)) continue
    const lines = readFile(file).split('\n')
    lines.forEach((line, index) => {
      for (const [name] of pattern ? line.matchAll(pattern) : []) {
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

/**
 * The supported device-data readers that are gone.
 * @param {{ files: string[], readFile: (path: string) => string,
 *   readers?: typeof SUPPORTED_DEVICE_DATA_READERS }} input
 */
export function checkSupportedReaders({
  files,
  readFile,
  readers = SUPPORTED_DEVICE_DATA_READERS,
}) {
  const problems = []
  const fileSet = new Set(files)
  for (const reader of readers) {
    if (!fileSet.has(reader.file)) {
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
 * Retired exports and members on the published entries, read with the
 * TypeScript checker over the package sources.
 * @param {{ root: string, files: string[], readFile: (path: string) => string,
 *   retiredExports?: Record<string, readonly string[]>,
 *   retiredMembers?: Record<string, Record<string, readonly string[]>>,
 *   loadTypeScript?: () => Promise<typeof import('typescript')> }} input
 * @returns {Promise<string[]>}
 */
export async function checkPublicSurface({
  root,
  files,
  readFile,
  retiredExports = RETIRED_EXPORTS,
  retiredMembers = RETIRED_MEMBERS,
  loadTypeScript = loadCompiler,
}) {
  const ts = await loadTypeScript()
  const problems = []
  const fileSet = new Set(files)
  const workspaces = readWorkspacePackages(files, readFile, ts)
  // Every file each specifier's conditions lead to, in condition order.
  const sources = new Map()
  const entriesByPackage = new Map()
  for (const workspace of workspaces) {
    // Each export condition can lead to its own file, so every one is read.
    const targets = publishedEntries(workspace, fileSet).filter(
      ({ specifier }) => !specifier.startsWith('bin '),
    )
    const entries = []
    for (const { specifier, condition, source, problem } of targets) {
      if (!source) {
        entries.push({ specifier, condition, problem })
        continue
      }
      const path = `./${workspace.dir}/${source}`
      const known = sources.get(specifier) ?? []
      if (!known.includes(path)) sources.set(specifier, [...known, path])
      const same = entries.find(
        (entry) => entry.specifier === specifier && entry.source === source,
      )
      if (same) same.condition += `, ${condition}`
      else entries.push({ specifier, condition, source })
    }
    entriesByPackage.set(String(workspace.manifest.name), {
      workspace,
      entries,
    })
  }

  const checked = [
    ...new Set([
      ...Object.keys(retiredExports),
      ...Object.keys(retiredMembers),
    ]),
  ].sort()
  const unmapped = ({ specifier, condition, problem }) =>
    `${specifier}${condition ? ` ${condition}` : ''} has no source file${problem ? `: ${problem}` : ''}`
  const rootNames = []
  for (const name of checked) {
    const found = entriesByPackage.get(name)
    if (!found) {
      problems.push(`${name} names no workspace package`)
      continue
    }
    if (found.entries.length === 0) {
      problems.push(`${name} publishes no entry`)
    }
    for (const entry of found.entries) {
      if (!entry.source) problems.push(unmapped(entry))
      else rootNames.push(join(root, found.workspace.dir, entry.source))
    }
  }
  // Every other package's entries are what its specifiers resolve to here;
  // one without a source would resolve to whatever the checkout holds.
  for (const [name, { entries }] of entriesByPackage) {
    if (checked.includes(name)) continue
    for (const entry of entries) {
      if (!entry.source) problems.push(unmapped(entry))
    }
  }
  if (rootNames.length === 0) return problems

  // A specifier whose conditions lead to different files is read as each of
  // them by some consumer, and an import of it can sit anywhere in a chain,
  // so every combination of those files is read with a program of its own.
  const forked = [...sources].filter(([, paths]) => paths.length > 1)
  const count = forked.reduce((product, [, paths]) => product * paths.length, 1)
  if (count > MAX_RESOLUTIONS) {
    problems.push(
      `${forked.map(([specifier]) => specifier).join(', ')} resolve to ${count} combinations of sources; at most ${MAX_RESOLUTIONS} are read`,
    )
    return problems
  }
  let resolutions = [new Map()]
  for (const [specifier, paths] of forked) {
    resolutions = resolutions.flatMap((chosen) =>
      paths.map((path) => new Map([...chosen, [specifier, path]])),
    )
  }
  const reported = new Set()
  for (const chosen of resolutions) {
    const label = forked
      .filter(([specifier, paths]) => chosen.get(specifier) !== paths[0])
      .map(([specifier]) => `${specifier} at ${chosen.get(specifier).slice(2)}`)
      .join(', ')
    const paths = Object.fromEntries(
      Array.from(sources, ([specifier, list]) => [
        specifier,
        [chosen.get(specifier) ?? list[0]],
      ]),
    )
    for (const problem of surfaceProblems({
      ts,
      root,
      rootNames,
      paths,
      checked,
      entriesByPackage,
      retiredExports,
      retiredMembers,
    })) {
      if (reported.has(problem)) continue
      reported.add(problem)
      problems.push(label ? `${problem} (with ${label})` : problem)
    }
  }
  return problems
}

/**
 * Retired exports and members on the published entries, read by one program
 * in which each workspace package specifier resolves to the file `paths`
 * names.
 */
function surfaceProblems({
  ts,
  root,
  rootNames,
  paths,
  checked,
  entriesByPackage,
  retiredExports,
  retiredMembers,
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
  const program = ts.createProgram({ rootNames, options })
  const checker = program.getTypeChecker()

  // A re-export the checker cannot follow would hide the names behind it.
  const repoPath = (fileName) => relative(root, fileName).split(sep).join('/')
  const inRepo = (fileName) =>
    !repoPath(fileName).startsWith('../') &&
    !repoPath(fileName).split('/').includes('node_modules')
  for (const source of program.getSourceFiles()) {
    if (!inRepo(source.fileName) || source.isDeclarationFile) continue
    for (const statement of source.statements) {
      if (
        !ts.isExportDeclaration(statement) ||
        !statement.moduleSpecifier ||
        !ts.isStringLiteral(statement.moduleSpecifier)
      ) {
        continue
      }
      const specifier = statement.moduleSpecifier.text
      const resolved = ts.resolveModuleName(
        specifier,
        source.fileName,
        options,
        ts.sys,
      ).resolvedModule
      if (!resolved) {
        problems.push(
          `${repoPath(source.fileName)} re-exports ${specifier}, which does not resolve`,
        )
      }
    }
  }

  // A union's own properties are only those every branch shares, so a
  // retired member that one branch still accepts would pass unseen; each
  // part of a union or intersection is read on its own. Any other type that
  // is not an object (a conditional type, a type parameter, an indexed
  // access) has no members to read, so it is not enumerable.
  const membersOf = (type, names = new Set()) => {
    if (type.isUnionOrIntersection()) {
      for (const part of type.types) {
        if (!membersOf(part, names)) return undefined
      }
      return names
    }
    if (!(type.flags & ts.TypeFlags.Object)) return undefined
    for (const property of checker.getPropertiesOfType(type)) {
      names.add(property.name)
    }
    return names
  }
  // A generic type can carry members in an instantiation its declared type
  // does not show.
  const isGeneric = (symbol) =>
    (symbol.declarations ?? []).some(
      (declaration) => (declaration.typeParameters?.length ?? 0) > 0,
    )
  const moduleOf = (path) => {
    const source = program.getSourceFile(path)
    return source && checker.getSymbolAtLocation(source)
  }
  for (const name of checked) {
    const found = entriesByPackage.get(name)
    if (!found) continue
    const exporting = new Map()
    for (const entry of found.entries) {
      const { source } = entry
      if (!source) continue
      const specifier = `${entry.specifier} (${entry.condition})`
      const moduleSymbol = moduleOf(join(root, found.workspace.dir, source))
      if (!moduleSymbol) {
        problems.push(`${specifier} is not a module`)
        continue
      }
      for (const retired of retiredExports[name] ?? []) {
        if (checker.tryGetMemberInModuleExports(retired, moduleSymbol)) {
          problems.push(`${specifier} exports retired ${retired}`)
        }
      }
      for (const typeName of Object.keys(retiredMembers[name] ?? {})) {
        const exported = checker.tryGetMemberInModuleExports(
          typeName,
          moduleSymbol,
        )
        if (!exported) continue
        exporting.set(typeName, (exporting.get(typeName) ?? 0) + 1)
        const declared =
          exported.flags & ts.SymbolFlags.Alias
            ? checker.getAliasedSymbol(exported)
            : exported
        const members = isGeneric(declared)
          ? undefined
          : membersOf(checker.getDeclaredTypeOfSymbol(declared))
        if (!members) {
          problems.push(
            `${specifier} ${typeName} cannot be enumerated (generic or conditional type)`,
          )
          continue
        }
        for (const member of retiredMembers[name][typeName]) {
          if (members.has(member)) {
            problems.push(
              `${specifier} ${typeName} has retired member ${member}`,
            )
          }
        }
      }
    }
    for (const typeName of Object.keys(retiredMembers[name] ?? {})) {
      if (!exporting.has(typeName)) {
        problems.push(
          `${name} exports no ${typeName}; update its retired members`,
        )
      }
    }
  }
  return problems
}

/**
 * Runs every check over a checkout.
 * @param {{ root?: string, files?: string[],
 *   readFile?: (path: string) => string }} [input]
 */
export async function runRetiredApiCheck({
  root = REPO_ROOT,
  files = listRepoFiles(root),
  readFile = (path) => readFileSync(join(root, path), 'utf8'),
} = {}) {
  return [
    ...checkLists(),
    ...scanSources({ files, readFile }),
    ...checkSupportedReaders({ files, readFile }),
    ...(await checkPublicSurface({ root, files, readFile })),
  ]
}

if (isMainModule(import.meta.url)) {
  const args = process.argv.slice(2)
  if (args.length > 0) {
    console.error(`Unknown argument ${args[0]}. Usage: check-retired-api.mjs`)
    process.exitCode = 2
  } else {
    const problems = await runRetiredApiCheck()
    for (const problem of problems) console.error(problem)
    if (problems.length === 0) console.log('retired API: none in use')
    process.exitCode = problems.length === 0 ? 0 : 1
  }
}
