import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import process from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'

/**
 * Checks that the repository paths a Markdown agent map names in backticks
 * exist. It only reads: no document or generated file is ever written.
 *
 * Every inline code span is sorted into one category:
 * - repository paths must resolve from the repository root. A span is a path
 *   when it contains a `/`, is a `name.ext` with a source or document
 *   extension, or names a top-level entry. A `:12`, `:12-34`, or `#L12-L34`
 *   suffix is checked against the file's length.
 * - package specifiers must name a workspace package (and one of its exports)
 *   or a declared dependency; `~/` must resolve under `src/`.
 * - commands, routes, URLs, placeholders, globs, secret file names, the
 *   generated or excluded paths listed below, and identifiers are skipped and
 *   counted.
 * A path-shaped span is never skipped for being unknown, so an abbreviated or
 * mistyped path fails instead of passing as an identifier. A multi-word span
 * that is not a command is checked word by word.
 *
 * A path exists when Git tracks it or would track it. Ignored build output,
 * caches, and generated files are therefore absent, as in a clean CI
 * checkout, and the match is case-sensitive on every platform. Secret file
 * names such as `.env` are recognized by name and never looked up or read.
 */

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url))

export const DEFAULT_DOCUMENTS = ['AGENTS.md']

/** Paths a clean checkout lacks on purpose. Matched exactly, never by prefix. */
const ABSENT_BY_DESIGN = new Map([
  // Written by the route builder from `src/pages/` and ignored by Git.
  ['src/generated-routes.ts', 'generated'],
  // Named as a place agent-skill output must not be committed to.
  ['docs/superpowers/', 'excluded'],
])

/** Executables whose spans are commands, after any `NAME=value` prefixes. */
const COMMANDS = new Set([
  'bash',
  'cat',
  'cd',
  'emcc',
  'eslint',
  'gh',
  'git',
  'lmfg',
  'lmfg-mcp',
  'node',
  'npm',
  'npx',
  'playwright',
  'pnpm',
  'python3',
  'sh',
  'tsc',
  'vite',
  'vitest',
])

/** Extensions that make a bare `name.ext` a repository path. */
const PATH_EXTENSIONS = new Set([
  'c',
  'cc',
  'cjs',
  'cpp',
  'css',
  'cts',
  'h',
  'hpp',
  'html',
  'js',
  'json',
  'jsonc',
  'jsx',
  'md',
  'mdx',
  'mjs',
  'mts',
  'sh',
  'toml',
  'ts',
  'tsx',
  'txt',
  'wasm',
  'wgsl',
  'yaml',
  'yml',
])

/** Suffixes tried when a `~/` specifier omits the module's extension. */
const MODULE_SUFFIXES = [
  '',
  '.ts',
  '.tsx',
  '.js',
  '.mjs',
  '/index.ts',
  '/index.tsx',
  '/index.js',
]

const DEPENDENCY_FIELDS = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
]

const CATEGORY_LABELS = {
  path: ['repository path', 'repository paths'],
  specifier: ['package specifier', 'package specifiers'],
  command: ['command', 'commands'],
  route: ['route', 'routes'],
  url: ['URL', 'URLs'],
  placeholder: ['placeholder', 'placeholders'],
  glob: ['glob', 'globs'],
  secret: [
    'secret file name (not looked up)',
    'secret file names (not looked up)',
  ],
  generated: ['generated path', 'generated paths'],
  excluded: ['excluded path', 'excluded paths'],
  identifier: ['identifier', 'identifiers'],
}
const SKIPPED_CATEGORIES = [
  'command',
  'route',
  'url',
  'placeholder',
  'glob',
  'secret',
  'generated',
  'excluded',
  'identifier',
]

