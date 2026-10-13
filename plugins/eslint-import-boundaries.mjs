// @ts-check
import { existsSync, realpathSync, statSync } from 'node:fs'
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

const DEFAULT_ROOT = fileURLToPath(new URL('../', import.meta.url))

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
 * `forbidPackages` (or that package resolved through `node_modules`), and,
 * when `onlyPaths` is set, any target outside it, bare packages included.
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

const SOURCE_EXTENSIONS = [
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.js',
  '.mjs',
  '.cjs',
  '.jsx',
]

/**
 * Node built-ins named without the `node:` scheme. Only the ones a boundary
 * could plausibly be bypassed with need listing; `node:*` covers the scheme.
 */
const BARE_BUILTINS = new Set([
  'assert',
  'buffer',
  'child_process',
  'crypto',
  'events',
  'fs',
  'fs/promises',
  'module',
  'os',
  'path',
  'perf_hooks',
  'process',
  'stream',
  'url',
  'util',
  'worker_threads',
  'zlib',
])

function toPosix(path) {
  return path.split(sep).join('/')
}

/**
 * The real path of `path`: symlinks in its longest existing ancestor are
 * resolved and the missing rest is appended, so a link cannot rename a
 * boundary away.
 */
function realPath(path) {
  let existing = path
  const missing = []
  while (!existsSync(existing)) {
    const parent = dirname(existing)
    if (parent === existing) return path
    missing.unshift(existing.slice(parent.length + 1))
    existing = parent
  }
  return resolve(realpathSync(existing), ...missing)
}

function isFile(path) {
  return statSync(path, { throwIfNoEntry: false })?.isFile() ?? false
}

/**
 * The file a module path names, the way the bundler and TypeScript look it
 * up: the exact file, the path with a source extension, a `.js` specifier
 * written for its `.ts` source, or a directory index. A path naming no file
 * stays as written, so a boundary still classifies it by directory.
 */
function sourceFile(path) {
  if (isFile(path)) return path
  for (const extension of SOURCE_EXTENSIONS) {
    if (isFile(`${path}${extension}`)) return `${path}${extension}`
  }
  const script = /\.[cm]?jsx?$/.exec(path)
  if (script) {
    const stem = path.slice(0, -script[0].length)
    for (const extension of ['.ts', '.tsx', '.mts', '.cts']) {
      if (isFile(`${stem}${extension}`)) return `${stem}${extension}`
    }
  }
  for (const extension of SOURCE_EXTENSIONS) {
    const index = resolve(path, `index${extension}`)
    if (isFile(index)) return index
  }
  return path
}

/** The canonical repository-relative path of an absolute path. */
function repositoryPath(absolute, rootDir) {
  return toPosix(relative(realPath(rootDir), realPath(absolute)))
}

/**
 * The file a leading-`/` specifier loads. Vite and Vitest look it up under
 * the project root first, which is the workspace package for a file under
 * `packages/<name>` and the repository otherwise; `/@fs/` names a file
 * system path outright. Only a specifier naming no file under a root is an
 * operating system path.
 */
function rootedTarget(specifier, importer, rootDir) {
  if (specifier.startsWith('/@fs/')) return specifier.slice('/@fs'.length)
  const roots = [rootDir]
  const workspacePackage = /^packages\/[^/]+(?=\/)/.exec(
    repositoryPath(importer, rootDir),
  )
  if (workspacePackage) roots.unshift(resolve(rootDir, workspacePackage[0]))
  for (const root of roots) {
    const file = sourceFile(resolve(root, `.${specifier}`))
    if (isFile(file)) return file
  }
  return specifier
}

function aliasTarget(specifier, rootDir) {
  for (const { find, path } of APP_ALIASES) {
    if (specifier === find) return resolve(rootDir, path)
    if (specifier.startsWith(`${find}/`)) {
      return resolve(rootDir, path, specifier.slice(find.length + 1))
    }
  }
  return undefined
}

/**
 * What a module specifier written in `importer` loads: a canonical
 * repository-relative path for relative, root-relative, absolute, `file:`
 * and app alias specifiers, or the bare package name otherwise. Vite query suffixes
 * (`?worker`, `?url`) name the same module.
 *
 * @param {string} specifier
 * @param {string} importer absolute path of the importing file
 * @param {string} [rootDir]
 * @returns {ImportTarget}
 */
