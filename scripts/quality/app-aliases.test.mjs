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
    exports: {
      '.': './dist/index.js',
      './policy': './dist/policy.js',
      './node': './dist/node.js',
    },
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
      JSON.stringify({ name: '@lf/engine', exports: state.exports }),
    )
    write(
      root,
      'tsconfig.json',
      JSON.stringify({ compilerOptions: { paths: state.paths } }),
    )
    return run(
      checkAppAliases({
        rootDir: root,
        aliases: state.aliases,
        unaliasedSubpaths: state.unaliasedSubpaths,
      }),
      root,
    )
  } finally {
    rmSync(root, { force: true, recursive: true })
  }
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

  it('refuses an alias for a subpath the package blocks', () => {
    withFixture(
      (state) => {
        state.exports['./policy'] = null
      },
      (problems) =>
        assert.deepEqual(problems, [
          '@lf/engine/policy: @lf/engine does not export ./policy',
        ]),
    )
    withFixture(
      (state) => {
        state.exports['./policy'] = { types: null, import: [null] }
      },
      (problems) =>
        assert.deepEqual(problems, [
          '@lf/engine/policy: @lf/engine does not export ./policy',
        ]),
    )
  })

  it('accepts a subpath one condition still exports', () => {
    withFixture(
      (state) => {
        state.exports['./policy'] = { types: null, import: './dist/policy.js' }
      },
      (problems) => assert.deepEqual(problems, []),
    )
  })

  it('stops at the first matching condition of a root export', () => {
    const rootOnly = (exports) => (state) => {
      state.aliases = state.aliases.filter(
        (alias) => alias.find !== '@lf/engine/policy',
      )
      delete state.paths['@lf/engine/policy']
      state.exports = exports
      state.unaliasedSubpaths = {}
    }
    withFixture(
      rootOnly({ default: null, import: './dist/index.js' }),
      (problems) =>
        assert.deepEqual(problems, ['@lf/engine: @lf/engine does not export .']),
    )
    withFixture(
      rootOnly({ import: './dist/index.js', default: null }),
      (problems) => assert.deepEqual(problems, []),
    )
  })

  it('stops at the first matching condition of a subpath export', () => {
    withFixture(
      (state) => {
        state.exports['./policy'] = {
          default: { require: null },
          import: './dist/policy.js',
        }
      },
      (problems) => assert.deepEqual(problems, []),
    )
    withFixture(
      (state) => {
        state.exports['./policy'] = {
          default: { import: null },
          import: './dist/policy.js',
        }
      },
      (problems) =>
        assert.deepEqual(problems, [
          '@lf/engine/policy: @lf/engine does not export ./policy',
        ]),
    )
    withFixture(
      (state) => {
        state.exports['./policy'] = [null, './dist/policy.js']
      },
      (problems) =>
        assert.deepEqual(problems, [
          '@lf/engine/policy: @lf/engine does not export ./policy',
        ]),
    )
  })

  it('needs no alias for a blocked export subpath', () => {
    withFixture(
      (state) => {
        state.exports['./node'] = null
        state.unaliasedSubpaths = {}
      },
      (problems) => assert.deepEqual(problems, []),
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

  it('refuses an alias listed twice', () => {
    withFixture(
      (state) => {
        state.aliases.push({ ...state.aliases[1] })
      },
      (problems) => assert.deepEqual(problems, ['@pkg: aliased twice']),
    )
  })
})