const ENV_ASSIGNMENT = /^[A-Z_][A-Z\d_]*=/
const URL_PATTERN = /^(?:[a-z][a-z\d+.-]*:\/\/|mailto:)/i
const PLACEHOLDER = /<[^<>]*>/
const LINE_SUFFIX = /^(.+?)(?::(\d+)(?:-(\d+))?(?::\d+)?|#L(\d+)(?:-L?(\d+))?)$/

export class UsageError extends Error {}

/**
 * @typedef {object} WorkspacePackage
 * @property {string} dir Package directory from the repository root.
 * @property {Set<string> | null} exports `exports` keys; null without a map.
 */

/**
 * @typedef {object} RepoIndex
 * @property {(path: string) => boolean} hasFile A listed file.
 * @property {(path: string) => boolean} hasDirectory A directory holding a
 *   listed file.
 * @property {(name: string) => boolean} isTopLevel A root-level entry name.
 * @property {(path: string) => number} lineCount Lines in a listed file.
 * @property {(name: string) => WorkspacePackage | undefined} workspacePackage
 *   The workspace package published under `name`.
 * @property {(name: string) => boolean} isDependency Declared by the root or a
 *   workspace package.
 */

/** @param {unknown} exports A package.json `exports` field. */
function exportKeys(exports) {
  if (exports === undefined) return null
  if (exports && typeof exports === 'object' && !Array.isArray(exports)) {
    const keys = Object.keys(exports)
    if (keys.some((key) => key.startsWith('.'))) return new Set(keys)
  }
  return new Set(['.'])
}

/**
 * The repository as a set of root-relative file paths.
 * @param {Iterable<string>} files Paths with `/` separators.
 * @param {{ readFile: (path: string) => string }} io Reads a listed file.
 * @returns {RepoIndex}
 */
export function createRepoIndex(files, { readFile }) {
  const fileSet = new Set(files)
  const directories = new Set()
  const topLevel = new Set()
  for (const file of fileSet) {
    const segments = file.split('/')
    topLevel.add(segments[0])
    for (let end = 1; end < segments.length; end++) {
      directories.add(segments.slice(0, end).join('/'))
    }
  }

  const packages = new Map()
  const dependencies = new Set()
  for (const file of fileSet) {
    if (
      file !== 'package.json' &&
      !/^packages\/[^/]+\/package\.json$/.test(file)
    )
      continue
    const manifest = JSON.parse(readFile(file))
    if (file !== 'package.json' && typeof manifest.name === 'string') {
      packages.set(manifest.name, {
        dir: file.slice(0, -'/package.json'.length),
        exports: exportKeys(manifest.exports),
      })
    }
    for (const field of DEPENDENCY_FIELDS) {
      for (const name of Object.keys(manifest[field] ?? {})) {
        dependencies.add(name)
      }
    }
  }

  const lineCounts = new Map()
  return {
    hasFile: (path) => fileSet.has(path),
    hasDirectory: (path) => directories.has(path),
    isTopLevel: (name) => topLevel.has(name),
    lineCount(path) {
      if (!lineCounts.has(path)) {
        const lines = readFile(path).split(/\r?\n/)
        if (lines.at(-1) === '') lines.pop()
        lineCounts.set(path, lines.length)
      }
      return lineCounts.get(path)
    },
    workspacePackage: (name) => packages.get(name),
    isDependency: (name) => dependencies.has(name),
  }
}

/**
 * The files Git tracks or would track under `root`, minus working-tree
 * deletions.
 * @param {string} [root]
 * @returns {RepoIndex}
 */
export function loadRepoIndex(root = REPO_ROOT) {
  const listFiles = (...args) =>
    execFileSync('git', ['ls-files', '-z', ...args], {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    })
      .split('\0')
      .filter(Boolean)
  const deleted = new Set(listFiles('--deleted'))
  const files = listFiles('--cached', '--others', '--exclude-standard').filter(
    (file) => !deleted.has(file),
  )
  return createRepoIndex(files, {
    readFile: (path) => readFileSync(join(root, path), 'utf8'),
  })
}

/** Pairs inline code spans within one paragraph. */
function scanParagraph(paragraph, spans) {
  if (paragraph.length === 0) return
  const text = paragraph.map(({ text: line }) => line).join('\n')
  const lineAt = (offset) =>
    paragraph[0].line + (text.slice(0, offset).match(/\n/g)?.length ?? 0)
  const runLength = (offset) => {
    let end = offset
    while (text[end] === '`') end++
    return end - offset
  }

  let offset = 0
  while (offset < text.length) {
    if (text[offset] === '\\') {
      offset += 2
      continue
    }
    if (text[offset] !== '`') {
      offset++
      continue
    }
    const opening = runLength(offset)
    let close = offset + opening
    while (close < text.length) {
      if (text[close] !== '`') {
        close++
        continue
      }
      const closing = runLength(close)
      if (closing === opening) break
      close += closing
    }
    if (close >= text.length) {
      offset += opening
      continue
    }
    let content = text.slice(offset + opening, close).replaceAll('\n', ' ')
    if (content.trim() && content.startsWith(' ') && content.endsWith(' ')) {
      content = content.slice(1, -1)
    }
    spans.push({ text: content, line: lineAt(offset) })
    offset = close + opening
  }
}

/**
 * Inline code spans outside fenced code blocks, with their opening lines.
 * @param {string} markdown
 * @returns {{ text: string, line: number }[]}
 */
export function extractCodeSpans(markdown) {
  const spans = []
  let paragraph = []
  let fence = null
  for (const [index, text] of markdown.split(/\r?\n/).entries()) {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(text)?.[1]
    if (fence) {
      const closes =
        marker &&
        marker[0] === fence[0] &&
        marker.length >= fence.length &&
        text.trim() === marker
      if (closes) fence = null
      continue
    }
    if (marker || text.trim() === '') {
      scanParagraph(paragraph, spans)
      paragraph = []
      if (marker) fence = marker
      continue
    }
    paragraph.push({ text, line: index + 1 })
  }
  scanParagraph(paragraph, spans)
  return spans
}

/** @param {string} token */
function isSecretName(token) {
  const name = token.replace(/\/+$/, '').split('/').at(-1) ?? ''
  return (
    /^\.env(?:\.|$)/i.test(name) ||
    /^\.dev\.vars(?:\.|$)/i.test(name) ||
    /\.(?:key|p12|pem|pfx)$/i.test(name) ||
    /credential|secret/i.test(name)
  )
}

/**
 * @param {string} path
 * @param {RepoIndex} index
 */
function isPathShaped(path, index) {
  if (path.includes('/') || index.isTopLevel(path)) return true
  const extension = /\.([A-Z\d]+)$/i.exec(path)
  return (
    extension !== null &&
    extension.index > 0 &&
    PATH_EXTENSIONS.has(extension[1].toLowerCase())
  )
}

/**
 * Why a root-relative path does not resolve, or undefined when it does.
 * @param {string} written The path as written, without its line suffix.
 * @param {{ start?: number, end?: number }} lines
 * @param {RepoIndex} index
 */
function pathProblem(written, { start, end }, index) {
  const wantsDirectory = written.endsWith('/')
  const path = written
    .replace(/^\//, '')
    .replace(/^(?:\.\/)+/, '')
    .replace(/\/+$/, '')
  if (path.split('/').some((segment) => segment === '.' || segment === '..')) {
    return 'must be written from the repository root'
  }
  const isFile = index.hasFile(path)
  const isDirectory = path === '' || index.hasDirectory(path)
  if (!isFile && !isDirectory) return 'does not exist in the repository'
  if (wantsDirectory && !isDirectory) return 'is a file, not a directory'
  if (start === undefined) return undefined
  if (!isFile) return 'has a line reference but is not a file'
  if (end !== undefined && end < start) return 'has a reversed line range'
  const last = end ?? start
  const count = index.lineCount(path)
  return last > count
    ? `line ${last} is past the end of the file (${count} lines)`
    : undefined
}

/**
 * Whether `token` is a package specifier, and why it does not resolve.
 * @param {string} token
 * @param {RepoIndex} index
 * @returns {{ problem?: string } | undefined} Undefined when not a specifier.
 */
function specifierCheck(token, index) {
  if (token.startsWith('~/')) {
    const target = `src/${token.slice(2)}`.replace(/\/+$/, '')
    const resolves =
      index.hasDirectory(target) ||
      MODULE_SUFFIXES.some((suffix) => index.hasFile(target + suffix))
    return resolves ? {} : { problem: 'does not resolve under src/' }
  }

  const scoped = /^(@[\w.-]+\/[\w.-]+)(\/.*)?$/.exec(token)
  const bare = /^([\w.-]+)(\/.*)$/.exec(token)
  let match
  if (scoped) match = scoped
  else if (bare && !index.isTopLevel(bare[1]) && index.isDependency(bare[1]))
    match = bare
  else return undefined

  const [, name, subpath] = match
  const workspace = index.workspacePackage(name)
  if (!workspace) {
    return index.isDependency(name)
      ? {}
      : {
          problem: `${name} is not a workspace package or a declared dependency`,
        }
  }
  if (!subpath) return {}
  if (workspace.exports === null) {
    const problem = pathProblem(`${workspace.dir}${subpath}`, {}, index)
    return problem ? { problem: `is not a file of ${name}` } : {}
  }
  const key = `.${subpath}`
  const exported = [...workspace.exports].some((pattern) => {
    const star = pattern.indexOf('*')
    if (star === -1) return pattern === key
    return (
      key.startsWith(pattern.slice(0, star)) &&
      key.endsWith(pattern.slice(star + 1))
    )
  })
  return exported ? {} : { problem: `is not an export of ${name}` }
}

/**
 * @typedef {object} Classified
 * @property {string} token The word or span that was classified.
 * @property {string} category One of the categories listed above.
 * @property {string} [problem] Set when a checked token does not resolve.
 */

/**
 * @param {string} token One word of a span.
 * @param {RepoIndex} index
 * @returns {Classified}
 */
function classifyToken(token, index) {
  const entry = (category, problem) =>
    problem ? { token, category, problem } : { token, category }

  if (URL_PATTERN.test(token)) return entry('url')
  const suffix = LINE_SUFFIX.exec(token)
  const path = suffix ? suffix[1] : token
  // Before any lookup, so a secret file is never queried or read.
  if (isSecretName(token) || isSecretName(path)) return entry('secret')
  // A leading slash names a route unless it starts at a top-level entry.
  const rootRelative =
    token.startsWith('/') && index.isTopLevel(token.slice(1).split('/')[0])
  if (!rootRelative && (token.startsWith('/') || token.startsWith('?')))
    return entry('route')
  if (token.startsWith('-') || ENV_ASSIGNMENT.test(token))
    return entry('identifier')
  const absent = ABSENT_BY_DESIGN.get(token)
  if (absent) return entry(absent)
  if (PLACEHOLDER.test(token)) return entry('placeholder')
  if (/[*{]/.test(token)) return entry('glob')

  const specifier = specifierCheck(token, index)
  if (specifier) return entry('specifier', specifier.problem)

  if (!isPathShaped(path, index)) return entry('identifier')
  const start = suffix?.[2] ?? suffix?.[4]
  const end = suffix?.[3] ?? suffix?.[5]
  return entry(
    'path',
    pathProblem(
      path,
      {
        start: start === undefined ? undefined : Number(start),
        end: end === undefined ? undefined : Number(end),
      },
      index,
    ),
  )
}

/**
 * @param {string} span The text of one code span.
 * @param {RepoIndex} index
 * @returns {Classified[]}
 */
function classifySpan(span, index) {
  // A `<placeholder>` stays one word even when it contains spaces.
  const words = span.match(/(?:<[^<>]*>|\S)+/g) ?? []
  const first = words.find((word) => !ENV_ASSIGNMENT.test(word))
  if (first !== undefined && COMMANDS.has(first)) {
    return [{ token: span.trim(), category: 'command' }]
  }
  if (words.length <= 1) return words.map((word) => classifyToken(word, index))
  // Prose: keep the words that are paths or other categories, so a path
  // inside a sentence is still checked; plain words collapse into one entry.
  const notable = words
    .map((word) => word.replace(/^[("'[]+/, '').replace(/[)"'\],;:.!?]+$/, ''))
    .filter(Boolean)
    .map((word) => classifyToken(word, index))
    .filter(({ category }) => category !== 'identifier')
  return notable.length > 0
    ? notable
    : [{ token: span.trim(), category: 'identifier' }]
}

/**
 * Classifies every code span of one document.
 * @param {{ document: string, markdown: string, index: RepoIndex }} input
 * @returns {(Classified & { document: string, line: number, span: string })[]}
 */
export function checkDocument({ document, markdown, index }) {
  return extractCodeSpans(markdown).flatMap(({ text, line }) =>
    classifySpan(text, index).map((entry) => ({
      ...entry,
      document,
      line,
      span: text,
    })),
  )
}

function countLabel(category, count) {
  const [singular, plural] = CATEGORY_LABELS[category]
  return `${count} ${count === 1 ? singular : plural}`
}

/**
 * @param {string} document Root-relative path with `/` separators.
 * @param {RepoIndex} index
 */
function assertCheckableDocument(document, index) {
  if (
    isSecretName(document) ||
    !document.endsWith('.md') ||
    !index.hasFile(document)
  ) {
    throw new UsageError(
      `${document} is not a tracked Markdown file in the repository.`,
    )
  }
}

/**
 * Checks documents and renders the report.
 * @param {object} [options]
 * @param {string[]} [options.documents] Root-relative Markdown paths.
 * @param {RepoIndex} [options.index]
 * @param {(path: string) => string} [options.readDocument]
 * @param {boolean} [options.verbose] Also list every skipped span.
 * @returns {{ ok: boolean, output: string[], errors: string[] }}
 */
export function runCheck({
  documents = DEFAULT_DOCUMENTS,
  index = loadRepoIndex(),
  readDocument = (path) => readFileSync(join(REPO_ROOT, path), 'utf8'),
  verbose = false,
} = {}) {
  for (const document of documents) assertCheckableDocument(document, index)

  const output = []
  const errors = []
  let unresolved = 0
  for (const document of documents) {
    const entries = checkDocument({
      document,
      markdown: readDocument(document),
      index,
    })
    const problems = entries.filter((entry) => entry.problem)
    unresolved += problems.length
    for (const { line, token, span, problem } of problems) {
      const context = token === span ? '' : ` (in \`${span}\`)`
      errors.push(`${document}:${line}: \`${token}\`${context} ${problem}`)
    }

    const count = (category, resolved) =>
      entries.filter(
        (entry) =>
          entry.category === category &&
          (resolved === undefined || !entry.problem === resolved),
      ).length
    const resolved = [countLabel('path', count('path', true))]
    if (count('specifier') > 0) {
      resolved.push(countLabel('specifier', count('specifier', true)))
    }
    output.push(
      `${document}: resolved ${resolved.join(', ')}${
        problems.length > 0 ? `; ${problems.length} unresolved` : ''
      }`,
    )
    const skipped = SKIPPED_CATEGORIES.filter((category) => count(category))
    output.push(
      skipped.length > 0
        ? `${document}: skipped ${skipped
            .map((category) => countLabel(category, count(category)))
            .join(', ')}`
        : `${document}: skipped nothing`,
    )
    if (verbose) {
      for (const entry of entries) {
        if (!SKIPPED_CATEGORIES.includes(entry.category)) continue
        output.push(
          `  ${document}:${entry.line}: ${entry.category} \`${entry.token}\``,
        )
      }
    }
  }
  if (unresolved > 0) {
    errors.push(
      `${unresolved} unresolved repository ${
        unresolved === 1 ? 'reference' : 'references'
      }. Write paths from the repository root.`,
    )
  }
  return { ok: unresolved === 0, output, errors }
}

/**
 * @param {string[]} argv Document paths (relative to `cwd`) and `--verbose`.
 * @param {string} cwd
 */
function parseArguments(argv, cwd) {
  const verbose = argv.includes('--verbose')
  const paths = argv.filter((arg) => arg !== '--verbose')
  const unknown = paths.find((arg) => arg.startsWith('-'))
  if (unknown) {
    throw new UsageError(
      `Unknown option ${unknown}. Usage: check-agent-paths.mjs [--verbose] [document.md ...]`,
    )
  }
  const documents = paths.map((arg) => {
    const path = relative(REPO_ROOT, resolve(cwd, arg)).split(sep).join('/')
    if (path.startsWith('../') || path === '..') {
      throw new UsageError(`${arg} is outside the repository.`)
    }
    return path
  })
  return { documents: documents.length > 0 ? documents : undefined, verbose }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    const { documents, verbose } = parseArguments(
      process.argv.slice(2),
      process.cwd(),
    )
    const { ok, output, errors } = runCheck({ documents, verbose })
    for (const line of output) console.log(line)
    for (const line of errors) console.error(line)
    process.exitCode = ok ? 0 : 1
  } catch (error) {
    if (!(error instanceof UsageError)) throw error
    console.error(error.message)
    process.exitCode = 2
  }
}
