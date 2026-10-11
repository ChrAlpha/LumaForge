import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { isAbsolute, join, posix, relative, resolve, sep } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { isMainModule } from './is-main-module.mjs'

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
 * Aliases into the app itself rather than a workspace package. They are the
 * only aliases exempt from the package checks, and they may not target or
 * name a workspace package.
 *
 * @type {readonly string[]}
 */
export const APP_LOCAL_ALIASES = Object.freeze(['~', '@pkg'])

/**
 * Workspace packages the browser app never imports, so they carry no alias:
 * the `lmfg` CLI, its MCP server and the Node-only native artifact loader.
 *
 * @type {readonly string[]}
 */
export const APP_UNALIASED_PACKAGES = Object.freeze([
  '@lumaforge/lmfg-cli',
  '@lumaforge/lmfg-mcp',
  '@lumaforge/luma-native-artifacts',
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
 * Why an object has properties the plain enumeration below would not see,
 * or `undefined`: every own key must be an enumerable string-keyed data
 * property. `skip` names one own key the caller accounts for itself.
 */
function hiddenPropertyShape(value, skip) {
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key === 'symbol') return `has symbol key ${String(key)}`
    if (key === skip) continue
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor.enumerable) return `has non-enumerable key ${key}`
    if (!('value' in descriptor)) return `has accessor key ${key}`
  }
  return undefined
}

/**
 * Why a value is not a plain record, or `undefined`: a non-array object with
 * `Object.prototype` or no prototype, so it inherits no entries, and only
 * enumerable own data properties. Inherited and hidden entries would be
 * honored by one reader and skipped by another, so they are refused.
 */
function objectShape(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return 'not an object'
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    const inherited = []
    for (const key in value) {
      if (!Object.hasOwn(value, key)) inherited.push(key)
    }
    return inherited.length > 0
      ? `has a custom prototype (inherited keys: ${inherited.join(', ')})`
      : 'has a custom prototype'
  }
  return hiddenPropertyShape(value)
}

function isPlainObject(value) {
  return objectShape(value) === undefined
}

const INDEX_KEY = /^(?:0|[1-9]\d*)$/

/**
 * Why a value is not a plain list, or `undefined`: a dense array with
 * `Array.prototype` and only index entries below its length, so every reader
 * sees the same entries in the same order. A canonical decimal key at or
 * past the length (4294967295 and up) is an ordinary property, not an index.
 */
function listShape(value) {
  if (!Array.isArray(value)) return 'not an array'
  if (Object.getPrototypeOf(value) !== Array.prototype) {
    return 'has a custom prototype'
  }
  const hidden = hiddenPropertyShape(value, 'length')
  if (hidden !== undefined) return hidden
  for (const key of Object.keys(value)) {
    if (!INDEX_KEY.test(key) || Number(key) >= value.length) {
      return `has non-index key ${key}`
    }
  }
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) return `has a hole at ${index}`
  }
  return undefined
}

/** Why a value is not a plain list of strings, or `undefined`. */
function stringListShape(value) {
  const shape = listShape(value)
  if (shape !== undefined) return shape
  const index = value.findIndex((entry) => typeof entry !== 'string')
  return index === -1 ? undefined : `entry ${index} is not a string`
}

function isStringList(value) {
  return stringListShape(value) === undefined
}

const ALIAS_KEYS = ['find', 'path']

/**
 * Why an alias entry is outside the form the configs consume, or
 * `undefined`: an object with exactly its own `find` and `path` strings, a
 * `find` that is a bare specifier prefix, and a normalized path inside the
 * repository.
 */
function invalidAlias(alias) {
  const shape = objectShape(alias)
  if (shape === 'not an object') return 'is not an object'
  if (shape !== undefined) return shape
  for (const key of Object.keys(alias)) {
    if (!ALIAS_KEYS.includes(key)) return `has unknown key ${key}`
  }
  for (const key of ALIAS_KEYS) {
    if (!Object.hasOwn(alias, key)) return `has no own ${key}`
    if (typeof alias[key] !== 'string' || alias[key] === '') {
      return `${key} is not a non-empty string`
    }
  }
  if (alias.find.includes('*') || alias.find.endsWith('/')) {
    return `find ${alias.find} is not a bare specifier prefix`
  }
  const { path } = alias
  if (
    isAbsolute(path) ||
    path.includes('\\') ||
    path.endsWith('/') ||
    posix.normalize(path) !== path ||
    path === '.' ||
    path === '..' ||
    path.startsWith('../')
  ) {
    return `path ${path} is not a normalized path inside the repository`
  }
  return undefined
}

const CONDITION_KEY = /^[a-z][a-z0-9-]*$/i

