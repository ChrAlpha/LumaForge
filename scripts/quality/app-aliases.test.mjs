// @vitest-environment node
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import {
  APP_ALIASES,
  checkAppAliases,
  expectedTsconfigPaths,
  resolveAppAliases,
} from './app-aliases.mjs'

// Runs under `node --test` and under the Vitest tooling project.
const { describe, it } = process.env.VITEST
  ? await import('vitest')
  : await import('node:test')

const repoRoot = fileURLToPath(new URL('../../', import.meta.url))

const FIXTURE_ALIASES = [
  { find: '~', path: 'src' },
  { find: '@pkg', path: 'package.json' },
  { find: '@lf/engine/policy', path: 'packages/engine/src/policy.ts' },
  { find: '@lf/engine', path: 'packages/engine/src/index.ts' },
]

const FIXTURE_TSCONFIG_PATHS = {
  '~/*': ['./src/*'],
  '@pkg': ['./package.json'],
  '@lf/engine/policy': ['./packages/engine/src/policy.ts'],
  '@lf/engine': ['./packages/engine/src/index.ts'],
}

function write(root, path, content) {
  mkdirSync(join(root, path, '..'), { recursive: true })
  writeFileSync(join(root, path), content)
}

/** A consistent miniature repository; `edit` introduces one drift. */
function withFixture(edit, run) {
  const root = mkdtempSync(join(tmpdir(), 'lf-app-aliases-'))
  const state = {
    aliases: FIXTURE_ALIASES.map((alias) => ({ ...alias })),
    paths: structuredClone(FIXTURE_TSCONFIG_PATHS),
    tsconfig: {},
    compilerOptions: {},
    tsconfigText: undefined,
    name: '@lf/engine',
    exports: {
      '.': './dist/index.js',
      './policy': './dist/policy.js',
      './node': './dist/node.js',
    },
    // Further `packages/<dir>/package.json` manifests: an object is written
    // as JSON, a string verbatim, and `null` writes no manifest.
    manifests: { cli: { name: '@lf/cli', exports: './dist/index.js' } },
    files: {},
    localAliases: ['~', '@pkg'],
    unaliasedPackages: ['@lf/cli'],
    unaliasedSubpaths: { '@lf/engine': ['./node'] },
  }
  edit?.(state, root)
  try {
    write(root, 'package.json', '{"name":"fixture"}')
    write(root, 'src/main.ts', '')
    write(root, 'packages/engine/src/index.ts', '')
    write(root, 'packages/engine/src/policy.ts', '')
    write(root, 'packages/engine/dist/index.js', '')
    write(
      root,
      'packages/engine/package.json',
      JSON.stringify({ name: state.name, exports: state.exports }),
    )
    for (const [dir, manifest] of Object.entries(state.manifests)) {
      mkdirSync(join(root, 'packages', dir), { recursive: true })
      if (manifest === null) continue
      write(
        root,
        `packages/${dir}/package.json`,
        typeof manifest === 'string' ? manifest : JSON.stringify(manifest),
      )
    }
    for (const [path, content] of Object.entries(state.files)) {
      write(root, path, content)
    }
    write(
      root,
      'tsconfig.json',
      state.tsconfigText ??
        JSON.stringify({
          ...state.tsconfig,
          compilerOptions: { ...state.compilerOptions, paths: state.paths },
        }),
    )
    return run(
      checkAppAliases({
        rootDir: root,
        aliases: state.aliases,
        localAliases: state.localAliases,
        unaliasedPackages: state.unaliasedPackages,
        unaliasedSubpaths: state.unaliasedSubpaths,
      }),
      root,
    )
  } finally {
    rmSync(root, { force: true, recursive: true })
  }
}

const MISSING_ALL_PATHS = Object.keys(FIXTURE_TSCONFIG_PATHS).map(
  (key) => `tsconfig.json: paths is missing ${key}`,
)

function unsupported(name, subpath, form) {
  return `${name}: unsupported export target form at ${subpath} (${form}); extend scripts/quality/app-aliases.mjs deliberately before adopting it`
}

/** The list with no entry at `index`, keeping its length. */
function withHole(list, index) {
  delete list[index]
  return list
}

