import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * @typedef {{ find: string, path: string }} AppAlias
 * @typedef {{ find: string, replacement: string }} ResolvedAppAlias
 */

/**
 * The app's source aliases, in match order. Vite and the app test project
 * both resolve imports through this one list, and `tsconfig.json` `paths`
 * must name the same targets. A string alias also matches every `find/...`
 * specifier, so a package subpath has to precede its package root.
 *
 * @type {readonly AppAlias[]}
 */
export const APP_ALIASES = Object.freeze([
  { find: '~', path: 'src' },
  { find: '@pkg', path: 'package.json' },
  {
    find: '@lumaforge/luma-color-runtime/wgsl',
    path: 'packages/luma-color-runtime/src/wgsl.ts',
  },
  {
    find: '@lumaforge/luma-color-runtime',
    path: 'packages/luma-color-runtime/src/index.ts',
  },
  {
    find: '@lumaforge/luma-raw-runtime',
    path: 'packages/luma-raw-runtime/src/index.ts',
  },
  {
    find: '@lumaforge/luma-jpeg-runtime',
    path: 'packages/luma-jpeg-runtime/src/index.ts',
  },
  {
    find: '@lumaforge/render-engine/export',
    path: 'packages/render-engine/src/export/index.ts',
  },
  {
    find: '@lumaforge/render-engine/geometry',
    path: 'packages/render-engine/src/geometry/index.ts',
  },
  {
    find: '@lumaforge/render-engine/manifest',
    path: 'packages/render-engine/src/manifest/index.ts',
  },
  {
    find: '@lumaforge/render-engine/policy',
    path: 'packages/render-engine/src/policy/index.ts',
  },
  {
    find: '@lumaforge/render-engine/preview',
    path: 'packages/render-engine/src/preview/index.ts',
  },
  {
    find: '@lumaforge/render-engine',
    path: 'packages/render-engine/src/index.ts',
  },
])

/**
 * Package export subpaths the browser app never imports, so they carry no
 * alias: the Node entries `lmfg` and the runtime tests consume from dist.
 *
 * @type {Readonly<Record<string, readonly string[]>>}
 */
export const APP_UNALIASED_SUBPATHS = Object.freeze({
  '@lumaforge/luma-raw-runtime': ['./node'],
  '@lumaforge/luma-jpeg-runtime': ['./node'],
})

const DEFAULT_ROOT = fileURLToPath(new URL('../../', import.meta.url))

/**
 * The aliases with absolute replacements, for `resolve.alias`.
 *
 * @param {string} [rootDir]
 * @param {readonly AppAlias[]} [aliases]
 * @returns {ResolvedAppAlias[]}
 */
export function resolveAppAliases(
  rootDir = DEFAULT_ROOT,
  aliases = APP_ALIASES,
) {
  return aliases.map(({ find, path }) => ({
    find,
    replacement: resolve(rootDir, path),
  }))
}

function isDirectoryAlias(rootDir, alias) {
  return (
    statSync(resolve(rootDir, alias.path), {
      throwIfNoEntry: false,
    })?.isDirectory() ?? false
  )
}

/**
 * The `tsconfig.json` `paths` the aliases require. A directory alias maps a
 * `find/*` pattern; a file alias maps its exact specifier.
 *
 * @param {string} [rootDir]
 * @param {readonly AppAlias[]} [aliases]
 * @returns {Record<string, string[]>}
 */
export function expectedTsconfigPaths(
  rootDir = DEFAULT_ROOT,
  aliases = APP_ALIASES,
) {
  return Object.fromEntries(
    aliases.map((alias) =>
      isDirectoryAlias(rootDir, alias)
        ? [`${alias.find}/*`, [`./${alias.path}/*`]]
        : [alias.find, [`./${alias.path}`]],
    ),
  )
}

function shadows(earlier, later) {
  return later === earlier || later.startsWith(`${earlier}/`)
}

/**
 * What an `exports` target resolves to under one set of active conditions:
 * `true` for a file, `false` when blocked, `undefined` when no condition
 * matches. Condition keys are tried in order and the first match decides,
 * so a `null` reached first blocks the subpath even if a later condition
 * names a file. A fallback array likewise stops at its first item that
 * resolves or blocks.
 */
function resolveTarget(target, conditions) {
  if (typeof target === 'string') return true
  if (Array.isArray(target)) {
    for (const item of target) {
      const resolved = resolveTarget(item, conditions)
      if (resolved !== undefined) return resolved
    }
    return false
  }
  if (target && typeof target === 'object') {
    for (const [condition, value] of Object.entries(target)) {
      if (condition !== 'default' && !conditions.has(condition)) continue
      const resolved = resolveTarget(value, conditions)
      if (resolved !== undefined) return resolved
    }
    return undefined
  }
  return false
}

function targetConditions(target, names = new Set()) {
  if (Array.isArray(target)) {
    for (const item of target) targetConditions(item, names)
  } else if (target && typeof target === 'object') {
    for (const [condition, value] of Object.entries(target)) {
      if (condition !== 'default') names.add(condition)
      targetConditions(value, names)
    }
  }
  return names
}