/**
 * A `./` file target inside the package: plain path segments, with no `.`,
 * `..`, `node_modules`, pattern, backslash or trailing directory form, all of
 * which Node either rejects or resolves by its own rules.
 */
function isFileTarget(target) {
  if (
    !target.startsWith('./') ||
    target.includes('*') ||
    target.includes('\\')
  ) {
    return false
  }
  return target
    .slice(2)
    .split('/')
    .every(
      (segment) =>
        segment !== '' &&
        segment !== '.' &&
        segment !== '..' &&
        segment.toLowerCase() !== 'node_modules',
    )
}

/**
 * Why an `exports` target is outside the forms this check understands, or
 * `undefined` when it is one of them: a `./` file string, or a non-empty
 * condition object with plain condition names whose leaves are all such
 * strings. Node gives `null`, fallback arrays and condition order their own
 * resolution rules; rather than mirror them, the check refuses any other form
 * until it is taught that form.
 */
function unsupportedTargetForm(target) {
  if (typeof target === 'string') {
    return isFileTarget(target) ? undefined : `string ${target}`
  }
  if (target === null) return 'null'
  if (Array.isArray(target)) return 'array'
  if (typeof target !== 'object') return typeof target
  const entries = Object.entries(target)
  if (entries.length === 0) return 'empty object'
  for (const [condition, value] of entries) {
    if (!CONDITION_KEY.test(condition)) return `condition key ${condition}`
    const form = unsupportedTargetForm(value)
    if (form !== undefined) return form
  }
  return undefined
}

/** An exact subpath key: `.` or `./name`, with no pattern or folder form. */
function isExactSubpath(key) {
  return (
    key === '.' ||
    (key.startsWith('./') &&
      key.length > 2 &&
      !key.includes('*') &&
      !key.endsWith('/'))
  )
}

/**
 * A manifest's `exports` field split into the subpaths it exports and the
 * subpaths (or the whole field) whose form the check does not support.
 */
function exportedSubpaths(exports) {
  if (exports === undefined) {
    return { exported: [], unsupported: [{ subpath: '.', form: 'no exports' }] }
  }
  const keys = isPlainObject(exports) ? Object.keys(exports) : []
  const subpathKeys = keys.filter((key) => key.startsWith('.'))
  if (subpathKeys.length > 0 && subpathKeys.length !== keys.length) {
    return {
      exported: [],
      unsupported: [{ subpath: '.', form: 'subpath and condition keys mixed' }],
    }
  }
  const map = subpathKeys.length > 0 ? exports : { '.': exports }
  const exported = []
  const unsupported = []
  for (const [subpath, target] of Object.entries(map)) {
    const form = isExactSubpath(subpath)
      ? unsupportedTargetForm(target)
      : 'subpath pattern or folder'
    if (form === undefined) exported.push(subpath)
    else unsupported.push({ subpath, form })
  }
  return { exported, unsupported }
}

/**
 * An npm package name, optionally scoped. Specifiers are matched to packages
 * by `name` and `name/...`, which only names one package when every name has
 * this form.
 */
const PACKAGE_NAME = /^(?:@[a-z0-9~-][a-z0-9._~-]*\/)?[a-z0-9~-][a-z0-9._~-]*$/

/**
 * Workspace package names mapped to their repository-relative directories,
 * read from every `packages/*` directory. Dot entries are outside the
 * workspace glob; any other entry must be a directory with a readable,
 * named manifest.
 */