/** Problems with any trailing `(<system error>)` detail reduced to `(…)`. */
function withoutErrorDetail(problems) {
  return problems.map((problem) =>
    problem.replace(/: unreadable \(.*\)$/, ': unreadable (…)'),
  )
}

describe('app aliases', () => {
  it('agree with tsconfig paths and the aliased package exports', () => {
    assert.deepEqual(checkAppAliases(), [])
  })

  it('cover ~/, @pkg and every browser package entry, subpaths first', () => {
    assert.deepEqual(
      APP_ALIASES.map((alias) => alias.find),
      [
        '~',
        '@pkg',
        '@lumaforge/luma-color-runtime/wgsl',
        '@lumaforge/luma-color-runtime',
        '@lumaforge/luma-raw-runtime',
        '@lumaforge/luma-jpeg-runtime',
        '@lumaforge/render-engine/export',
        '@lumaforge/render-engine/geometry',
        '@lumaforge/render-engine/manifest',
        '@lumaforge/render-engine/policy',
        '@lumaforge/render-engine/preview',
        '@lumaforge/render-engine',
      ],
    )
    assert.deepEqual(resolveAppAliases(repoRoot).slice(0, 2), [
      { find: '~', replacement: resolve(repoRoot, 'src') },
      { find: '@pkg', replacement: resolve(repoRoot, 'package.json') },
    ])
    assert.deepEqual(expectedTsconfigPaths(repoRoot)['~/*'], ['./src/*'])
  })

  it('accepts the consistent fixture', () => {
    withFixture(undefined, (problems) => assert.deepEqual(problems, []))
  })

  it('refuses an alias for a subpath the package does not export', () => {
    withFixture(
      (state) => {
        delete state.exports['./policy']
      },
      (problems) =>
        assert.deepEqual(problems, [
          '@lf/engine/policy: @lf/engine does not export ./policy',
        ]),
    )
  })

  it('accepts a condition object target', () => {
    withFixture(
      (state) => {
        state.exports['.'] = {
          types: './dist/index.d.ts',
          import: './dist/index.js',
        }
        state.exports['./policy'] = {
          types: './dist/policy.d.ts',
          import: { browser: './dist/policy.js', default: './dist/policy.js' },
        }
      },
      (problems) => assert.deepEqual(problems, []),
    )
  })

  it('refuses export target forms it does not support', () => {
    const cases = [
      [null, 'null'],
      [['./dist/policy.js'], 'array'],
      [[null, './dist/policy.js'], 'array'],
      [{ types: './dist/policy.d.ts', import: { node: null } }, 'null'],
      [{}, 'empty object'],
      [{ import: 1 }, 'number'],
      ['dist/policy.js', 'string dist/policy.js'],
      ['./dist/../policy.js', 'string ./dist/../policy.js'],
      ['./dist/./policy.js', 'string ./dist/./policy.js'],
      ['./dist//policy.js', 'string ./dist//policy.js'],
      ['./dist/', 'string ./dist/'],
      ['./', 'string ./'],
      ['./dist/*.js', 'string ./dist/*.js'],
      ['./dist\\policy.js', 'string ./dist\\policy.js'],
      ['./node_modules/x/policy.js', 'string ./node_modules/x/policy.js'],
      [{ './dist': './dist/policy.js' }, 'condition key ./dist'],
      [{ 0: './dist/policy.js' }, 'condition key 0'],
    ]
    for (const [target, form] of cases) {
      withFixture(
        (state) => {
          state.exports['./policy'] = target
        },
        (problems) =>
          assert.deepEqual(problems, [
            unsupported('@lf/engine', './policy', form),
          ]),
      )
    }
    withFixture(
      (state) => {
        state.exports['./node'] = null
        state.unaliasedSubpaths = {}
      },
      (problems) =>
        assert.deepEqual(problems, [
          unsupported('@lf/engine', './node', 'null'),
        ]),
    )
    withFixture(
      (state) => {
        state.aliases = state.aliases.filter(
          (alias) => alias.find !== '@lf/engine/policy',
        )
        delete state.paths['@lf/engine/policy']
        state.exports = [null, './dist/index.js']
        state.unaliasedSubpaths = {}
      },
      (problems) =>
        assert.deepEqual(problems, [unsupported('@lf/engine', '.', 'array')]),
    )
  })

  it('refuses export subpath keys it does not support', () => {
    for (const subpath of ['./*', './lib/']) {
      withFixture(
        (state) => {
          state.exports[subpath] = './dist/policy.js'
        },
        (problems) =>
          assert.deepEqual(problems, [
            unsupported('@lf/engine', subpath, 'subpath pattern or folder'),
          ]),
      )
    }
    withFixture(
      (state) => {
        state.exports.import = './dist/index.js'
      },
      (problems) =>
        assert.deepEqual(problems, [
          unsupported('@lf/engine', '.', 'subpath and condition keys mixed'),
          '@lf/engine/policy: @lf/engine does not export ./policy',
          '@lf/engine: lists unaliased subpath ./node that it does not export',
        ]),
    )
  })

  it('refuses a package manifest without exports', () => {
    withFixture(
      (state) => {
        state.manifests.cli = { name: '@lf/cli' }
      },
      (problems) =>
        assert.deepEqual(problems, [unsupported('@lf/cli', '.', 'no exports')]),
    )
  })

  it('refuses an exported subpath that has no alias', () => {
    withFixture(
      (state) => {
        state.unaliasedSubpaths = {}
      },
      (problems) =>
        assert.deepEqual(problems, [
          '@lf/engine: export ./node has no app alias',
        ]),
    )
  })

  it('refuses a subpath alias that its package root shadows', () => {
    withFixture(
      (state) => {
        state.aliases.reverse()
      },
      (problems) =>
        assert.deepEqual(problems, [
          '@lf/engine/policy: shadowed by the earlier @lf/engine alias',
        ]),
    )
  })

  it('refuses a missing target and a target outside the package source', () => {
    withFixture(
      (state) => {
        state.aliases[2].path = 'packages/engine/src/missing.ts'
        state.aliases[3].path = 'packages/engine/dist/index.js'
        state.paths['@lf/engine/policy'] = ['./packages/engine/src/missing.ts']
        state.paths['@lf/engine'] = ['./packages/engine/dist/index.js']
      },
      (problems) =>
        assert.deepEqual(problems, [
          '@lf/engine/policy: target packages/engine/src/missing.ts does not exist',
          '@lf/engine: target packages/engine/dist/index.js is not @lf/engine source',
        ]),
    )
  })

  it('refuses tsconfig paths that drift from the aliases', () => {
    withFixture(
      (state) => {
        delete state.paths['@pkg']
        state.paths['@lf/engine'] = ['./packages/engine/dist/index.js']
        state.paths['@lf/engine/testing'] = ['./packages/engine/src/testing.ts']
      },
      (problems) =>
        assert.deepEqual(problems, [
          'tsconfig.json: paths is missing @pkg',
          'tsconfig.json: paths @lf/engine is ["./packages/engine/dist/index.js"], expected ["./packages/engine/src/index.ts"]',
          'tsconfig.json: paths @lf/engine/testing has no app alias',
        ]),
    )
  })

  it('refuses tsconfig paths named like object prototype members', () => {
    withFixture(
      (state) => {
        state.paths.constructor = ['./src/main.ts']
        state.paths.toString = ['./src/main.ts']
        Object.defineProperty(state.paths, '__proto__', {
          value: ['./src/main.ts'],
          enumerable: true,
        })
      },
      (problems) =>
        assert.deepEqual(problems, [
          'tsconfig.json: paths constructor has no app alias',
          'tsconfig.json: paths toString has no app alias',
          'tsconfig.json: paths __proto__ has no app alias',
        ]),
    )
  })

  it('accepts a baseUrl at the repository root', () => {
    for (const baseUrl of ['.', './']) {
      withFixture(
        (state) => {
          state.compilerOptions.baseUrl = baseUrl
        },
        (problems) => assert.deepEqual(problems, []),
      )
    }
  })

  it('refuses a baseUrl that moves unchanged paths off the root', () => {
    withFixture(
      (state) => {
        state.compilerOptions.baseUrl = './src'
        state.compilerOptions.ignoreDeprecations = '6.0'
      },
      (problems) =>
        assert.deepEqual(problems, [
          'tsconfig.json: baseUrl "./src" moves paths off the repository root',
        ]),
    )
  })

  it('refuses a tsconfig that extends another config', () => {
    withFixture(
      (state) => {
        state.tsconfig.extends = './tsconfig.base.json'
      },
      (problems) =>
        assert.deepEqual(problems, [
          'tsconfig.json: extends is not supported; paths must be declared and resolved in tsconfig.json',
        ]),
    )
  })

  it('refuses an alias listed twice', () => {
    withFixture(
      (state) => {
        state.aliases.push({ ...state.aliases[1] })
      },
      (problems) => assert.deepEqual(problems, ['@pkg: aliased twice']),
    )
  })

  it('refuses aliases left behind by a package rename', () => {
    withFixture(
      (state) => {
        state.name = '@lf/engine-renamed'
      },
      (problems) =>
        assert.deepEqual(problems, [
          '@lf/engine/policy: names no workspace package and is not a local alias',
          '@lf/engine: names no workspace package and is not a local alias',
          '@lf/engine-renamed: workspace package has no app alias and is not listed as unaliased',
          '@lf/engine: lists unaliased subpaths but is not an aliased workspace package',
        ]),
    )
  })

  it('refuses a package alias that names no workspace package', () => {
    withFixture(
      (state) => {
        state.aliases.push({ find: '@app/util', path: 'src/main.ts' })
        state.paths['@app/util'] = ['./src/main.ts']
      },
      (problems) =>
        assert.deepEqual(problems, [
          '@app/util: names no workspace package and is not a local alias',
        ]),
    )
  })

  it('refuses a package directory without a readable, named manifest', () => {
    withFixture(
      (state) => {
        state.manifests.cli = null
      },
      (problems) =>
        assert.deepEqual(withoutErrorDetail(problems), [
          'packages/cli/package.json: unreadable (…)',
          '@lf/cli: listed as unaliased but names no workspace package',
        ]),
    )
    withFixture(
      (state) => {
        state.manifests.cli = '{"name":'
      },
      (problems) =>
        assert.deepEqual(withoutErrorDetail(problems), [
          'packages/cli/package.json: unreadable (…)',
          '@lf/cli: listed as unaliased but names no workspace package',
        ]),
    )
    for (const manifest of [{ exports: './dist/index.js' }, { name: 1 }, []]) {
      withFixture(
        (state) => {
          state.manifests.cli = manifest
        },
        (problems) =>
          assert.deepEqual(problems, [
            'packages/cli/package.json: name is not a non-empty string',
            '@lf/cli: listed as unaliased but names no workspace package',
          ]),
      )
    }
  })

  it('refuses a manifest name that is not a package name', () => {
    for (const name of ['@lf', '@lf/cli/extra', 'Lf-Cli', '../cli']) {
      withFixture(
        (state) => {
          state.manifests.cli = { name, exports: './dist/index.js' }
        },
        (problems) =>
          assert.deepEqual(problems, [
            `packages/cli/package.json: name ${name} is not a package name`,
            '@lf/cli: listed as unaliased but names no workspace package',
          ]),
      )
    }
  })

  it('refuses two manifests that declare one package name', () => {
    withFixture(
      (state) => {
        state.manifests.zcopy = { name: '@lf/engine', exports: './x.js' }
      },
      (problems) =>
        assert.deepEqual(problems, [
          '@lf/engine: declared by both packages/engine and packages/zcopy',
        ]),
    )
  })

  it('refuses a stray file among the workspace packages', () => {
    withFixture(
      (state) => {
        state.files['packages/README.md'] = ''
      },
      (problems) =>
        assert.deepEqual(problems, [
          'packages/README.md: not a package directory',
        ]),
    )
  })

  it('ignores dot entries, which the packages/* workspace glob skips', () => {
    withFixture(
      (state) => {
        state.files['packages/.DS_Store'] = ''
        state.files['packages/.cache/package.json'] = '{'
      },
      (problems) => assert.deepEqual(problems, []),
    )
  })

  it('refuses a repository without a readable packages directory', () => {
    const root = mkdtempSync(join(tmpdir(), 'lf-app-aliases-'))
    try {
      write(root, 'tsconfig.json', '{"compilerOptions":{"paths":{}}}')
      assert.deepEqual(
        withoutErrorDetail(
          checkAppAliases({
            rootDir: root,
            aliases: [],
            localAliases: [],
            unaliasedPackages: [],
            unaliasedSubpaths: {},
          }),
        ),
        ['packages: unreadable (…)'],
      )
    } finally {
      rmSync(root, { force: true, recursive: true })
    }
  })

  it('exempts only listed packages that exist and carry no alias', () => {
    withFixture(
      (state) => {
        state.unaliasedPackages = []
      },
      (problems) =>
        assert.deepEqual(problems, [
          '@lf/cli: workspace package has no app alias and is not listed as unaliased',
        ]),
    )
    withFixture(
      (state) => {
        state.unaliasedPackages.push('@lf/gone')
      },
      (problems) =>
        assert.deepEqual(problems, [
          '@lf/gone: listed as unaliased but names no workspace package',
        ]),
    )
    withFixture(
      (state) => {
        state.unaliasedPackages.push('@lf/engine')
      },
      (problems) =>
        assert.deepEqual(problems, [
          '@lf/engine: aliased but listed as an unaliased package',
        ]),
    )
  })

  it('exempts only listed unaliased subpaths the package exports', () => {
    const cases = [
      [
        { '@lf/engine': ['./node', './gone'] },
        ['@lf/engine: lists unaliased subpath ./gone that it does not export'],
      ],
      [
        { '@lf/engine': ['./node', './policy'] },
        ['@lf/engine: lists unaliased subpath ./policy that has an alias'],
      ],
      [
        { '@lf/engine': ['./node'], '@lf/cli': ['.'] },
        [
          '@lf/cli: lists unaliased subpaths but is not an aliased workspace package',
        ],
      ],
      [
        { '@lf/engine': './node' },
        [
          '@lf/engine: unaliased subpaths are not a list of strings (not an array)',
          '@lf/engine: export ./node has no app alias',
        ],
      ],
      [
        [],
        [
          'unaliasedSubpaths: not an object',
          '@lf/engine: export ./node has no app alias',
        ],
      ],
    ]
    for (const [unaliasedSubpaths, expected] of cases) {
      withFixture(
        (state) => {
          state.unaliasedSubpaths = unaliasedSubpaths
        },
        (problems) => assert.deepEqual(problems, expected),
      )
    }
  })

  it('keeps local aliases off the workspace packages', () => {
    withFixture(
      (state) => {
        state.localAliases.push('@app')
      },
      (problems) =>
        assert.deepEqual(problems, [
          '@app: listed as a local alias but not aliased',
        ]),
    )
    withFixture(
      (state) => {
        state.aliases[0].path = 'packages/engine/src'
        state.paths['~/*'] = ['./packages/engine/src/*']
      },
      (problems) =>
        assert.deepEqual(problems, [
          '~: local alias targets packages/engine/src inside the workspace packages',
        ]),
    )
    withFixture(
      (state) => {
        state.localAliases.push('@lf/engine')
      },
      (problems) =>
        assert.deepEqual(problems, [
          '@lf/engine: local alias names workspace package @lf/engine',
          '@lf/engine: local alias targets packages/engine/src/index.ts inside the workspace packages',
          '@lf/engine: export . has no app alias',
        ]),
    )
  })

  it('refuses alias entries outside the form the configs consume', () => {
    const inherited = Object.create({ find: '@x', path: 'src' })
    const cases = [
      ['src', 'is not an object'],
      [{ find: '@x' }, 'has no own path'],
      [inherited, 'has a custom prototype (inherited keys: find, path)'],
      [{ find: '@x', path: 1 }, 'path is not a non-empty string'],
      [{ find: /^@x/, path: 'src' }, 'find is not a non-empty string'],
      [{ find: '', path: 'src' }, 'find is not a non-empty string'],
      [
        { find: '@x', path: 'src', customResolver: 1 },
        'has unknown key customResolver',
      ],
      [{ find: '@x/', path: 'src' }, 'find @x/ is not a bare specifier prefix'],
      [
        { find: '@x/*', path: 'src' },
        'find @x/* is not a bare specifier prefix',
      ],
    ]
    for (const path of ['./src', '../src', '/src', 'src/', '.']) {
      cases.push([
        { find: '@x', path },
        `path ${path} is not a normalized path inside the repository`,
      ])
    }
    for (const [alias, reason] of cases) {
      withFixture(
        (state) => {
          state.aliases.push(alias)
        },
        (problems) => assert.deepEqual(problems, [`alias 4: ${reason}`]),
      )
    }
  })

  it('refuses exemption lists that are not lists', () => {
    withFixture(
      (state) => {
        state.localAliases = '~'
      },
      (problems) =>
        assert.deepEqual(problems, [
          'localAliases: not a list of strings (not an array)',
          '~: names no workspace package and is not a local alias',
          '@pkg: names no workspace package and is not a local alias',
        ]),
    )
    withFixture(
      (state) => {
        state.unaliasedPackages = '@lf/cli'
      },
      (problems) =>
        assert.deepEqual(problems, [
          'unaliasedPackages: not a list of strings (not an array)',
          '@lf/cli: workspace package has no app alias and is not listed as unaliased',
        ]),
    )
    withFixture(
      (state) => {
        state.aliases = { 0: state.aliases[0] }
        state.paths = {}
      },
      (problems) =>
        assert.deepEqual(problems, [
          'aliases: not an array',
          '~: listed as a local alias but not aliased',
          '@pkg: listed as a local alias but not aliased',
          '@lf/engine: workspace package has no app alias and is not listed as unaliased',
          '@lf/engine: lists unaliased subpaths but is not an aliased workspace package',
        ]),
    )
  })

  it('refuses tsconfig shapes it does not understand', () => {
    const cases = [
      ['{', ['tsconfig.json: unreadable (…)', ...MISSING_ALL_PATHS]],
      ['[]', ['tsconfig.json: unreadable (…)', ...MISSING_ALL_PATHS]],
      [
        '{"compilerOptions":null}',
        ['tsconfig.json: unreadable (…)', ...MISSING_ALL_PATHS],
      ],
      [
        '{"compilerOptions":{"paths":null}}',
        ['tsconfig.json: paths is not an object', ...MISSING_ALL_PATHS],
      ],
      [
        '{"compilerOptions":{"paths":[]}}',
        ['tsconfig.json: paths is not an object', ...MISSING_ALL_PATHS],
      ],
      ['{"compilerOptions":{}}', MISSING_ALL_PATHS],
    ]
    for (const [tsconfigText, expected] of cases) {
      withFixture(
        (state) => {
          state.tsconfigText = tsconfigText
        },
        (problems) => assert.deepEqual(withoutErrorDetail(problems), expected),
      )
    }
  })

  it('refuses unaliased subpath entries it would not enumerate', () => {
    const ghost = Object.assign(
      Object.create({ '@app/ghost': ['./node'] }),
      structuredClone({ '@lf/engine': ['./node'] }),
    )
    const hidden = Object.defineProperty({}, '@lf/engine', {
      value: ['./node'],
      enumerable: false,
    })
    const accessor = {
      get '@lf/engine'() {
        return ['./node']
      },
    }
    const symbol = { '@lf/engine': ['./node'], [Symbol('x')]: ['./node'] }
    const cases = [
      [ghost, 'has a custom prototype (inherited keys: @app/ghost)'],
      [Object.create(Object.create(null)), 'has a custom prototype'],
      [hidden, 'has non-enumerable key @lf/engine'],
      [accessor, 'has accessor key @lf/engine'],
      [symbol, 'has symbol key Symbol(x)'],
    ]
    for (const [unaliasedSubpaths, shape] of cases) {
      withFixture(
        (state) => {
          state.unaliasedSubpaths = unaliasedSubpaths
        },
        (problems) =>
          assert.deepEqual(problems, [
            `unaliasedSubpaths: ${shape}`,
            '@lf/engine: export ./node has no app alias',
          ]),
      )
    }
    withFixture(
      (state) => {
        state.unaliasedSubpaths = Object.assign(Object.create(null), {
          '@lf/engine': ['./node'],
        })
      },
      (problems) => assert.deepEqual(problems, []),
    )
  })

  it('refuses lists with entries a reader could see differently', () => {
    const extra = Object.assign(['./node'], { more: './policy' })
    const custom = Object.setPrototypeOf(['./node'], [])
    const hiddenIndex = Object.defineProperty([], 0, {
      value: './node',
      enumerable: false,
    })
    const cases = [
      [withHole(['./node', '', './policy'], 1), 'has a hole at 1'],
      [extra, 'has non-index key more'],
      [custom, 'has a custom prototype'],
      [hiddenIndex, 'has non-enumerable key 0'],
      [['./node', 1], 'entry 1 is not a string'],
    ]
    for (const [subpaths, shape] of cases) {
      withFixture(
        (state) => {
          state.unaliasedSubpaths = { '@lf/engine': subpaths }
        },
        (problems) =>
          assert.deepEqual(problems, [
            `@lf/engine: unaliased subpaths are not a list of strings (${shape})`,
            '@lf/engine: export ./node has no app alias',
          ]),
      )
    }
    withFixture(
      (state) => {
        state.localAliases = withHole(['~', '', '@pkg'], 1)
      },
      (problems) =>
        assert.deepEqual(problems, [
          'localAliases: not a list of strings (has a hole at 1)',
          '~: names no workspace package and is not a local alias',
          '@pkg: names no workspace package and is not a local alias',
        ]),
    )
    withFixture(
      (state) => {
        state.unaliasedPackages = Object.assign(['@lf/cli'], { x: '@lf/x' })
      },
      (problems) =>
        assert.deepEqual(problems, [
          'unaliasedPackages: not a list of strings (has non-index key x)',
          '@lf/cli: workspace package has no app alias and is not listed as unaliased',
        ]),
    )
    withFixture(
      (state) => {
        state.aliases.splice(1, 1)
        state.aliases.length += 1
        delete state.paths['@pkg']
      },
      (problems) =>
        assert.deepEqual(problems, [
          'aliases: has a hole at 3',
          '~: listed as a local alias but not aliased',
          '@pkg: listed as a local alias but not aliased',
          '@lf/engine: workspace package has no app alias and is not listed as unaliased',
          '@lf/engine: lists unaliased subpaths but is not an aliased workspace package',
          'tsconfig.json: paths ~/* has no app alias',
          'tsconfig.json: paths @lf/engine/policy has no app alias',
          'tsconfig.json: paths @lf/engine has no app alias',
        ]),
    )
  })

  it('refuses alias entries with hidden or inherited keys', () => {
    const cases = [
      [
        Object.defineProperty({ find: '@x', path: 'src' }, 'customResolver', {
          value: 1,
          enumerable: false,
        }),
        'has non-enumerable key customResolver',
      ],
      [
        {
          get find() {
            return '@x'
          },
          path: 'src',
        },
        'has accessor key find',
      ],
      [
        { find: '@x', path: 'src', [Symbol('x')]: 1 },
        'has symbol key Symbol(x)',
      ],
      [
        Object.assign(Object.create({ customResolver: 1 }), {
          find: '@x',
          path: 'src',
        }),
        'has a custom prototype (inherited keys: customResolver)',
      ],
    ]
    for (const [alias, reason] of cases) {
      withFixture(
        (state) => {
          state.aliases.push(alias)
        },
        (problems) => assert.deepEqual(problems, [`alias 4: ${reason}`]),
      )
    }
  })

  it('refuses options it does not know or would not read', () => {
    assert.deepEqual(checkAppAliases({ unaliasedSubpath: {} }), [
      'options: has unknown key unaliasedSubpath',
    ])
    assert.deepEqual(
      checkAppAliases(Object.create({ unaliasedSubpaths: {} })),
      ['options: has a custom prototype (inherited keys: unaliasedSubpaths)'],
    )
    assert.deepEqual(checkAppAliases({ rootDir: 1 }), [
      'rootDir: not a non-empty string',
    ])
  })
})
