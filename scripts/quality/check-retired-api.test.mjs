// @vitest-environment node
import assert from 'node:assert/strict'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import {
  checkLists,
  checkPublicSurface,
  checkSupportedReaders,
  mayNameRetired,
  RETIRED_EXPORTS,
  RETIRED_IDENTIFIERS,
  runRetiredApiCheck,
  scanSources,
  SUPPORTED_DEVICE_DATA_READERS,
} from './check-retired-api.mjs'

// Runs under `node --test` and under the Vitest app gate.
const { after, describe, it } = process.env.VITEST
  ? await import('vitest').then(({ afterAll, ...rest }) => ({
      ...rest,
      after: afterAll,
    }))
  : await import('node:test')

const repoRoot = fileURLToPath(new URL('../../', import.meta.url))

function scan(files) {
  return scanSources({
    files: Object.keys(files),
    readFile: (path) => files[path],
  })
}

describe('retirement lists', () => {
  it('are well-formed and keep supported readers off them', () => {
    assert.deepEqual(checkLists(), [])
  })

  it('never ban a plain word', () => {
    assert.deepEqual(checkLists({ identifiers: ['legacy', 'Optional'] }), [
      'retired identifier legacy is a plain word; retire it from a package surface instead',
      'retired identifier Optional is a plain word; retire it from a package surface instead',
    ])
  })

  it('refuse a name that is not an identifier', () => {
    assert.deepEqual(
      checkLists({
        retiredExports: { '@x/a': ['a-b'] },
        retiredMembers: {},
        identifiers: [],
        readers: [],
      }),
      ['retired name "a-b" is not an identifier'],
    )
  })

  it('refuse retiring a reader of data on users devices', () => {
    const problems = checkLists({
      identifiers: [...RETIRED_IDENTIFIERS, 'LEGACY_DEFAULT_LUT_SOURCE_URLS'],
    })
    assert.equal(problems.length, 1)
    assert.match(
      problems[0],
      /^LEGACY_DEFAULT_LUT_SOURCE_URLS reads .* cannot also be retired$/,
    )
  })

  it('ban every distinctive retired export anywhere outside tests', () => {
    const exported = new Set(Object.values(RETIRED_EXPORTS).flat())
    for (const name of RETIRED_IDENTIFIERS) {
      if (name === '__TEST_ONLY__') continue
      assert.ok(exported.has(name), `${name} is not a retired export`)
    }
  })
})

describe('source scan', () => {
  it('fails a retired identifier in code or documents', () => {
    assert.deepEqual(
      scan({
        'src/lib/a.ts': "import { RenderBudget } from 'x'\n",
        'packages/x/src/b.mjs':
          'const ok = 1\nexport const __TEST_ONLY__ = {}\n',
        'docs/guide.md': 'Call `analyzeRawDynamicRange` first.\n',
      }),
      [
        'src/lib/a.ts:1 names retired RenderBudget',
        'packages/x/src/b.mjs:2 names retired __TEST_ONLY__',
        'docs/guide.md:1 names retired analyzeRawDynamicRange',
      ],
    )
  })

  it('fails a @deprecated tag in code but not in a document', () => {
    assert.deepEqual(
      scan({
        'packages/x/src/a.ts': '/** @deprecated use b */\nexport const a = 1\n',
        'AGENTS.md': 'Do not add `@deprecated` forwarding exports.\n',
      }),
      ['packages/x/src/a.ts:1 declares @deprecated; remove the export instead'],
    )
  })

  it('lets negative tests and CHANGELOGs name retired APIs', () => {
    const text =
      '/** @deprecated */\nexpect(entry).not.toHaveProperty("createNodeJpegRowSink")\n'
    assert.deepEqual(
      scan({
        'packages/x/src/a.test.ts': text,
        'tests/browser/raw.spec.ts': text,
        'src/__tests__/shell.tsx': text,
        'packages/x/CHANGELOG.md': '- Removed `sourceContentIdFromFile`.\n',
      }),
      [],
    )
    assert.equal(mayNameRetired('scripts/quality/check-retired-api.mjs'), true)
    assert.equal(mayNameRetired('src/lib/test-utils.ts'), false)
  })

  it('never fails generic words or a longer identifier', () => {
    assert.deepEqual(
      scan({
        'src/a.ts': [
          'const LEGACY_DEFAULT_LUT_SOURCE_URLS = []',
          'type Optional<T> = T | undefined // legacy, compat, optional',
          'const RenderBudgetLimit = 1',
          'const myRenderBudget = 2',
          'type OutputSink = { legacy: true }',
        ].join('\n'),
      }),
      [],
    )
  })

  it('reads only code and Markdown', () => {
    assert.deepEqual(
      scan({
        'pnpm-lock.yaml': 'RenderBudget: 1\n',
        'src/styles/app.css': '/* RenderBudget */\n',
      }),
      [],
    )
  })
})