function workspacePackages(rootDir, problems) {
  const packagesDir = join(rootDir, 'packages')
  const packages = new Map()
  let entries
  try {
    entries = readdirSync(packagesDir, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    )
  } catch (error) {
    problems.push(`packages: unreadable (${error.message})`)
    return packages
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    const dir = `packages/${entry.name}`
    if (!entry.isDirectory()) {
      problems.push(`${dir}: not a package directory`)
      continue
    }
    let manifest
    try {
      manifest = JSON.parse(
        readFileSync(join(rootDir, dir, 'package.json'), 'utf8'),
      )
    } catch (error) {
      problems.push(`${dir}/package.json: unreadable (${error.message})`)
      continue
    }
    if (
      !isPlainObject(manifest) ||
      typeof manifest.name !== 'string' ||
      manifest.name === ''
    ) {
      problems.push(`${dir}/package.json: name is not a non-empty string`)
      continue
    }
    if (!PACKAGE_NAME.test(manifest.name)) {
      problems.push(
        `${dir}/package.json: name ${manifest.name} is not a package name`,
      )
      continue
    }
    if (packages.has(manifest.name)) {
      problems.push(
        `${manifest.name}: declared by both ${packages.get(manifest.name).dir} and ${dir}`,
      )
      continue
    }
    const { exported, unsupported } = exportedSubpaths(manifest.exports)
    packages.set(manifest.name, { dir, exports: exported, unsupported })
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

const OPTION_DEFAULTS = Object.freeze({
  __proto__: null,
  rootDir: DEFAULT_ROOT,
  aliases: APP_ALIASES,
  localAliases: APP_LOCAL_ALIASES,
  unaliasedPackages: APP_UNALIASED_PACKAGES,
  unaliasedSubpaths: APP_UNALIASED_SUBPATHS,
})

const OPTION_KEYS = Object.keys(OPTION_DEFAULTS)

/**
 * Every way the alias list, `tsconfig.json` `paths` and the workspace
 * packages' `exports` disagree, as messages. Empty means consistent.
 *
 * @param {{
 *   rootDir?: string,
 *   aliases?: readonly AppAlias[],
 *   localAliases?: readonly string[],
 *   unaliasedPackages?: readonly string[],
 *   unaliasedSubpaths?: Readonly<Record<string, readonly string[]>>,
 * }} [options]
 * @returns {string[]}
 */
export function checkAppAliases(options = {}) {
  const problems = []
  // A misspelled or inherited option would otherwise fall back to the
  // default unseen, so options are read only as own, known entries.
  const optionsShape = objectShape(options)
  if (optionsShape !== undefined) problems.push(`options: ${optionsShape}`)
  const given = optionsShape === undefined ? options : {}
  for (const key of Object.keys(given)) {
    if (!OPTION_KEYS.includes(key)) {
      problems.push(`options: has unknown key ${key}`)
    }
  }
  const option = (key) =>
    Object.hasOwn(given, key) && given[key] !== undefined
      ? given[key]
      : OPTION_DEFAULTS[key]
  const rootDir = option('rootDir')
  const aliases = option('aliases')
  const localAliases = option('localAliases')
  const unaliasedPackages = option('unaliasedPackages')
  const unaliasedSubpaths = option('unaliasedSubpaths')
  if (typeof rootDir !== 'string' || rootDir === '') {
    problems.push('rootDir: not a non-empty string')
    return problems
  }

  const packages = workspacePackages(rootDir, problems)
  for (const [name, info] of packages) {
    for (const { subpath, form } of info.unsupported) {
      problems.push(
        `${name}: unsupported export target form at ${subpath} (${form}); extend scripts/quality/app-aliases.mjs deliberately before adopting it`,
      )
    }
  }

  const validAliases = []
  const aliasesShape = listShape(aliases)
  if (aliasesShape !== undefined) {
    problems.push(`aliases: ${aliasesShape}`)
  } else {
    aliases.forEach((alias, index) => {
      const reason = invalidAlias(alias)
      if (reason === undefined) validAliases.push(alias)
      else problems.push(`alias ${index}: ${reason}`)
    })
  }
  const localShape = stringListShape(localAliases)
  const local = localShape === undefined ? localAliases : []
  if (localShape !== undefined) {
    problems.push(`localAliases: not a list of strings (${localShape})`)
  }
  const exemptShape = stringListShape(unaliasedPackages)
  const exemptPackages = exemptShape === undefined ? unaliasedPackages : []
  if (exemptShape !== undefined) {
    problems.push(`unaliasedPackages: not a list of strings (${exemptShape})`)
  }

  const seen = new Set()
  validAliases.forEach((alias, index) => {
    if (seen.has(alias.find)) problems.push(`${alias.find}: aliased twice`)
    seen.add(alias.find)
    for (const earlier of validAliases.slice(0, index)) {
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
  for (const find of local) {
    if (!seen.has(find)) {
      problems.push(`${find}: listed as a local alias but not aliased`)
    }
  }

  const aliasedSubpaths = new Map()
  for (const alias of validAliases) {
    const target = packageSpecifier(alias.find, packages)
    if (local.includes(alias.find)) {
      if (target) {
        problems.push(
          `${alias.find}: local alias names workspace package ${target.name}`,
        )
      }
      if (alias.path === 'packages' || alias.path.startsWith('packages/')) {
        problems.push(
          `${alias.find}: local alias targets ${alias.path} inside the workspace packages`,
        )
      }
      continue
    }
    if (!target) {
      problems.push(
        `${alias.find}: names no workspace package and is not a local alias`,
      )
      continue
    }
    const { name, info, subpath } = target
    const unsupported = info.unsupported.some(
      (entry) => entry.subpath === subpath,
    )
    if (!info.exports.includes(subpath) && !unsupported) {
      problems.push(`${alias.find}: ${name} does not export ${subpath}`)
    }
    const source = relative(info.dir, alias.path).split(sep).join('/')
    if (!source.startsWith('src/')) {
      problems.push(`${alias.find}: target ${alias.path} is not ${name} source`)
    }
    if (!aliasedSubpaths.has(name)) aliasedSubpaths.set(name, new Set())
    aliasedSubpaths.get(name).add(subpath)
  }

  for (const name of packages.keys()) {
    const exempt = exemptPackages.includes(name)
    if (aliasedSubpaths.has(name) && exempt) {
      problems.push(`${name}: aliased but listed as an unaliased package`)
    } else if (!aliasedSubpaths.has(name) && !exempt) {
      problems.push(
        `${name}: workspace package has no app alias and is not listed as unaliased`,
      )
    }
  }
  for (const name of exemptPackages) {
    if (!packages.has(name)) {
      problems.push(
        `${name}: listed as unaliased but names no workspace package`,
      )
    }
  }

  const subpathsShape = objectShape(unaliasedSubpaths)
  if (subpathsShape !== undefined) {
    problems.push(`unaliasedSubpaths: ${subpathsShape}`)
  } else {
    for (const [name, subpaths] of Object.entries(unaliasedSubpaths)) {
      const shape = stringListShape(subpaths)
      if (shape !== undefined) {
        problems.push(
          `${name}: unaliased subpaths are not a list of strings (${shape})`,
        )
        continue
      }
      if (!aliasedSubpaths.has(name)) {
        problems.push(
          `${name}: lists unaliased subpaths but is not an aliased workspace package`,
        )
        continue
      }
      for (const subpath of subpaths) {
        if (!packages.get(name).exports.includes(subpath)) {
          problems.push(
            `${name}: lists unaliased subpath ${subpath} that it does not export`,
          )
        } else if (aliasedSubpaths.get(name).has(subpath)) {
          problems.push(
            `${name}: lists unaliased subpath ${subpath} that has an alias`,
          )
        }
      }
    }
  }
  for (const [name, subpaths] of aliasedSubpaths) {
    const skipped =
      subpathsShape === undefined &&
      Object.hasOwn(unaliasedSubpaths, name) &&
      isStringList(unaliasedSubpaths[name])
        ? unaliasedSubpaths[name]
        : []
    for (const subpath of packages.get(name).exports) {
      if (!subpaths.has(subpath) && !skipped.includes(subpath)) {
        problems.push(`${name}: export ${subpath} has no app alias`)
      }
    }
  }

  const tsconfigPath = join(rootDir, 'tsconfig.json')
  let actual = {}
  try {
    const tsconfig = JSON.parse(readFileSync(tsconfigPath, 'utf8'))
    if (!isPlainObject(tsconfig)) throw new Error('not an object')
    const compilerOptions =
      tsconfig.compilerOptions === undefined ? {} : tsconfig.compilerOptions
    if (!isPlainObject(compilerOptions)) {
      throw new Error('compilerOptions is not an object')
    }
    const paths =
      compilerOptions.paths === undefined ? {} : compilerOptions.paths
    if (isPlainObject(paths)) actual = paths
    else problems.push('tsconfig.json: paths is not an object')
    // The expected paths are written relative to the repository root, so
    // they only mean the same files while TypeScript resolves them there:
    // with no `baseUrl` (relative to tsconfig.json) or a root `baseUrl`. An
    // inherited config could move that base or replace the paths unseen.
    if (tsconfig.extends !== undefined) {
      problems.push(
        'tsconfig.json: extends is not supported; paths must be declared and resolved in tsconfig.json',
      )
    }
    if (
      compilerOptions.baseUrl !== undefined &&
      (typeof compilerOptions.baseUrl !== 'string' ||
        resolve(rootDir, compilerOptions.baseUrl) !== resolve(rootDir))
    ) {
      problems.push(
        `tsconfig.json: baseUrl ${JSON.stringify(compilerOptions.baseUrl)} moves paths off the repository root`,
      )
    }
  } catch (error) {
    problems.push(`tsconfig.json: unreadable (${error.message})`)
  }
  const expected = expectedTsconfigPaths(rootDir, validAliases)
  for (const [key, targets] of Object.entries(expected)) {
    if (!Object.hasOwn(actual, key)) {
      problems.push(`tsconfig.json: paths is missing ${key}`)
    } else if (!sameStringList(actual[key], targets)) {
      problems.push(
        `tsconfig.json: paths ${key} is ${JSON.stringify(actual[key])}, expected ${JSON.stringify(targets)}`,
      )
    }
  }
  for (const key of Object.keys(actual)) {
    if (!Object.hasOwn(expected, key)) {
      problems.push(`tsconfig.json: paths ${key} has no app alias`)
    }
  }

  return problems
}

if (isMainModule(import.meta.url)) {
  const problems = checkAppAliases()
  for (const problem of problems) console.error(problem)
  if (problems.length === 0) console.log('app aliases: consistent')
  process.exitCode = problems.length === 0 ? 0 : 1
}
