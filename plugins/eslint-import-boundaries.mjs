// @ts-check
import { statSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import { APP_ALIASES } from '../scripts/build/app-aliases.mjs'

/**
 * @typedef {{
 *   name: string,
 *   reason: string,
 *   from: readonly RegExp[],
 *   runtimeOnly?: boolean,
 *   forbidPaths?: readonly RegExp[],
 *   forbidPackages?: readonly string[],
 *   onlyPaths?: readonly RegExp[],
 * }} ImportBoundary
 *
 * @typedef {{ kind: 'path', path: string } | { kind: 'package', name: string }} ImportTarget
 */

const ROOT = fileURLToPath(new URL('../', import.meta.url))

const RAW_PROCESSOR = 'src/modules/raw-processor'

/** A repository-relative directory and everything under it. */
function under(directory) {
  return new RegExp(`^${directory.replaceAll('.', '\\.')}(?:/|$)`)
}

/** A repository-relative module, with or without a source extension. */
function moduleFile(path) {
  return new RegExp(
    `^${path.replaceAll('.', '\\.')}(?:\\.(?:[cm]?[jt]s|[jt]sx))?$`,
  )
}

/**
 * Who may import whom, by the canonical repository path of both sides. A
 * boundary applies to an importer whose path matches `from`; it then refuses
 * a target whose path matches `forbidPaths`, a bare import of a package in
 * `forbidPackages`, and, when `onlyPaths` is set, any target outside it,
 * bare packages included.
 * `runtimeOnly` boundaries describe what a shipped module graph loads, so
 * they leave test files to their test runner.
 *
 * @type {readonly ImportBoundary[]}
 */
export const IMPORT_BOUNDARIES = Object.freeze([
  {
    name: 'domain-logic',
    reason:
      'services and src/lib hold scriptable domain logic; they may not depend on React components, hooks or the toast UI',
    from: [/^src\/modules\/[^/]+\/services(?:\/|$)/, under('src/lib')],
    forbidPaths: [
      /^src\/modules\/[^/]+\/(?:components|hooks)(?:\/|$)/,
      under('src/components'),
      under('src/hooks'),
    ],
    forbidPackages: ['sonner'],
  },
  {
    name: 'app-library',
    reason:
      'src/lib adapts browser facts and runtimes for every module; it may not import a module',
    from: [under('src/lib')],
    forbidPaths: [under('src/modules')],
  },
  {
    name: 'package-independence',
    reason:
      'workspace packages never import the app; the app imports shared contracts from the packages',
    from: [under('packages')],
    forbidPaths: [under('src')],
  },
  {
    name: 'mobile-surface',
    reason:
      'the mobile shell and the desktop rail are separate surfaces; share policy through services, hooks or components/shared',
    from: [under(`${RAW_PROCESSOR}/components/mobile`)],
    forbidPaths: [under(`${RAW_PROCESSOR}/components/tools`)],
  },
  {
    name: 'desktop-surface',
    reason:
      'the desktop rail and the mobile shell are separate surfaces; share policy through services, hooks or components/shared',
    from: [under(`${RAW_PROCESSOR}/components/tools`)],
    forbidPaths: [under(`${RAW_PROCESSOR}/components/mobile`)],
  },
  {
    name: 'preview-mechanics',
    reason:
      'the preview stage mechanics take their shared canvas and pointer adapters from services/preview, not from a component',
    from: [under(`${RAW_PROCESSOR}/hooks/preview`)],
    forbidPaths: [under(`${RAW_PROCESSOR}/components`)],
  },
  {
    name: 'color-runtime',
    reason:
      'the color runtime is pure color math; it may not load the app, the RAW or JPEG runtime, Node built-ins, React or Jotai',
    from: [under('packages/luma-color-runtime/src')],
    runtimeOnly: true,
    forbidPaths: [
      under('src'),
      under('packages/luma-raw-runtime'),
      under('packages/luma-jpeg-runtime'),
    ],
    forbidPackages: [
      '@lumaforge/luma-raw-runtime',
      '@lumaforge/luma-jpeg-runtime',
      'node:*',
      'react',
      'react-dom',
      'jotai',
    ],
  },
  {
    name: 'geometry-kernel',
    reason:
      '@lumaforge/render-engine/geometry loads only its matrix kernel, so any consumer can import it without a runtime package',
    from: [
      moduleFile('packages/render-engine/src/geometry/index'),
      moduleFile('packages/render-engine/src/export/geometry/matrix'),
    ],
    runtimeOnly: true,
    onlyPaths: [
      moduleFile('packages/render-engine/src/export/geometry/matrix'),
    ],
  },
])

const TEST_FILE = /(?:^|\/)__tests__\/|\.(?:test|spec)\.[cm]?[jt]sx?$/

const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.js', '.mjs', '.jsx']

const VITEST_MODULE_CALLS = new Set([
  'mock',
  'doMock',
  'unmock',
  'doUnmock',
  'importActual',
  'importMock',
])

function isFile(path) {
  return statSync(path, { throwIfNoEntry: false })?.isFile() ?? false
}

/**
 * The file a module path names, the way the bundler looks it up: the exact
 * file, the path with a source extension, or a directory index. A path that
 * names no file stays as written, so a boundary still classifies it by
 * directory.
 */
function sourceFile(path) {
  const candidates = [
    path,
    ...SOURCE_EXTENSIONS.map((extension) => `${path}${extension}`),
    ...SOURCE_EXTENSIONS.map((extension) => resolve(path, `index${extension}`)),
  ]
  return candidates.find(isFile) ?? path
}

function repositoryPath(absolute) {
  return relative(ROOT, absolute).split(sep).join('/')
}

/**
 * What a module specifier written in `importer` loads: a repository-relative
 * path for relative and app alias specifiers, or the package name of a bare
 * specifier. Vite query suffixes (`?worker`, `?url`) name the same module.
 * Node built-ins carry the `node:` scheme, which lint requires.
 *
 * @param {string} specifier
 * @param {string} importer absolute path of the importing file
 * @returns {ImportTarget}
 */
export function resolveImportTarget(specifier, importer) {
  const bare = specifier.replace(/[?#].*$/s, '')
  const alias = APP_ALIASES.find(
    ({ find }) => bare === find || bare.startsWith(`${find}/`),
  )
  let absolute
  if (/^\.\.?(?:\/|$)/.test(bare)) absolute = resolve(dirname(importer), bare)
  else if (alias) {
    absolute = resolve(ROOT, alias.path, bare.slice(alias.find.length + 1))
  }
  if (absolute !== undefined) {
    return { kind: 'path', path: repositoryPath(sourceFile(absolute)) }
  }
  const segments = bare.split('/')
  const name = segments.slice(0, bare.startsWith('@') ? 2 : 1).join('/')
  return { kind: 'package', name }
}

/**
 * Why `boundary` refuses `target`, or `undefined` when it allows it.
 *
 * @param {ImportBoundary} boundary
 * @param {ImportTarget} target
 */
function refusal(boundary, target) {
  if (target.kind === 'package') {
    const forbidden = boundary.forbidPackages?.some((pattern) =>
      pattern.endsWith('*')
        ? target.name.startsWith(pattern.slice(0, -1))
        : target.name === pattern,
    )
    return forbidden || boundary.onlyPaths ? target.name : undefined
  }
  const forbidden =
    boundary.forbidPaths?.some((pattern) => pattern.test(target.path)) ||
    (boundary.onlyPaths &&
      !boundary.onlyPaths.some((pattern) => pattern.test(target.path)))
  return forbidden ? target.path : undefined
}

/** @type {import('eslint').Rule.RuleModule} */
const importBoundariesRule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Enforce module ownership boundaries on resolved import targets',
    },
    schema: [],
    messages: {
      refused:
        "'{{importer}}' may not import '{{target}}' ({{boundary}}): {{reason}}.",
    },
  },
  create(context) {
    const importer = context.physicalFilename
    if (!isAbsolute(importer)) return {}
    const importerPath = repositoryPath(importer)
    const isTest = TEST_FILE.test(importerPath)
    const boundaries = IMPORT_BOUNDARIES.filter(
      (boundary) =>
        !(boundary.runtimeOnly && isTest) &&
        boundary.from.some((pattern) => pattern.test(importerPath)),
    )
    if (boundaries.length === 0) return {}

    function check(source) {
      if (source?.type !== 'Literal' || typeof source.value !== 'string') return
      const target = resolveImportTarget(source.value, importer)
      for (const boundary of boundaries) {
        const refused = refusal(boundary, target)
        if (refused === undefined) continue
        context.report({
          node: source,
          messageId: 'refused',
          data: {
            importer: importerPath,
            target: refused,
            boundary: boundary.name,
            reason: boundary.reason,
          },
        })
      }
    }

    return {
      ImportDeclaration: (node) => check(node.source),
      ExportNamedDeclaration: (node) => check(node.source),
      ExportAllDeclaration: (node) => check(node.source),
      ImportExpression: (node) => check(node.source),
      TSImportType: (node) => check(node.source ?? node.argument?.literal),
      CallExpression(node) {
        const { callee } = node
        if (
          callee.type === 'MemberExpression' &&
          callee.object.type === 'Identifier' &&
          callee.object.name === 'vi' &&
          callee.property.type === 'Identifier' &&
          VITEST_MODULE_CALLS.has(callee.property.name)
        ) {
          check(node.arguments[0])
        }
      },
      NewExpression(node) {
        // `new URL('./x.worker.ts', import.meta.url)` is how a bundled
        // worker or asset module is referenced.
        const [specifier, base] = node.arguments
        if (
          node.callee.type === 'Identifier' &&
          node.callee.name === 'URL' &&
          base?.type === 'MemberExpression' &&
          base.object.type === 'MetaProperty' &&
          base.property.type === 'Identifier' &&
          base.property.name === 'url'
        ) {
          check(specifier)
        }
      },
    }
  },
}

/** @type {import('eslint').ESLint.Plugin} */
const plugin = {
  meta: { name: 'lumaforge-import-boundaries' },
  rules: { 'import-boundaries': importBoundariesRule },
}

export default plugin