describe('supported device-data readers', () => {
  const files = {
    'src/lib/export/output-sink.ts':
      "export const OPFS_EXPORTS_DIRECTORY = '.x'\nexport const OPFS_ACTIVE_DIRECTORY = 'active'\n",
  }
  const readers = [SUPPORTED_DEVICE_DATA_READERS[0]]
  const check = (fixture) =>
    checkSupportedReaders({
      files: Object.keys(fixture),
      readFile: (path) => fixture[path],
      readers,
    })

  it('accepts readers that are in place', () => {
    assert.deepEqual(check(files), [])
  })

  it('fails a reader that was removed', () => {
    assert.deepEqual(check({}), [
      'src/lib/export/output-sink.ts is gone, but it reads OPFS export outputs under .lumaforge-exports/active',
    ])
    assert.deepEqual(
      check({
        'src/lib/export/output-sink.ts':
          "export const OPFS_EXPORTS_DIRECTORY = '.x'\n",
      }),
      [
        'src/lib/export/output-sink.ts no longer has OPFS_ACTIVE_DIRECTORY, which reads OPFS export outputs under .lumaforge-exports/active',
      ],
    )
  })
})

describe('public surface', () => {
  const roots = []
  after(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true })
  })

  /** Writes a two-package fixture and returns its root and file list. */
  function fixture(overrides = {}) {
    const root = mkdtempSync(join(tmpdir(), 'lf-retired-api-'))
    roots.push(root)
    const files = {
      'packages/engine/package.json': JSON.stringify({
        name: '@x/engine',
        exports: {
          '.': { types: './dist/index.d.ts', import: './dist/index.js' },
          './policy': {
            types: './dist/policy/index.d.ts',
            import: './dist/policy/index.js',
          },
        },
      }),
      'packages/engine/tsconfig.json': JSON.stringify({
        compilerOptions: { rootDir: 'src', outDir: 'dist' },
      }),
      'packages/engine/src/index.ts':
        "export * from './types'\nexport * from '@x/color'\n",
      'packages/engine/src/types.ts':
        'export interface Params { tone: number }\nexport type Kept = 1\n',
      'packages/engine/src/policy/index.ts': 'export const derive = 1\n',
      'packages/color/package.json': JSON.stringify({
        name: '@x/color',
        exports: { '.': { types: './dist/index.d.ts' } },
      }),
      'packages/color/tsconfig.json': JSON.stringify({
        compilerOptions: { rootDir: 'src', outDir: 'dist' },
      }),
      'packages/color/src/index.ts': 'export type Intent = { tone: number }\n',
      ...overrides,
    }
    for (const [path, text] of Object.entries(files)) {
      if (text === undefined) continue
      mkdirSync(dirname(join(root, path)), { recursive: true })
      writeFileSync(join(root, path), text)
    }
    const listed = Object.keys(files).filter(
      (path) => files[path] !== undefined,
    )
    return {
      root,
      files: listed,
      readFile: (path) => readFileSync(join(root, path), 'utf8'),
    }
  }

  const surface = (repo, options = {}) =>
    checkPublicSurface({
      ...repo,
      retiredExports: { '@x/engine': ['Gone', 'oldHelper'] },
      retiredMembers: {
        '@x/engine': { Params: ['viewMode'], Intent: ['legacyTone'] },
      },
      ...options,
    })

  it('accepts entries without retired names or members', async () => {
    assert.deepEqual(await surface(fixture()), [])
  })

  it('fails a retired export, also through a re-export chain', async () => {
    assert.deepEqual(
      await surface(
        fixture({
          'packages/engine/src/types.ts':
            'export interface Params { tone: number }\nexport type Gone = 1\n',
          'packages/engine/src/policy/index.ts':
            "export const derive = 1\nexport { Gone as oldHelper } from '../types'\n",
        }),
      ),
      [
        '@x/engine (types, import) exports retired Gone',
        '@x/engine/policy (types, import) exports retired oldHelper',
      ],
    )
  })

  it('fails a retired member, also on a type from another package', async () => {
    assert.deepEqual(
      await surface(
        fixture({
          'packages/engine/src/types.ts':
            'export interface Params { tone: number; viewMode?: string }\n',
          'packages/color/src/index.ts':
            'export type Intent = { tone: number; legacyTone: number }\n',
        }),
      ),
      [
        '@x/engine (types, import) Params has retired member viewMode',
        '@x/engine (types, import) Intent has retired member legacyTone',
      ],
    )
  })

  it('fails a retired member that only one union branch carries', async () => {
    assert.deepEqual(
      await surface(
        fixture({
          'packages/engine/src/types.ts':
            'type Base = { tone: number }\n' +
            'type Old = { tone: number } & ({ exposure: number } | { viewMode: string })\n' +
            'export type Params = Base | (Base & Old)\n',
        }),
      ),
      ['@x/engine (types, import) Params has retired member viewMode'],
    )
  })

  it('fails closed on a type whose members it cannot enumerate', async () => {
    const unenumerable = (types) =>
      surface(fixture({ 'packages/engine/src/types.ts': types }))
    const expected = [
      '@x/engine (types, import) Params cannot be enumerated (generic or conditional type)',
    ]
    // Params<false> accepts the retired member the default instance lacks.
    assert.deepEqual(
      await unenumerable(
        'export type Params<T = true> = T extends true\n' +
          '  ? { readonly tone: number }\n' +
          '  : { readonly tone: number; readonly viewMode: string }\n',
      ),
      expected,
    )
    assert.deepEqual(
      await unenumerable(
        'export interface Params<T = unknown> { tone: number; extra: T }\n',
      ),
      expected,
    )
    assert.deepEqual(
      await unenumerable('export type Params = { tone: number } & string\n'),
      expected,
    )
  })

  it('fails closed when a listed type or package is gone', async () => {
    assert.deepEqual(
      await surface(
        fixture({
          'packages/engine/src/types.ts': 'export type Kept = 1\n',
        }),
        {
          retiredExports: { '@x/engine': ['Gone'], '@x/renamed': ['Gone'] },
        },
      ),
      [
        '@x/renamed names no workspace package',
        '@x/engine exports no Params; update its retired members',
      ],
    )
  })

  it('fails closed on a re-export that does not resolve', async () => {
    assert.deepEqual(
      await surface(
        fixture({
          'packages/engine/src/policy/index.ts':
            "export const derive = 1\nexport * from './missing'\n",
        }),
      ),
      [
        'packages/engine/src/policy/index.ts re-exports ./missing, which does not resolve',
      ],
    )
  })

  /** The engine manifest with its root export replaced. */
  const engineRoot = (rootExport) =>
    JSON.stringify({
      name: '@x/engine',
      exports: {
        '.': rootExport,
        './policy': {
          types: './dist/policy/index.d.ts',
          import: './dist/policy/index.js',
        },
      },
    })

  it('reads every condition, not only the first that resolves', async () => {
    const gone = { 'packages/engine/src/node.ts': 'export type Gone = 1\n' }
    const root = { types: './dist/index.d.ts', import: './dist/index.js' }
    assert.deepEqual(
      await surface(
        fixture({
          ...gone,
          'packages/engine/package.json': engineRoot({
            ...root,
            node: './dist/node.js',
          }),
        }),
      ),
      ['@x/engine (node) exports retired Gone'],
    )
    assert.deepEqual(
      await surface(
        fixture({
          ...gone,
          'packages/engine/package.json': engineRoot({
            ...root,
            worker: { import: './dist/node.js' },
          }),
        }),
      ),
      ['@x/engine (worker.import) exports retired Gone'],
    )
  })

  it('fails closed on a condition without a source', async () => {
    assert.deepEqual(
      await surface(
        fixture({
          'packages/engine/package.json': engineRoot({
            types: './dist/index.d.ts',
            import: './dist/index.js',
            node: './dist/missing.js',
          }),
        }),
      ),
      ['@x/engine node has no source file'],
    )
  })

  it('reads a re-exported package through each file its conditions lead to', async () => {
    const forked = {
      types: './dist/index.d.ts',
      node: './dist/node.js',
      import: './dist/index.js',
    }
    const repo = (nodeExport) =>
      fixture({
        'packages/engine/package.json': engineRoot(forked),
        'packages/engine/src/node.ts': nodeExport,
        'packages/color/package.json': JSON.stringify({
          name: '@x/color',
          exports: { '.': forked },
        }),
        'packages/color/src/node.ts':
          'export type Intent = { tone: number }\nexport const Gone = 1\n',
      })
    const throughColorNode = '(with @x/color at packages/color/src/node.ts)'
    // Whichever condition a consumer resolves the engine with, the color
    // runtime it re-exports can resolve to its node file.
    assert.deepEqual(await surface(repo("export * from '@x/color'\n")), [
      `@x/engine (types, import) exports retired Gone ${throughColorNode}`,
      `@x/engine (node) exports retired Gone ${throughColorNode}`,
    ])
    assert.deepEqual(
      await surface(repo("export * from '../../color/src/node'\n")),
      [
        '@x/engine (node) exports retired Gone',
        `@x/engine (types, import) exports retired Gone ${throughColorNode}`,
      ],
    )
  })

  it('fails closed on an unmapped entry of a package it does not check', async () => {
    assert.deepEqual(
      await surface(
        fixture({
          'packages/color/package.json': JSON.stringify({
            name: '@x/color',
            exports: { '.': { types: './dist/index.d.ts', node: './gone.js' } },
          }),
        }),
      ),
      ['@x/color node has no source file'],
    )
  })

  it('fails closed when forked specifiers have too many combinations', async () => {
    const subpaths = ['a', 'b', 'c', 'd', 'e']
    const many = {
      'packages/many/package.json': JSON.stringify({
        name: '@x/many',
        exports: Object.fromEntries(
          subpaths.map((name) => [
            `./${name}`,
            { types: `./types/${name}.ts`, import: `./lib/${name}.ts` },
          ]),
        ),
      }),
    }
    for (const name of subpaths) {
      many[`packages/many/types/${name}.ts`] = 'export {}\n'
      many[`packages/many/lib/${name}.ts`] = 'export {}\n'
    }
    const specifiers = subpaths.map((name) => `@x/many/${name}`).join(', ')
    assert.deepEqual(await surface(fixture(many)), [
      `${specifiers} resolve to 32 combinations of sources; at most 16 are read`,
    ])
  })

  /** An engine `vite.config.ts` whose `build.lib.entry` holds `entry`. */
  const viteConfig = (entry, { before = [], outDir = "'dist'" } = {}) =>
    [
      "import { fileURLToPath } from 'node:url'",
      "import { defineConfig } from 'vite'",
      ...before,
      'export default defineConfig({',
      '  build: {',
      `    outDir: ${outDir},`,
      '    lib: {',
      '      entry: {',
      ...entry,
      '      },',
      '    },',
      "    rollupOptions: { output: { entryFileNames: '[name].js' } },",
      '  },',
      '})',
    ].join('\n')
  const entryLine = (name, path) =>
    `        ${name}: fileURLToPath(new URL('${path}', import.meta.url)),`
  const viteEngine = (entry, options) => ({
    'packages/engine/vite.config.ts': viteConfig(entry, options),
    'packages/engine/src/node.ts': 'export type Gone = 1\n',
    'packages/engine/package.json': engineRoot({
      types: './dist/index.d.ts',
      import: './dist/index.js',
      node: './dist/node.js',
    }),
  })
  const VITE_ENTRIES = [
    entryLine('index', './src/index.ts'),
    entryLine("'policy/index'", './src/policy/index.ts'),
    entryLine('node', './src/node.ts'),
  ]

  it('reads the Vite entry a commented-out line seems to replace', async () => {
    const expected = ['@x/engine (node) exports retired Gone']
    assert.deepEqual(await surface(fixture(viteEngine(VITE_ENTRIES))), expected)
    assert.deepEqual(
      await surface(
        fixture(
          viteEngine([
            ...VITE_ENTRIES,
            `        // ${entryLine('node', './src/index.ts').trim()}`,
          ]),
        ),
      ),
      expected,
    )
  })

  it('fails closed on a percent-encoded Vite entry path', async () => {
    assert.deepEqual(
      await surface(
        fixture({
          ...viteEngine([
            entryLine('index', './src/index.ts'),
            entryLine("'policy/index'", './src/policy/index.ts'),
            entryLine('node', './src/%6eode.ts'),
          ]),
          'packages/engine/src/%6eode.ts': 'export type Kept = 1\n',
        }),
      ),
      [
        '@x/engine has no source file: vite.config.ts build.lib.entry.node path "./src/%6eode.ts" is not a plain ./ path',
      ],
    )
  })

  it('fails closed on a percent-encoded export target', async () => {
    // Node reads ./dist/%6eode.js as dist/node.js, built from the node
    // entry, while the literal output is the %6eode entry.
    assert.deepEqual(
      await surface(
        fixture({
          ...viteEngine([
            ...VITE_ENTRIES,
            entryLine("'%6eode'", './src/clean.ts'),
          ]),
          'packages/engine/src/clean.ts': 'export type Kept = 1\n',
          'packages/engine/package.json': engineRoot({
            types: './dist/index.d.ts',
            node: './dist/%6eode.js',
            import: './dist/index.js',
          }),
        }),
      ),
      [
        '@x/engine has no source file: package.json exports . node has an unsupported export target form: "./dist/%6eode.js"',
      ],
    )
  })

  it('fails closed on a Vite configuration it cannot read', async () => {
    const problem = 'vite.config.ts build.lib.entry.node is declared twice'
    assert.deepEqual(
      await surface(
        fixture(
          viteEngine([...VITE_ENTRIES, entryLine("'node'", './src/index.ts')]),
        ),
      ),
      [`@x/engine has no source file: ${problem}`],
    )
  })

  it('maps no target of a package whose Vite configuration it cannot read', async () => {
    const unread = (rootExport) =>
      fixture({
        ...viteEngine(VITE_ENTRIES, {
          before: ["const outputDir = 'dist'"],
          outDir: 'outputDir',
        }),
        'packages/engine/package.json': JSON.stringify({
          name: '@x/engine',
          exports: { '.': rootExport },
        }),
      })
    const expected = [
      '@x/engine has no source file: vite.config.ts build.outDir is not a string literal',
    ]
    // Neither a declaration tsc maps back nor a target that is a source
    // stands in for the build the configuration does not describe.
    assert.deepEqual(
      await surface(unread({ types: './dist/index.d.ts' })),
      expected,
    )
    assert.deepEqual(
      await surface(
        unread({ types: './dist/index.d.ts', import: './src/index.ts' }),
      ),
      expected,
    )
  })

  it('fails closed on a published entry without a source', async () => {
    assert.deepEqual(
      await surface(
        fixture({ 'packages/engine/src/policy/index.ts': undefined }),
      ),
      [
        '@x/engine/policy types has no source file',
        '@x/engine/policy import has no source file',
      ],
    )
  })
})

describe('the committed repository', () => {
  it('uses no retired API', async () => {
    assert.deepEqual(await runRetiredApiCheck({ root: repoRoot }), [])
  })

  it('runs the check in the quality job after installing tools', () => {
    const workflow = readFileSync(
      `${repoRoot}.github/workflows/build.yml`,
      'utf8',
    ).replaceAll('\r\n', '\n')
    const quality = /^ {2}quality:\n((?: {4}.*\n|\n)*)/m.exec(workflow)?.[1]
    assert.ok(quality, 'the quality job is not defined')
    const test = quality.indexOf(
      'run: node --test scripts/quality/check-retired-api.test.mjs',
    )
    const install = quality.indexOf('run: pnpm install --frozen-lockfile')
    const run = quality.indexOf('run: pnpm check:retired-api')
    assert.ok(test > install && run > install, 'steps missing or out of order')

    const manifest = JSON.parse(readFileSync(`${repoRoot}package.json`, 'utf8'))
    assert.equal(
      manifest.scripts['check:retired-api'],
      'node scripts/quality/check-retired-api.mjs',
    )
  })
})
