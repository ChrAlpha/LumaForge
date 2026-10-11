import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import {
  dirname,
  isAbsolute,
  join,
  matchesGlob,
  posix,
  relative,
  resolve,
  sep,
} from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { isMainModule } from './is-main-module.mjs'

/**
 * Blocks dead code and dependency cycles. It runs knip (unused files,
 * exports, types, dependencies, unresolved imports, duplicate exports) and
 * madge (import cycles), and passes only when neither finds anything. There
 * are no exceptions: every finding fails the check, and so does any entry in
 * `scripts/quality/baseline.json`, which only records the tool versions the
 * check was reviewed with. An older branch whose baseline still lists
 * entries drops the resolved ones with `--prune`; `--prune` never adds one.
 *
 * Findings are reported as identities:
 * - a knip finding is `<issue type> <file>: <symbol>`, or `files <file>` for
 *   an unused file;
 * - a cycle is its module paths joined by ` > `, rotated to start at the
 *   smallest path so the same cycle always reads the same way.
 * Paths are relative to the repository root; line numbers and columns are
 * dropped, so moving code never changes an identity.
 *
 * knip runs in its default mode with `scripts/quality/knip.json`: tests and
 * tool configs count as consumers, so a test helper is not dead code, while a
 * symbol nothing imports is. Exports used inside their own module are not
 * reported because that code is alive. The entry list names the routes,
 * workers, scripts, CLI bins, and the source of every published package
 * export; exports of an entry file are public surface and never reported.
 * This script checks that every published export and bin has such an entry,
 * that every workspace package has a knip workspace, and that every entry and
 * project pattern matches a repository file.
 *
 * madge reads the repository's source files (Git tracked or trackable, so
 * generated and build output is absent everywhere) with the root tsconfig
 * paths, extended so each workspace package export resolves to its source.
 *
 * A tool that fails, a report that does not have the expected shape, an
 * import madge cannot resolve, or tool versions that differ from the ones the
 * baseline was recorded with are errors, never an empty report.
 *
 * `--prune` also writes the baseline without its resolved entries.
 * `--print [--root <checkout>]` prints the findings of a checkout in baseline
 * form without checking them; that is how a tool upgrade is reviewed before
 * its version is recorded.
 */

const REPO_ROOT = resolve(fileURLToPath(new URL('../../', import.meta.url)))
const KNIP_CONFIG = fileURLToPath(new URL('knip.json', import.meta.url))
const BASELINE_PATH = fileURLToPath(new URL('baseline.json', import.meta.url))

/** Issue types every knip 6 JSON report entry lists, in default mode. */
export const KNIP_ISSUE_TYPES = [
  'binaries',
  'catalog',
  'catalogReferences',
  'dependencies',
  'devDependencies',
  'duplicates',
  'enumMembers',
  'exports',
  'files',
  'namespaceMembers',
  'optionalPeerDependencies',
  'types',
  'unlisted',
  'unresolved',
]

/** Report entry keys that are not issue types. */
const KNIP_ENTRY_FIELDS = new Set(['file', 'owners'])

const MODULE_EXTENSIONS = new Set([
  'cjs',
  'cts',
  'js',
  'mjs',
  'mts',
  'ts',
  'tsx',
])
const DECLARATION = /\.d\.[cm]?ts$/
const CYCLE_SEPARATOR = ' > '
const COMMIT = /^[\da-f]{40}$/

const KNIP_TIMEOUT_MS = 10 * 60 * 1000

export class UsageError extends Error {}

/** A tool failed, or its output cannot be trusted as a complete report. */
export class ToolError extends Error {}

/** The checked-in baseline or tool configuration is malformed. */
export class ConfigError extends Error {}

const byCodeUnit = (a, b) => (a < b ? -1 : a > b ? 1 : 0)