/**
 * Whether an `exports` target resolves to a file under some set of active
 * conditions. Every subset of the conditions the target names is tried.
 */
function isExportedTarget(target) {
  const names = [...targetConditions(target)]
  for (let mask = 0; mask < 2 ** names.length; mask++) {
    const active = new Set(names.filter((_, bit) => mask & (2 ** bit)))
    if (resolveTarget(target, active) === true) return true
  }
  return false
}

/** The export subpaths a manifest's `exports` field lets importers resolve. */
function exportedSubpaths(exports) {
  if (exports === undefined || exports === null) return []
  const map =
    typeof exports === 'string' ||
    Array.isArray(exports) ||
    !Object.keys(exports).some((key) => key.startsWith('.'))
      ? { '.': exports }
      : exports
  return Object.entries(map)
    .filter(([, target]) => isExportedTarget(target))
    .map(([subpath]) => subpath)
}

/** Workspace package names mapped to their repository-relative directories. */
function workspacePackages(rootDir) {
  const packagesDir = join(rootDir, 'packages')
  const packages = new Map()
  if (!existsSync(packagesDir)) return packages
  for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const manifestPath = join(packagesDir, entry.name, 'package.json')
    if (!existsSync(manifestPath)) continue
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    packages.set(manifest.name, {
      dir: `packages/${entry.name}`,
      exports: exportedSubpaths(manifest.exports),
    })
  }
  return packages
}

/** The workspace package a specifier names, and its export subpath. */
function packageSpecifier(specifier, packages) {
  for (const [name, info] of packages) {
    if (specifier === name) return { name, info, subpath: '.' }
    if (specifier.startsWith(`${name}/`)) {
      return { name, info, subpath: `./${specifier.slice(name.length + 1)}` }
    }
  }
  return undefined
}

function sameStringList(a, b) {
  return (
    Array.isArray(a) &&
    a.length === b.length &&
    a.every((value, index) => value === b[index])
  )
}

/**
 * Every way the alias list, `tsconfig.json` `paths` and the aliased packages'
 * `exports` disagree, as messages. Empty means consistent.
 *
 * @param {{
 *   rootDir?: string,
 *   aliases?: readonly AppAlias[],
 *   unaliasedSubpaths?: Readonly<Record<string, readonly string[]>>,
 * }} [options]
 * @returns {string[]}
 */
export function checkAppAliases({
  rootDir = DEFAULT_ROOT,
  aliases = APP_ALIASES,
  unaliasedSubpaths = APP_UNALIASED_SUBPATHS,
} = {}) {
  const problems = []
  const packages = workspacePackages(rootDir)

  const seen = new Set()
  aliases.forEach((alias, index) => {
    if (seen.has(alias.find)) problems.push(`${alias.find}: aliased twice`)
    seen.add(alias.find)
    for (const earlier of aliases.slice(0, index)) {
      if (earlier.find !== alias.find && shadows(earlier.find, alias.find)) {
        problems.push(
          `${alias.find}: shadowed by the earlier ${earlier.find} alias`,
        )
      }
    }
    if (!existsSync(resolve(rootDir, alias.path))) {
      problems.push(`${alias.find}: target ${alias.path} does not exist`)
    }
  })

  const aliasedSubpaths = new Map()
  for (const alias of aliases) {
    const target = packageSpecifier(alias.find, packages)
    if (!target) continue
    const { name, info, subpath } = target
    if (!info.exports.includes(subpath)) {
      problems.push(`${alias.find}: ${name} does not export ${subpath}`)
    }
    const source = relative(info.dir, alias.path).split(sep).join('/')
    if (!source.startsWith('src/')) {
      problems.push(`${alias.find}: target ${alias.path} is not ${name} source`)
    }
    if (!aliasedSubpaths.has(name)) aliasedSubpaths.set(name, new Set())
    aliasedSubpaths.get(name).add(subpath)
  }
  for (const [name, subpaths] of aliasedSubpaths) {
    const skipped = unaliasedSubpaths[name] ?? []
    for (const subpath of packages.get(name).exports) {
      if (!subpaths.has(subpath) && !skipped.includes(subpath)) {
        problems.push(`${name}: export ${subpath} has no app alias`)
      }
    }
  }

  const tsconfigPath = join(rootDir, 'tsconfig.json')
  let actual = {}
  try {
    actual =
      JSON.parse(readFileSync(tsconfigPath, 'utf8')).compilerOptions?.paths ??
      {}
  } catch (error) {
    problems.push(`tsconfig.json: unreadable (${error.message})`)
  }
  const expected = expectedTsconfigPaths(rootDir, aliases)
  for (const [key, targets] of Object.entries(expected)) {
    if (!(key in actual)) {
      problems.push(`tsconfig.json: paths is missing ${key}`)
    } else if (!sameStringList(actual[key], targets)) {
      problems.push(
        `tsconfig.json: paths ${key} is ${JSON.stringify(actual[key])}, expected ${JSON.stringify(targets)}`,
      )
    }
  }
  for (const key of Object.keys(actual)) {
    if (!(key in expected)) {
      problems.push(`tsconfig.json: paths ${key} has no app alias`)
    }
  }

  return problems
}