export function resolveImportTarget(
  specifier,
  importer,
  rootDir = DEFAULT_ROOT,
) {
  const bare = specifier.replace(/[?#].*$/s, '')
  let absolute
  if (bare.startsWith('file:')) absolute = fileURLToPath(bare)
  else if (bare === '.' || bare === '..' || /^\.\.?\//.test(bare)) {
    absolute = resolve(dirname(importer), bare)
  } else if (bare.startsWith('/')) {
    absolute = rootedTarget(bare, importer, rootDir)
  } else if (isAbsolute(bare)) absolute = bare
  else absolute = aliasTarget(bare, rootDir)

  if (absolute === undefined) {
    if (bare.startsWith('node:')) return { kind: 'package', name: bare }
    if (BARE_BUILTINS.has(bare))
      return { kind: 'package', name: `node:${bare}` }
    const segments = bare.split('/')
    const name = bare.startsWith('@')
      ? segments.slice(0, 2).join('/')
      : segments[0]
    return { kind: 'package', name }
  }
  return { kind: 'path', path: repositoryPath(sourceFile(absolute), rootDir) }
}

/** The package a `node_modules` path belongs to, if it is inside one. */
function nodeModulesPackage(path) {
  const packages = [
    ...path.matchAll(/(?:^|\/)node_modules\/((?:@[^/]+\/)?[^/]+)/g),
  ]
  return packages.at(-1)?.[1]
}

function matchesPackage(name, pattern) {
  if (pattern.endsWith('*')) return name.startsWith(pattern.slice(0, -1))
  return name === pattern
}

/**
 * Why `boundary` refuses `target`, or `undefined` when it allows it.
 *
 * @param {ImportBoundary} boundary
 * @param {ImportTarget} target
 */
function refusal(boundary, target) {
  const packageName =
    target.kind === 'package' ? target.name : nodeModulesPackage(target.path)
  if (
    packageName !== undefined &&
    boundary.forbidPackages?.some((pattern) =>
      matchesPackage(packageName, pattern),
    )
  ) {
    return packageName
  }
  if (target.kind === 'path') {
    if (boundary.forbidPaths?.some((pattern) => pattern.test(target.path))) {
      return target.path
    }
    if (
      boundary.onlyPaths &&
      !boundary.onlyPaths.some((pattern) => pattern.test(target.path))
    ) {
      return target.path
    }
    return undefined
  }
  return boundary.onlyPaths ? target.name : undefined
}

/**
 * Every boundary `importer` (a canonical repository-relative path) is
 * subject to.
 *
 * @param {string} importer
 * @param {readonly ImportBoundary[]} [boundaries]
 */
function boundariesFor(importer, boundaries = IMPORT_BOUNDARIES) {
  const isTest = TEST_FILE.test(importer)
  return boundaries.filter(
    (boundary) =>
      !(boundary.runtimeOnly && isTest) &&
      boundary.from.some((pattern) => pattern.test(importer)),
  )
}

/**
 * The boundary violations of one import, as `{ boundary, target }` pairs.
 *
 * @param {string} specifier
 * @param {string} importer absolute path of the importing file
 * @param {string} [rootDir]
 */
function importViolations(specifier, importer, rootDir = DEFAULT_ROOT) {
  const importerPath = repositoryPath(importer, rootDir)
  const boundaries = boundariesFor(importerPath)
  if (boundaries.length === 0) return []
  const target = resolveImportTarget(specifier, importer, rootDir)
  return boundaries.flatMap((boundary) => {
    const refused = refusal(boundary, target)
    return refused === undefined ? [] : [{ boundary, target: refused }]
  })
}

function staticString(node) {
  if (!node) return undefined
  if (node.type === 'Literal' && typeof node.value === 'string') return node
  if (node.type === 'TemplateLiteral' && node.expressions.length === 0)
    return node
  return undefined
}

function stringValue(node) {
  return node.type === 'Literal' ? node.value : node.quasis[0].value.cooked
}

const VITEST_MODULE_CALLS = new Set([
  'mock',
  'doMock',
  'unmock',
  'doUnmock',
  'importActual',
  'importMock',
])

const REFERENCE_PATH = /^\/\s*<reference\s+path\s*=\s*(["'])([^"']+)\1/

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
    const importerPath = repositoryPath(importer, DEFAULT_ROOT)
    if (boundariesFor(importerPath).length === 0) return {}

    function check(node, specifier) {
      for (const { boundary, target } of importViolations(
        specifier,
        importer,
      )) {
        context.report({
          node,
          messageId: 'refused',
          data: {
            importer: importerPath,
            target,
            boundary: boundary.name,
            reason: boundary.reason,
          },
        })
      }
    }

    function checkSource(source) {
      const literal = staticString(source)
      if (literal) check(literal, stringValue(literal))
    }

    return {
      Program() {
        for (const comment of context.sourceCode.getAllComments()) {
          if (comment.type !== 'Line') continue
          const match = REFERENCE_PATH.exec(comment.value)
          if (match) check(comment, match[2])
        }
      },
      ImportDeclaration(node) {
        checkSource(node.source)
      },
      ExportNamedDeclaration(node) {
        checkSource(node.source)
      },
      ExportAllDeclaration(node) {
        checkSource(node.source)
      },
      ImportExpression(node) {
        checkSource(node.source)
      },
      TSImportType(node) {
        checkSource(node.source ?? node.argument?.literal)
      },
      TSExternalModuleReference(node) {
        checkSource(node.expression)
      },
      CallExpression(node) {
        const { callee } = node
        const isRequire =
          (callee.type === 'Identifier' && callee.name === 'require') ||
          (callee.type === 'MemberExpression' &&
            callee.object.type === 'Identifier' &&
            callee.object.name === 'require' &&
            callee.property.type === 'Identifier' &&
            callee.property.name === 'resolve')
        const isVitestModuleCall =
          callee.type === 'MemberExpression' &&
          callee.object.type === 'Identifier' &&
          callee.object.name === 'vi' &&
          callee.property.type === 'Identifier' &&
          VITEST_MODULE_CALLS.has(callee.property.name)
        if (isRequire || isVitestModuleCall) checkSource(node.arguments[0])
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
          checkSource(specifier)
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