function sortedUnique(values) {
  return [...new Set(values)].sort(byCodeUnit)
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * A tool-reported path as a repository-relative POSIX path.
 * @param {unknown} path
 * @param {string} root Absolute repository root.
 * @param {string} what Names the value in an error.
 */
function toRepoPath(path, root, what) {
  if (typeof path !== 'string' || path === '') {
    throw new ToolError(`${what} is not a path: ${JSON.stringify(path)}`)
  }
  const relativePath = isAbsolute(path) ? relative(root, path) : path
  const normalized = posix.normalize(relativePath.split(sep).join('/'))
  if (
    normalized === '.' ||
    normalized.startsWith('../') ||
    normalized === '..' ||
    isAbsolute(normalized)
  ) {
    throw new ToolError(`${what} is outside the repository: ${path}`)
  }
  return normalized
}

function issueName(item, where) {
  if (!isRecord(item) || typeof item.name !== 'string' || item.name === '') {
    throw new ToolError(`${where} has an issue without a name`)
  }
  if (item.namespace === undefined) return item.name
  if (typeof item.namespace !== 'string' || item.namespace === '') {
    throw new ToolError(`${where} has an issue with a malformed namespace`)
  }
  return `${item.namespace}.${item.name}`
}

/**
 * Normalizes a knip JSON report to sorted, unique finding identities.
 * @param {unknown} report Parsed `knip --reporter json` output.
 * @param {{ root?: string }} [options] Root for absolute paths.
 * @returns {string[]}
 */
export function normalizeKnipReport(report, { root = REPO_ROOT } = {}) {
  if (!isRecord(report) || !Array.isArray(report.issues)) {
    throw new ToolError('knip report has no issues array')
  }
  const unexpected = Object.keys(report).filter((key) => key !== 'issues')
  if (unexpected.length > 0) {
    throw new ToolError(`knip report has unknown fields: ${unexpected}`)
  }

  const identities = []
  for (const entry of report.issues) {
    if (!isRecord(entry))
      throw new ToolError('knip report entry is not an object')
    const file = toRepoPath(entry.file, root, 'knip report entry file')
    const where = `knip report entry ${file}`
    const types = Object.keys(entry).filter(
      (key) => !KNIP_ENTRY_FIELDS.has(key),
    )
    const missing = KNIP_ISSUE_TYPES.filter((type) => !types.includes(type))
    const unknown = types.filter((type) => !KNIP_ISSUE_TYPES.includes(type))
    if (missing.length > 0 || unknown.length > 0) {
      throw new ToolError(
        `${where} does not list the expected issue types (missing: ${
          missing.join(', ') || 'none'
        }; unknown: ${unknown.join(', ') || 'none'})`,
      )
    }
    for (const type of KNIP_ISSUE_TYPES) {
      const items = entry[type]
      if (!Array.isArray(items)) {
        throw new ToolError(`${where} has a non-array ${type} field`)
      }
      for (const item of items) {
        if (type === 'files') {
          if (!isRecord(item))
            throw new ToolError(`${where} has a malformed file`)
          identities.push(
            `files ${toRepoPath(item.name, root, `${where} file`)}`,
          )
        } else if (type === 'duplicates') {
          if (!Array.isArray(item) || item.length < 2) {
            throw new ToolError(`${where} has a malformed duplicate export`)
          }
          const names = item.map((member) => issueName(member, where))
          identities.push(`${type} ${file}: ${sortedUnique(names).join(', ')}`)
        } else {
          identities.push(`${type} ${file}: ${issueName(item, where)}`)
        }
      }
    }
  }
  return sortedUnique(identities)
}

/**
 * One cycle as an identity: its paths rotated to start at the smallest one,
 * keeping their order, joined by ` > `.
 * @param {unknown} cycle Module paths in import order.
 * @param {{ root?: string }} [options]
 */
export function canonicalCycle(cycle, { root = REPO_ROOT } = {}) {
  if (!Array.isArray(cycle) || cycle.length === 0) {
    throw new ToolError(`malformed cycle: ${JSON.stringify(cycle)}`)
  }
  const paths = cycle.map((path) => toRepoPath(path, root, 'cycle member'))
  if (new Set(paths).size !== paths.length) {
    throw new ToolError(
      `cycle repeats a module: ${paths.join(CYCLE_SEPARATOR)}`,
    )
  }
  const start = paths.indexOf([...paths].sort(byCodeUnit)[0])
  return [...paths.slice(start), ...paths.slice(0, start)].join(CYCLE_SEPARATOR)
}

/**
 * @param {unknown} cycles madge `circular()` output.
 * @param {{ root?: string }} [options]
 * @returns {string[]}
 */
export function normalizeCycles(cycles, options) {
  if (!Array.isArray(cycles))
    throw new ToolError('madge cycles are not an array')
  return sortedUnique(cycles.map((cycle) => canonicalCycle(cycle, options)))
}

function checkIdentityList(list, name, isWellFormed) {
  if (!Array.isArray(list) || list.some((item) => typeof item !== 'string')) {
    throw new ConfigError(`baseline ${name} must be an array of strings`)
  }
  const malformed = list.find((item) => !isWellFormed(item))
  if (malformed !== undefined) {
    throw new ConfigError(`baseline ${name} entry is malformed: ${malformed}`)
  }
  const canonical = sortedUnique(list)
  if (
    canonical.length !== list.length ||
    canonical.some((item, index) => item !== list[index])
  ) {
    throw new ConfigError(
      `baseline ${name} must be sorted and free of duplicates`,
    )
  }
}

function isKnipIdentity(identity) {
  const match = /^(\S+) (\S.*)$/.exec(identity)
  if (!match || !KNIP_ISSUE_TYPES.includes(match[1])) return false
  return match[1] === 'files'
    ? !match[2].includes(': ')
    : /^\S.*: \S/.test(match[2])
}

function isCycleIdentity(identity) {
  try {
    return canonicalCycle(identity.split(CYCLE_SEPARATOR)) === identity
  } catch {
    return false
  }
}

/**
 * Validates the shape of the baseline file. Listed entries are well-formed
 * here so `--prune` can read an older baseline; `runCheck` fails them.
 * @param {unknown} value Parsed `baseline.json`.
 * @returns {{ source: string, tools: { knip: string, madge: string },
 *   knip: string[], cycles: string[] }}
 */
export function parseBaseline(value) {
  const keys = ['source', 'tools', 'knip', 'cycles']
  if (
    !isRecord(value) ||
    Object.keys(value).length !== keys.length ||
    !keys.every((key) => Object.hasOwn(value, key))
  ) {
    throw new ConfigError(`baseline must have exactly: ${keys.join(', ')}`)
  }
  if (typeof value.source !== 'string' || !COMMIT.test(value.source)) {
    throw new ConfigError('baseline source must be a full commit SHA')
  }
  const { tools } = value
  if (
    !isRecord(tools) ||
    Object.keys(tools).sort().join() !== 'knip,madge' ||
    typeof tools.knip !== 'string' ||
    typeof tools.madge !== 'string'
  ) {
    throw new ConfigError(
      'baseline tools must record the knip and madge versions',
    )
  }
  checkIdentityList(value.knip, 'knip', isKnipIdentity)
  checkIdentityList(value.cycles, 'cycles', isCycleIdentity)
  return value
}

/** @param {ReturnType<typeof parseBaseline>} baseline */
export function formatBaseline(baseline) {
  return `${JSON.stringify(baseline, null, 2)}\n`
}

/**
 * The files Git tracks or would track under `root`, minus deletions.
 * @param {string} root
 * @returns {string[]}
 */
export function listRepoFiles(root) {
  const listFiles = (...args) => {
    try {
      return execFileSync('git', ['ls-files', '-z', ...args], {
        cwd: root,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
        .split('\0')
        .filter(Boolean)
    } catch (error) {
      throw new ToolError(
        `cannot list repository files in ${root}: ${error.message}`,
      )
    }
  }
  const deleted = new Set(listFiles('--deleted'))
  return listFiles('--cached', '--others', '--exclude-standard').filter(
    (file) => !deleted.has(file),
  )
}

/**
 * @typedef {object} WorkspacePackage
 * @property {string} dir Directory from the repository root.
 * @property {Record<string, unknown>} manifest Parsed `package.json`.
 * @property {{ rootDir?: string, outDir?: string }} compilerOptions From the
 *   package `tsconfig.json`, when it has one.
 * @property {{ outDir: string, outputs: Record<string, string> }
 *   | { problem: string }} [bundle]
 *   For a package Vite builds (one with a `vite.config.*`), its output
 *   directory and each library output mapped to its source, all relative to
 *   the package, or why its configuration cannot be read.
 */

/** Loads the TypeScript compiler the Vite configurations are parsed with. */
export async function loadTypeScript() {
  return (await import('typescript')).default
}

/**
 * The workspace packages under `packages/`.
 * @param {string[]} files Repository files.
 * @param {(path: string) => string} readFile
 * @param {typeof import('typescript')} ts From `loadTypeScript`.
 * @returns {WorkspacePackage[]}
 */
export function readWorkspacePackages(files, readFile, ts) {
  const fileSet = new Set(files)
  return files
    .filter((file) => /^packages\/[^/]+\/package\.json$/.test(file))
    .sort(byCodeUnit)
    .map((file) => {
      const dir = file.slice(0, -'/package.json'.length)
      const tsconfig = `${dir}/tsconfig.json`
      const viteConfigs = files.filter(
        (path) =>
          path.startsWith(`${dir}/`) &&
          /^vite\.config\.[^/]+$/.test(path.slice(dir.length + 1)),
      )
      const bundle =
        viteConfigs.length === 0
          ? undefined
          : viteConfigs.length === 1 &&
              viteConfigs[0] === `${dir}/vite.config.ts`
            ? viteLibraryOutputs(readFile(viteConfigs[0]), ts)
            : {
                problem: `only a single vite.config.ts is read, not ${viteConfigs
                  .map((path) => path.slice(dir.length + 1))
                  .join(', ')}`,
              }
      return {
        dir,
        manifest: JSON.parse(readFile(file)),
        compilerOptions: fileSet.has(tsconfig)
          ? (JSON.parse(readFile(tsconfig)).compilerOptions ?? {})
          : {},
        ...(bundle ? { bundle } : {}),
      }
    })
}

/**
 * The outputs of a Vite library build and their sources, read from the
 * syntax tree of its `vite.config.ts`: `<outDir>/<name>.js` for each
 * `build.lib.entry` name. Only the form the packages use is read: a single
 * `export default defineConfig({ ... })` whose `build.outDir` is a string
 * naming a directory inside the package, whose
 * `build.rollupOptions.output.entryFileNames` is `'[name].js'`, and whose
 * `build.lib.entry` is an object of
 * `name: fileURLToPath(new URL('./src/x.ts', import.meta.url))` properties
 * whose path is a plain relative path (see `isPlainPath`), which names the
 * same file inside the package as a URL and as a path. Any other form maps
 * nothing and names the property instead of guessing, so every target of the
 * package fails the checks.
 * @param {string} text Contents of `vite.config.ts`, at the package root.
 * @param {typeof import('typescript')} ts
 * @returns {{ outDir: string, outputs: Record<string, string> }
 *   | { problem: string }}
 */
export function viteLibraryOutputs(text, ts) {
  const fail = (problem) => ({ problem: `vite.config.ts ${problem}` })
  const syntax = ts.transpileModule(text, {
    fileName: 'vite.config.ts',
    reportDiagnostics: true,
  }).diagnostics
  if (syntax.length > 0) {
    return fail(
      `does not parse: ${ts.flattenDiagnosticMessageText(syntax[0].messageText, ' ')}`,
    )
  }
  const source = ts.createSourceFile(
    'vite.config.ts',
    text,
    ts.ScriptTarget.Latest,
    false,
    ts.ScriptKind.TS,
  )
  const isDefaultExport = (statement) =>
    ts.isExportAssignment(statement) ||
    (ts.canHaveModifiers(statement) &&
      (ts.getModifiers(statement) ?? []).some(
        (modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword,
      )) ||
    (ts.isExportDeclaration(statement) &&
      statement.exportClause !== undefined &&
      (ts.isNamespaceExport(statement.exportClause)
        ? statement.exportClause.name.text === 'default'
        : statement.exportClause.elements.some(
            (element) => element.name.text === 'default',
          )))
  const defaults = source.statements.filter(isDefaultExport)
  if (defaults.length !== 1) {
    return fail(`has ${defaults.length} default exports, not one`)
  }
  const [exported] = defaults
  const call =
    ts.isExportAssignment(exported) && !exported.isExportEquals
      ? exported.expression
      : undefined
  if (
    !call ||
    !ts.isCallExpression(call) ||
    call.questionDotToken ||
    !isIdentifierNamed(ts, call.expression, 'defineConfig') ||
    call.arguments.length !== 1 ||
    !ts.isObjectLiteralExpression(call.arguments[0])
  ) {
    return fail('default export is not defineConfig({ ... })')
  }

  /** The value at `path` under the configuration, or why it is unreadable. */
  const read = (path) => {
    let value = call.arguments[0]
    const names = path.split('.')
    for (const [index, name] of names.entries()) {
      const at = names.slice(0, index + 1).join('.')
      if (!ts.isObjectLiteralExpression(value)) {
        return {
          problem: `${names.slice(0, index).join('.')} is not an object literal`,
        }
      }
      const found = propertyNamed(ts, value, name)
      if (found.problem) return { problem: `${at} ${found.problem}` }
      value = found.value
    }
    return { value }
  }
  const outDir = read('build.outDir')
  if (outDir.problem) return fail(outDir.problem)
  if (!ts.isStringLiteral(outDir.value)) {
    return fail('build.outDir is not a string literal')
  }
  const outputDir = packageDirectory(outDir.value.text)
  if (outputDir === undefined) {
    return fail('build.outDir is not a directory inside the package')
  }
  const fileNames = read('build.rollupOptions.output.entryFileNames')
  if (fileNames.problem) return fail(fileNames.problem)
  if (
    !ts.isStringLiteral(fileNames.value) ||
    fileNames.value.text !== '[name].js'
  ) {
    return fail(
      "build.rollupOptions.output.entryFileNames is not the string literal '[name].js'",
    )
  }
  const entry = read('build.lib.entry')
  if (entry.problem) return fail(entry.problem)
  if (!ts.isObjectLiteralExpression(entry.value)) {
    return fail('build.lib.entry is not an object literal')
  }
  if (entry.value.properties.length === 0) {
    return fail('build.lib.entry names no entry')
  }
  const outputs = {}
  const seen = new Set()
  for (const member of entry.value.properties) {
    if (ts.isSpreadAssignment(member)) {
      return fail('build.lib.entry has a spread element')
    }
    const name = memberName(ts, member)
    if (name === undefined) {
      return fail('build.lib.entry has a computed or non-literal key')
    }
    const at = `build.lib.entry.${name}`
    if (seen.has(name)) return fail(`${at} is declared twice`)
    seen.add(name)
    if (!ts.isPropertyAssignment(member)) {
      return fail(`${at} is not a name: value property`)
    }
    // Rollup refuses a `[name]` that is absolute or relative.
    if (
      posix.normalize(name) !== name ||
      posix.isAbsolute(name) ||
      name === '.' ||
      name === '..' ||
      name.startsWith('../')
    ) {
      return fail(`${at} is not an output name inside build.outDir`)
    }
    const entryPath = fileUrlLiteral(ts, member.initializer)
    if (entryPath === undefined) {
      return fail(
        `${at} is not fileURLToPath(new URL('<string literal>', import.meta.url))`,
      )
    }
    if (!isPlainPath(entryPath)) {
      return fail(
        `${at} path ${JSON.stringify(entryPath)} is not a plain ./ path`,
      )
    }
    outputs[posix.join(outputDir, `${name}.js`)] = entryPath.slice(2)
  }
  return { outDir: outputDir, outputs }
}

/**
 * The package-relative directory a Vite `outDir` names, resolved against the
 * package the way Vite resolves it; missing for one that is absolute, is the
 * package itself, or lies outside it.
 */
function packageDirectory(outDir) {
  if (outDir.includes('\\') || /^[a-z]:/i.test(outDir)) return undefined
  const path = posix.normalize(outDir).replace(/\/+$/, '')
  return path === '' ||
    path === '.' ||
    path === '..' ||
    path.startsWith('../') ||
    posix.isAbsolute(path)
    ? undefined
    : path
}

/**
 * A `./`-prefixed path of plain segments, relative to the package: no
 * percent-encoding, query, fragment, backslash, colon, whitespace, empty,
 * `.`, or `..` segment, so a URL, Node, and TypeScript all read it as the
 * same file, which lies inside the package. Nothing else is decoded or
 * resolved.
 */
function isPlainPath(path) {
  return (
    typeof path === 'string' &&
    path.startsWith('./') &&
    path
      .slice(2)
      .split('/')
      .every(
        (segment) =>
          /^[\w.-]+$/.test(segment) && segment !== '.' && segment !== '..',
      )
  )
}

function isIdentifierNamed(ts, node, name) {
  return ts.isIdentifier(node) && node.text === name
}

/**
 * The static key of an object literal member: an identifier or a string
 * literal. A spread, computed, numeric, or private key has none.
 */
function memberName(ts, member) {
  if (ts.isSpreadAssignment(member) || !member.name) return undefined
  const { name } = member
  return ts.isIdentifier(name) || ts.isStringLiteral(name)
    ? name.text
    : undefined
}

/**
 * The value of the single `name: value` property called `name`. A spread or
 * a member without a static key could also define it, so either one makes
 * the property unreadable; members with another static key are not it.
 */
function propertyNamed(ts, object, name) {
  let found
  for (const member of object.properties) {
    if (ts.isSpreadAssignment(member)) {
      return { problem: 'is unknown beside a spread element' }
    }
    const key = memberName(ts, member)
    if (key === undefined) {
      return { problem: 'is unknown beside a computed or non-literal key' }
    }
    if (key !== name) continue
    if (found) return { problem: 'is declared twice' }
    found = member
  }
  if (!found) return { problem: 'is missing' }
  if (!ts.isPropertyAssignment(found)) {
    return { problem: 'is not a name: value property' }
  }
  return { value: found.initializer }
}

/** `'<path>'` of `fileURLToPath(new URL('<path>', import.meta.url))`. */
function fileUrlLiteral(ts, node) {
  if (
    !ts.isCallExpression(node) ||
    node.questionDotToken ||
    !isIdentifierNamed(ts, node.expression, 'fileURLToPath') ||
    node.arguments.length !== 1
  ) {
    return undefined
  }
  const [url] = node.arguments
  if (
    !ts.isNewExpression(url) ||
    !isIdentifierNamed(ts, url.expression, 'URL') ||
    url.arguments?.length !== 2
  ) {
    return undefined
  }
  const [path, base] = url.arguments
  const isImportMetaUrl =
    ts.isPropertyAccessExpression(base) &&
    !base.questionDotToken &&
    base.name.text === 'url' &&
    ts.isMetaProperty(base.expression) &&
    base.expression.keywordToken === ts.SyntaxKind.ImportKeyword &&
    base.expression.name.text === 'meta'
  return ts.isStringLiteral(path) && isImportMetaUrl ? path.text : undefined
}

/**
 * Every target of an `exports` value with the conditions that lead to it
 * (`node.import` for a nested one). A `null` target excludes the path; any
 * other value that is not a path is a target without a source.
 * @returns {{ condition: string, target?: string }[]}
 */
function exportTargets(value, conditions = []) {
  const condition = conditions.join('.') || 'default'
  if (typeof value === 'string') return [{ condition, target: value }]
  if (value === null) return []
  if (Array.isArray(value)) {
    return value.flatMap((fallback) => exportTargets(fallback, conditions))
  }
  if (!isRecord(value)) return [{ condition }]
  return Object.entries(value).flatMap(([key, nested]) =>
    exportTargets(nested, [...conditions, key]),
  )
}

/** The sources tsc emits a file of each output extension from. */
const EMITTED_FROM = [
  ['.d.ts', ['.ts', '.tsx']],
  ['.js', ['.ts', '.tsx']],
  ['.d.mts', ['.mts']],
  ['.mjs', ['.mts']],
  ['.d.cts', ['.cts']],
  ['.cjs', ['.cts']],
]

/** A directory option as a normalized package-relative path. */
function directoryOption(value) {
  return typeof value === 'string'
    ? posix.normalize(value).replace(/\/+$/, '')
    : undefined
}

/**
 * The source file a published target, a plain path (see `isPlainPath`), is
 * built from, relative to the package.
 * A Vite library output maps to its entry; the Vite `outDir` holds no other
 * script. A declaration, or a script tsc emits, under the package
 * tsconfig's `outDir` maps back through its `rootDir`, which the tsconfig
 * then has to declare itself, since tsc derives a missing one from the
 * program. A target outside both is its own source.
 * @returns {{ source?: string, problem?: string }} No source when none could
 *   be found; a problem when the package does not say which file it is.
 */
function targetSource(target, workspace, fileSet) {
  const { bundle, compilerOptions } = workspace
  const path = target.slice(2)
  const has = (candidate) => fileSet.has(`${workspace.dir}/${candidate}`)
  const found = (candidates) => {
    const existing = candidates.filter(has)
    if (existing.length > 1) {
      return { problem: `${target} can be built from ${existing.join(' or ')}` }
    }
    return existing.length === 1 ? { source: existing[0] } : {}
  }
  const under = (dir) => dir !== undefined && path.startsWith(`${dir}/`)
  const script = !DECLARATION.test(path)
  if (bundle && Object.hasOwn(bundle.outputs, path)) {
    return found([bundle.outputs[path]])
  }
  if (bundle && script && under(bundle.outDir)) return {}
  const outDir = directoryOption(compilerOptions.outDir)
  if (under(outDir)) {
    if (bundle && script) return {}
    const rootDir = directoryOption(compilerOptions.rootDir)
    if (rootDir === undefined) {
      return { problem: 'tsconfig.json declares outDir but not rootDir' }
    }
    const built = posix.join(rootDir, path.slice(outDir.length + 1))
    const emitted = EMITTED_FROM.find(([suffix]) => built.endsWith(suffix))
    if (!emitted) return {}
    const [suffix, extensions] = emitted
    return found(
      extensions.map((extension) => built.slice(0, -suffix.length) + extension),
    )
  }
  return found([path])
}

/**
 * Why the `exports` field cannot be read as a map of subpaths or as the
 * conditions of the package root, if it cannot.
 */
function exportsProblem(exportsField) {
  if (exportsField === null) return 'package.json exports is null'
  if (!isRecord(exportsField)) return undefined
  const keys = Object.keys(exportsField)
  const subpaths = keys.filter((key) => key.startsWith('.'))
  if (subpaths.length > 0 && subpaths.length < keys.length) {
    return 'package.json exports mixes subpaths and conditions'
  }
  const invalid = subpaths.find((key) => key !== '.' && !key.startsWith('./'))
  return invalid === undefined
    ? undefined
    : `package.json exports key ${invalid} is not a subpath`
}

/** Fields a package without `exports` is resolved through. */
const ENTRY_FIELDS = ['main', 'module', 'types', 'typings']

/**
 * Published entry points of a workspace package and their sources, one per
 * export condition target, since each condition can lead to a different file.
 * A package without `exports` publishes its entry fields instead.
 *
 * A package maps nothing when its Vite configuration or `exports` cannot be
 * read, when any target in its `exports`, entry fields, or `bin` is a string
 * that is not a plain path (see `isPlainPath`), or when it is not private and
 * publishes no entry: it has a single entry, named by the package, with the
 * problem and without a source, so no target of it falls back to a guessed
 * source. A private package publishes nothing, so it may have no entry.
 * @param {WorkspacePackage} workspace
 * @param {Set<string>} fileSet Repository files.
 * @returns {{ specifier: string, condition?: string, source?: string,
 *   problem?: string }[]}
 *   `condition` is missing for a bin and for a package that maps nothing;
 *   `source` is relative to the package and missing when no source file
 *   could be found. `problem` then says why, when the package does not say
 *   which file it is.
 */
export function publishedEntries(workspace, fileSet) {
  const { manifest } = workspace
  const named = typeof manifest.name === 'string' && manifest.name !== ''
  const name = named ? manifest.name : workspace.dir
  const mapsNothing = (problem) => [
    { specifier: name, source: undefined, problem },
  ]
  const packageProblem = named
    ? (workspace.bundle?.problem ?? exportsProblem(manifest.exports))
    : 'package.json has no name'
  if (packageProblem !== undefined) return mapsNothing(packageProblem)

  // Every target the manifest names, with the field it is in; the entry
  // fields are only published by a package without `exports`.
  const targets = []
  const exportsField = manifest.exports
  const exportMap =
    isRecord(exportsField) &&
    Object.keys(exportsField).some((key) => key.startsWith('.'))
      ? exportsField
      : exportsField === undefined
        ? {}
        : { '.': exportsField }
  for (const [key, value] of Object.entries(exportMap)) {
    const specifier = key === '.' ? name : `${name}${key.slice(1)}`
    for (const { condition, target } of exportTargets(value)) {
      targets.push({
        specifier,
        condition,
        target,
        field: `exports ${key} ${condition}`,
      })
    }
  }
  for (const field of ENTRY_FIELDS) {
    if (manifest[field] === undefined) continue
    targets.push({
      specifier: name,
      condition: field,
      target: manifest[field],
      field,
      published: exportsField === undefined,
    })
  }
  const bin = manifest.bin
  const bins =
    typeof bin === 'string'
      ? { [name]: bin }
      : isRecord(bin)
        ? bin
        : bin === undefined
          ? {}
          : { [name]: undefined }
  for (const [command, target] of Object.entries(bins)) {
    targets.push({
      specifier: `bin ${command}`,
      target,
      field: `bin ${command}`,
    })
  }

  const unsupported = targets.find(
    ({ target }) => typeof target === 'string' && !isPlainPath(target),
  )
  if (unsupported) {
    return mapsNothing(
      `package.json ${unsupported.field} has an unsupported export target form: ${JSON.stringify(unsupported.target)}`,
    )
  }
  const entries = targets
    .filter(({ published }) => published !== false)
    .map(({ specifier, condition, target }) => {
      const { source, problem } =
        typeof target === 'string'
          ? targetSource(target, workspace, fileSet)
          : {}
      return {
        specifier,
        ...(condition === undefined ? {} : { condition }),
        source,
        ...(problem ? { problem } : {}),
      }
    })
  if (entries.length === 0 && manifest.private !== true) {
    return mapsNothing('package.json publishes no entry')
  }
  return entries
}

function positivePatterns(patterns) {
  if (patterns === undefined) return []
  const list = Array.isArray(patterns) ? patterns : [patterns]
  return list.filter(
    (pattern) => typeof pattern === 'string' && !pattern.startsWith('!'),
  )
}

function filesOfWorkspace(dir, files, workspaceDirs) {
  if (dir === '.') {
    return files.filter(
      (file) => !workspaceDirs.some((other) => file.startsWith(`${other}/`)),
    )
  }
  return files
    .filter((file) => file.startsWith(`${dir}/`))
    .map((file) => file.slice(dir.length + 1))
}

/**
 * Problems in the knip configuration that would otherwise shrink the report
 * silently: a workspace package without a knip workspace (or the reverse), a
 * pattern that matches nothing, or a published export or bin without an
 * entry.
 * @param {{ config: unknown, files: string[], workspaces: WorkspacePackage[] }} input
 * @returns {string[]}
 */
export function checkKnipConfig({ config, files, workspaces }) {
  if (!isRecord(config) || !isRecord(config.workspaces)) {
    return ['knip.json must declare its workspaces']
  }
  const problems = []
  const declared = Object.keys(config.workspaces)
  const packageDirs = workspaces.map(({ dir }) => dir)
  for (const dir of packageDirs) {
    if (!declared.includes(dir))
      problems.push(`workspace ${dir} has no knip workspace`)
  }
  for (const dir of declared) {
    if (dir !== '.' && !packageDirs.includes(dir)) {
      problems.push(`knip workspace ${dir} is not a workspace package`)
    }
  }
  if (!declared.includes('.')) problems.push('knip.json has no root workspace')

  const fileSet = new Set(files)
  for (const dir of declared) {
    const workspaceConfig = config.workspaces[dir]
    if (!isRecord(workspaceConfig)) {
      problems.push(`knip workspace ${dir} is not an object`)
      continue
    }
    const local = filesOfWorkspace(dir, files, packageDirs)
    const entries = positivePatterns(workspaceConfig.entry)
    for (const field of ['entry', 'project']) {
      for (const pattern of positivePatterns(workspaceConfig[field])) {
        if (!local.some((file) => matchesGlob(file, pattern))) {
          problems.push(
            `knip workspace ${dir} ${field} pattern ${pattern} matches no file`,
          )
        }
      }
    }
    const workspace = workspaces.find((candidate) => candidate.dir === dir)
    if (!workspace || workspace.manifest.private === true) continue
    const reported = new Set()
    for (const { specifier, condition, source, problem } of publishedEntries(
      workspace,
      fileSet,
    )) {
      const entry = condition ? `${specifier} ${condition}` : specifier
      if (!source) {
        problems.push(
          `${entry} has no source file in ${dir}${problem ? `: ${problem}` : ''}`,
        )
      } else if (
        !reported.has(source) &&
        !entries.some((pattern) => matchesGlob(source, pattern))
      ) {
        reported.add(source)
        problems.push(
          `${specifier} (${dir}/${source}) is not a knip entry of ${dir}`,
        )
      }
    }
  }
  return problems
}

/**
 * What madge reads: the root workspace's `src/` and each package's project
 * directories and published sources, resolving workspace package specifiers to
 * those sources.
 * @param {{ config: Record<string, any>, files: string[],
 *   workspaces: WorkspacePackage[], rootPaths: Record<string, string[]> }} input
 */
export function madgeScope({ config, files, workspaces, rootPaths }) {
  const fileSet = new Set(files)
  const roots = []
  const paths = { ...rootPaths }
  const staticPrefix = (pattern) => {
    const segments = []
    for (const segment of pattern.split('/')) {
      if (/[*?[{]/.test(segment)) break
      segments.push(segment)
    }
    return segments.join('/')
  }
  for (const [dir, workspaceConfig] of Object.entries(config.workspaces)) {
    for (const pattern of positivePatterns(workspaceConfig.project)) {
      const prefix = staticPrefix(pattern)
      roots.push(dir === '.' ? prefix : posix.join(dir, prefix))
    }
  }
  for (const workspace of workspaces) {
    for (const { specifier, source } of publishedEntries(workspace, fileSet)) {
      if (!source || specifier.startsWith('bin ') || DECLARATION.test(source)) {
        continue
      }
      const path = `${workspace.dir}/${source}`
      roots.push(path)
      paths[specifier] ??= [`./${path}`]
    }
  }
  const covered = (path, root) => path === root || path.startsWith(`${root}/`)
  const unique = sortedUnique(roots.filter(Boolean))
  const scope = unique.filter(
    (root) => !unique.some((other) => other !== root && covered(root, other)),
  )
  const isModule = (file) =>
    MODULE_EXTENSIONS.has(posix.extname(file).slice(1)) &&
    !DECLARATION.test(file)
  const known = files.filter(isModule).sort(byCodeUnit)
  const modules = known.filter((file) =>
    scope.some((root) => covered(file, root)),
  )
  return { roots: scope, modules, paths, known: new Set(known) }
}

function packageVersion(entryUrl, name) {
  let dir = dirname(fileURLToPath(entryUrl))
  while (dir !== dirname(dir)) {
    const manifestPath = join(dir, 'package.json')
    if (existsSync(manifestPath)) {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
      if (manifest.name === name) return { dir, version: manifest.version }
    }
    dir = dirname(dir)
  }
  throw new ToolError(`cannot find the installed ${name} package`)
}

/** Installed tool versions and the knip CLI script. */
export function installedTools() {
  try {
    const knip = packageVersion(import.meta.resolve('knip'), 'knip')
    const madge = packageVersion(import.meta.resolve('madge'), 'madge')
    return {
      versions: { knip: knip.version, madge: madge.version },
      knipBin: join(knip.dir, 'bin', 'knip.js'),
    }
  } catch (error) {
    if (error instanceof ToolError) throw error
    throw new ToolError(
      `knip and madge are not installed (run pnpm install): ${error.message}`,
    )
  }
}

/**
 * Runs the knip CLI and returns its finding identities.
 * @param {{ root: string, knipBin: string, config?: string,
 *   spawn?: typeof spawnSync }} input
 */
export function runKnip({
  root,
  knipBin,
  config = KNIP_CONFIG,
  spawn = spawnSync,
}) {
  const result = spawn(
    process.execPath,
    [knipBin, '--config', config, '--reporter', 'json', '--no-progress'],
    {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
      timeout: KNIP_TIMEOUT_MS,
      env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
    },
  )
  const stderr = String(result.stderr ?? '').trim()
  const details = stderr ? `\n${stderr.split('\n').slice(-20).join('\n')}` : ''
  if (result.error)
    throw new ToolError(`knip did not run: ${result.error.message}`)
  if (result.signal)
    throw new ToolError(`knip was killed by ${result.signal}${details}`)
  // knip exits 0 without issues, 1 with issues, and 2 on errors.
  if (result.status !== 0 && result.status !== 1) {
    throw new ToolError(`knip failed with exit code ${result.status}${details}`)
  }
  let report
  try {
    report = JSON.parse(String(result.stdout ?? ''))
  } catch {
    throw new ToolError(`knip did not print a JSON report${details}`)
  }
  const identities = normalizeKnipReport(report, { root })
  if ((result.status === 1) !== identities.length > 0) {
    throw new ToolError(
      `knip exited with ${result.status} but reported ${identities.length} findings${details}`,
    )
  }
  return identities
}

/**
 * Runs madge over `madgeScope` and returns its cycle identities.
 * @param {{ root: string, scope: ReturnType<typeof madgeScope>,
 *   compilerOptions: Record<string, unknown>, allowedUnresolved?: string[],
 *   loadMadge?: () => Promise<any> }} input
 */
export async function runMadge({
  root,
  scope,
  compilerOptions,
  allowedUnresolved = [],
  loadMadge = async () => (await import('madge')).default,
}) {
  if (scope.modules.length === 0)
    throw new ToolError('madge has no modules to read')
  const madge = await loadMadge()
  let result
  try {
    result = await madge(
      scope.modules.map((file) => join(root, file)),
      {
        baseDir: root,
        tsConfig: {
          compilerOptions: {
            ...compilerOptions,
            allowJs: true,
            baseUrl: root,
            paths: scope.paths,
          },
        },
        // Follow only repository source modules: generated, ignored, and
        // style files are never part of the graph.
        dependencyFilter: (dependency) =>
          scope.known.has(relative(root, dependency).split(sep).join('/')),
      },
    )
  } catch (error) {
    throw new ToolError(`madge failed: ${error.message}`)
  }
  const graph = result.obj()
  const read = Object.keys(graph)
  const silentRoots = scope.roots.filter(
    (scopeRoot) =>
      !read.some(
        (file) => file === scopeRoot || file.startsWith(`${scopeRoot}/`),
      ),
  )
  if (silentRoots.length > 0) {
    throw new ToolError(`madge read no module under ${silentRoots.join(', ')}`)
  }
  const allowed = new Set(allowedUnresolved)
  const skipped = sortedUnique(result.warnings().skipped).filter(
    (specifier) => !allowed.has(specifier),
  )
  if (skipped.length > 0) {
    throw new ToolError(`madge could not resolve: ${skipped.join(', ')}`)
  }
  return {
    modules: read.length,
    cycles: normalizeCycles(result.circular(), { root }),
  }
}

/**
 * Loads everything the tools need from a checkout.
 * @param {string} root
 * @param {typeof import('typescript')} ts From `loadTypeScript`.
 */
export function loadRepository(root, ts) {
  const files = listRepoFiles(root)
  const readFile = (path) => readFileSync(join(root, path), 'utf8')
  let config
  let tsconfig
  try {
    config = JSON.parse(readFileSync(KNIP_CONFIG, 'utf8'))
    tsconfig = JSON.parse(readFile('tsconfig.json'))
  } catch (error) {
    throw new ConfigError(
      `cannot read knip.json or tsconfig.json: ${error.message}`,
    )
  }
  const workspaces = readWorkspacePackages(files, readFile, ts)
  const problems = checkKnipConfig({ config, files, workspaces })
  if (problems.length > 0) {
    throw new ConfigError(
      `knip.json does not cover the repository:\n${problems.join('\n')}`,
    )
  }
  const compilerOptions = isRecord(tsconfig.compilerOptions)
    ? tsconfig.compilerOptions
    : {}
  const { paths: rootPaths = {}, ...otherOptions } = compilerOptions
  const allowedUnresolved = Object.values(config.workspaces).flatMap(
    (workspace) => workspace.ignoreUnresolved ?? [],
  )
  return {
    root,
    scope: madgeScope({ config, files, workspaces, rootPaths }),
    compilerOptions: otherOptions,
    allowedUnresolved,
  }
}

/** The commit `root` has checked out. */
function headCommit(root) {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim()
  } catch (error) {
    throw new ToolError(`cannot read the checked-out commit: ${error.message}`)
  }
}

/**
 * Runs both tools and renders the report. The check passes only when knip
 * and madge find nothing and the baseline lists nothing; with `prune`, the
 * baseline is first reduced to the entries that are still found.
 * @param {object} input
 * @param {ReturnType<typeof parseBaseline>} input.baseline
 * @param {{ knip: string, madge: string }} input.versions Installed tools.
 * @param {() => string[]} input.knip Current knip identities.
 * @param {() => Promise<{ modules: number, cycles: string[] }>} input.madge
 * @param {boolean} [input.prune]
 * @returns {Promise<{ ok: boolean, output: string[], errors: string[],
 *   pruned: ReturnType<typeof parseBaseline> }>}
 */
export async function runCheck({
  baseline,
  versions,
  knip,
  madge,
  prune = false,
}) {
  for (const tool of ['knip', 'madge']) {
    if (baseline.tools[tool] !== versions[tool]) {
      throw new ConfigError(
        `the baseline was recorded with ${tool} ${baseline.tools[tool]}, but ${tool} ${versions[tool]} is installed. ` +
          `Print the findings with --print, resolve them, and record the new version in the baseline.`,
      )
    }
  }
  const findings = knip()
  const graph = await madge()

  const output = [
    `knip ${versions.knip}: ${findings.length} findings`,
    `madge ${versions.madge}: ${graph.modules} modules, ${graph.cycles.length} cycles`,
  ]
  const found = new Set([...findings, ...graph.cycles])
  const pruned = {
    ...baseline,
    knip: baseline.knip.filter((identity) => found.has(identity)),
    cycles: baseline.cycles.filter((identity) => found.has(identity)),
  }
  const resolved = [...baseline.knip, ...baseline.cycles].filter(
    (identity) => !found.has(identity),
  )
  if (resolved.length > 0) {
    output.push(
      prune
        ? 'Removed resolved baseline entries:'
        : 'Resolved baseline entries (drop them with --prune):',
    )
    for (const identity of resolved) output.push(`  ${identity}`)
  }

  const errors = [
    ...findings.map((identity) => `knip finding: ${identity}`),
    ...graph.cycles.map((identity) => `dependency cycle: ${identity}`),
  ]
  if (errors.length > 0) {
    errors.push(
      `${errors.length} structural ${errors.length === 1 ? 'finding' : 'findings'}. Remove the dead code or break the cycle; ` +
        'scripts/quality/baseline.json takes no exceptions.',
    )
  }
  const listed = prune ? pruned : baseline
  const exceptions = [...listed.knip, ...listed.cycles]
  if (exceptions.length > 0) {
    errors.push(
      ...exceptions.map((identity) => `baseline exception: ${identity}`),
      `scripts/quality/baseline.json lists ${exceptions.length} ${
        exceptions.length === 1 ? 'exception' : 'exceptions'
      } and must list none. Drop resolved entries with --prune.`,
    )
  }
  return { ok: errors.length === 0, output, errors, pruned }
}

const USAGE =
  'Usage: check-structure.mjs [--prune] | --print [--root <checkout>]'

function parseArguments(argv, cwd) {
  const options = { prune: false, print: false, root: REPO_ROOT }
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (arg === '--prune') options.prune = true
    else if (arg === '--print') options.print = true
    else if (arg === '--root' && argv[index + 1])
      options.root = resolve(cwd, argv[++index])
    else throw new UsageError(`Unknown argument ${arg}. ${USAGE}`)
  }
  if (options.prune && (options.print || options.root !== REPO_ROOT)) {
    throw new UsageError(
      `--prune only updates this checkout's baseline. ${USAGE}`,
    )
  }
  if (options.root !== REPO_ROOT && !options.print) {
    throw new UsageError(`--root is only for --print. ${USAGE}`)
  }
  return options
}

async function main(argv) {
  const options = parseArguments(argv, process.cwd())
  const tools = installedTools()
  const repository = loadRepository(options.root, await loadTypeScript())
  const knip = () => runKnip({ root: options.root, knipBin: tools.knipBin })
  const madge = () => runMadge(repository)

  if (options.print) {
    const { cycles } = await madge()
    const findings = knip()
    process.stdout.write(
      formatBaseline({
        source: headCommit(options.root),
        tools: tools.versions,
        knip: findings,
        cycles,
      }),
    )
    return 0
  }

  let baseline
  try {
    baseline = parseBaseline(JSON.parse(readFileSync(BASELINE_PATH, 'utf8')))
  } catch (error) {
    if (error instanceof ConfigError) throw error
    throw new ConfigError(`cannot read the baseline: ${error.message}`)
  }
  const { ok, output, errors, pruned } = await runCheck({
    baseline,
    versions: tools.versions,
    knip,
    madge,
    prune: options.prune,
  })
  for (const line of output) console.log(line)
  for (const line of errors) console.error(line)
  if (options.prune && formatBaseline(pruned) !== formatBaseline(baseline)) {
    writeFileSync(BASELINE_PATH, formatBaseline(pruned))
  }
  return ok ? 0 : 1
}

if (isMainModule(import.meta.url)) {
  try {
    process.exitCode = await main(process.argv.slice(2))
  } catch (error) {
    if (
      !(error instanceof UsageError) &&
      !(error instanceof ToolError) &&
      !(error instanceof ConfigError)
    ) {
      throw error
    }
    console.error(error.message)
    process.exitCode = 2
  }
}
