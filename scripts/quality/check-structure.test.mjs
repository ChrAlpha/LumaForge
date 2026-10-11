// @vitest-environment node
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import {
  canonicalCycle,
  checkKnipConfig,
  ConfigError,
  formatBaseline,
  KNIP_ISSUE_TYPES,
  listRepoFiles,
  loadTypeScript,
  madgeScope,
  normalizeCycles,
  normalizeKnipReport,
  parseBaseline,
  publishedEntries,
  readWorkspacePackages,
  runCheck,
  runKnip,
  runMadge,
  ToolError,
  viteLibraryOutputs,
} from './check-structure.mjs'
import { isMainModule } from './is-main-module.mjs'

// Runs under `node --test` and under the Vitest app gate.
const { describe, it } = process.env.VITEST
  ? await import('vitest')
  : await import('node:test')

const repoRoot = fileURLToPath(new URL('../../', import.meta.url))
const ROOT = '/repo'
const ts = await loadTypeScript()

/** One knip report entry that lists every issue type, as knip 6 does. */
function entry(file, issues = {}) {
  return {
    file,
    ...Object.fromEntries(
      KNIP_ISSUE_TYPES.map((type) => [type, issues[type] ?? []]),
    ),
  }
}

/** A small report with each issue shape, positions offset by `shift`. */
function report(shift = 0) {
  const at = (line) => ({ line: line + shift, col: 3, pos: 40 + shift * 30 })
  return {
    issues: [
      entry('src/legacy.ts', { files: [{ name: 'src/legacy.ts' }] }),
      entry('src/math.ts', {
        exports: [{ name: 'factorial', ...at(12) }],
        types: [{ name: 'Radians', ...at(20) }],
        enumMembers: [{ name: 'Up', namespace: 'Direction', ...at(3) }],
      }),
      entry('src/App.tsx', {
        duplicates: [
          [
            { name: 'default', ...at(9) },
            { name: 'App', ...at(3) },
          ],
        ],
      }),
      entry('package.json', { dependencies: [{ name: 'lodash', ...at(5) }] }),
      entry('scripts/suite.mjs', {
        unresolved: [{ name: '/src/lib/webgpu/pipeline.ts', ...at(2) }],
      }),
    ],
  }
}

const REPORT_IDENTITIES = [
  'dependencies package.json: lodash',
  'duplicates src/App.tsx: App, default',
  'enumMembers src/math.ts: Direction.Up',
  'exports src/math.ts: factorial',
  'files src/legacy.ts',
  'types src/math.ts: Radians',
  'unresolved scripts/suite.mjs: /src/lib/webgpu/pipeline.ts',
]

const VERSIONS = { knip: '6.39.0', madge: '8.0.0' }

function baseline(overrides = {}) {
  return {
    source: '07cd794e1696739b03216751fcb8d43292eea870',
    tools: { ...VERSIONS },
    knip: [],
    cycles: [],
    ...overrides,
  }
}

/** A baseline that still lists exceptions, as an older branch may carry. */
function listedBaseline() {
  return baseline({
    knip: ['exports src/a.ts: alpha', 'files src/c.ts'],
    cycles: ['src/x.ts > src/y.ts'],
  })
}

function check(
  current,
  { cycles = [], baseline: recorded = baseline(), ...rest } = {},
) {
  return runCheck({
    baseline: recorded,
    versions: VERSIONS,
    knip: () => current,
    madge: async () => ({ modules: 10, cycles }),
    ...rest,
  })
}

describe('knip report normalization', () => {
  it('names each finding by issue type, file, and symbol', () => {
    assert.deepEqual(
      normalizeKnipReport(report(), { root: ROOT }),
      REPORT_IDENTITIES,
    )
  })

  it('drops positions, so moved code keeps its identity', () => {
    assert.deepEqual(
      normalizeKnipReport(report(40), { root: ROOT }),
      normalizeKnipReport(report(), { root: ROOT }),
    )
  })

  it('makes absolute paths repository-relative', () => {
    const absolute = {
      issues: [
        entry(`${ROOT}/src/legacy.ts`, {
          files: [{ name: `${ROOT}/src/legacy.ts` }],
        }),
      ],
    }
    assert.deepEqual(normalizeKnipReport(absolute, { root: ROOT }), [
      'files src/legacy.ts',
    ])
  })

  it('treats an empty issues array as no findings', () => {
    assert.deepEqual(normalizeKnipReport({ issues: [] }, { root: ROOT }), [])
  })

  const malformed = {
    'no report': null,
    'no issues array': { files: [] },
    'issues that are not an array': { issues: {} },
    'an unknown top-level field': { issues: [], hints: [] },
    'an entry without a file': { issues: [{ ...entry('x'), file: '' }] },
    'an entry missing an issue type': {
      issues: [{ ...entry('src/a.ts'), exports: undefined }],
    },
    'an unknown issue type': {
      issues: [{ ...entry('src/a.ts'), cycles: [] }],
    },
    'an issue list that is not an array': {
      issues: [{ ...entry('src/a.ts'), exports: {} }],
    },
    'an issue without a name': {
      issues: [entry('src/a.ts', { exports: [{ line: 1 }] })],
    },
    'a duplicate with one member': {
      issues: [entry('src/a.ts', { duplicates: [[{ name: 'a' }]] })],
    },
    'a path outside the repository': {
      issues: [entry('../outside.ts', { exports: [{ name: 'a' }] })],
    },
    'an absolute path outside the repository': {
      issues: [entry('/elsewhere/a.ts', { exports: [{ name: 'a' }] })],
    },
  }
  for (const [label, value] of Object.entries(malformed)) {
    it(`rejects a report with ${label}`, () => {
      assert.throws(() => normalizeKnipReport(value, { root: ROOT }), ToolError)
    })
  }
})

describe('cycle identities', () => {
  it('starts every cycle at its smallest path', () => {
    const identity = 'src/a.ts > src/b.ts > src/c.ts'
    assert.equal(canonicalCycle(['src/b.ts', 'src/c.ts', 'src/a.ts']), identity)
    assert.equal(canonicalCycle(['src/c.ts', 'src/a.ts', 'src/b.ts']), identity)
    assert.equal(canonicalCycle(['src/a.ts', 'src/b.ts', 'src/c.ts']), identity)
  })

  it('keeps the import direction', () => {
    assert.equal(
      canonicalCycle(['src/a.ts', 'src/c.ts', 'src/b.ts']),
      'src/a.ts > src/c.ts > src/b.ts',
    )
  })

  it('sorts cycles and drops repeats', () => {
    assert.deepEqual(
      normalizeCycles(
        [
          ['src/y.ts', 'src/x.ts'],
          ['src/b.ts', 'src/a.ts'],
          ['src/x.ts', 'src/y.ts'],
        ],
        { root: ROOT },
      ),
      ['src/a.ts > src/b.ts', 'src/x.ts > src/y.ts'],
    )
  })

  it('rejects malformed cycles', () => {
    assert.throws(() => normalizeCycles({}), ToolError)
    assert.throws(() => normalizeCycles([[]]), ToolError)
    assert.throws(() => normalizeCycles([['src/a.ts', 'src/a.ts']]), ToolError)
    assert.throws(() => normalizeCycles([['../a.ts', 'src/b.ts']]), ToolError)
  })
})

describe('exception-free check', () => {
  it('passes only with no finding, no cycle, and an empty baseline', async () => {
    const result = await check([])
    assert.equal(result.ok, true)
    assert.deepEqual(result.errors, [])
    assert.deepEqual(result.output, [
      'knip 6.39.0: 0 findings',
      'madge 8.0.0: 10 modules, 0 cycles',
    ])
  })

  const mutations = {
    'an unused export': 'exports src/d.ts: delta',
    'an unused type': 'types src/d.ts: Delta',
    'an unused file': 'files src/d.ts',
    'an unused dependency': 'dependencies package.json: lodash',
    'an unresolved import': 'unresolved scripts/suite.mjs: ./gone.mjs',
  }
  for (const [label, identity] of Object.entries(mutations)) {
    it(`fails ${label}`, async () => {
      const result = await check([identity])
      assert.equal(result.ok, false)
      assert.deepEqual(result.errors, [
        `knip finding: ${identity}`,
        '1 structural finding. Remove the dead code or break the cycle; scripts/quality/baseline.json takes no exceptions.',
      ])
    })
  }

  it('fails a dependency cycle', async () => {
    const result = await check([], { cycles: ['src/a.ts > src/b.ts'] })
    assert.equal(result.ok, false)
    assert.equal(result.errors[0], 'dependency cycle: src/a.ts > src/b.ts')
  })

  it('fails a finding even when the baseline lists it', async () => {
    const result = await check(['exports src/a.ts: alpha'], {
      cycles: ['src/x.ts > src/y.ts'],
      baseline: listedBaseline(),
    })
    assert.equal(result.ok, false)
    assert.ok(result.errors.includes('knip finding: exports src/a.ts: alpha'))
    assert.ok(result.errors.includes('dependency cycle: src/x.ts > src/y.ts'))
  })

  it('fails a baseline that lists exceptions even when nothing is found', async () => {
    const result = await check([], { baseline: listedBaseline() })
    assert.equal(result.ok, false)
    assert.deepEqual(result.errors, [
      'baseline exception: exports src/a.ts: alpha',
      'baseline exception: files src/c.ts',
      'baseline exception: src/x.ts > src/y.ts',
      'scripts/quality/baseline.json lists 3 exceptions and must list none. Drop resolved entries with --prune.',
    ])
  })

  it('prunes resolved entries, then passes once nothing is found', async () => {
    const result = await check([], { baseline: listedBaseline(), prune: true })
    assert.equal(result.ok, true)
    assert.deepEqual(result.errors, [])
    assert.deepEqual(result.pruned, baseline())
    assert.ok(result.output.includes('  exports src/a.ts: alpha'))
  })

  it('keeps an entry that is still found and still fails it', async () => {
    const result = await check(['files src/c.ts'], {
      baseline: listedBaseline(),
      prune: true,
    })
    assert.equal(result.ok, false)
    assert.deepEqual(result.pruned.knip, ['files src/c.ts'])
    assert.deepEqual(result.pruned.cycles, [])
    assert.ok(result.errors.includes('knip finding: files src/c.ts'))
  })

  it('never prunes a new finding into the baseline', async () => {
    const result = await check(['exports src/d.ts: delta'], { prune: true })
    assert.equal(result.ok, false)
    assert.deepEqual(result.pruned.knip, [])
  })

  it('refuses tool versions the baseline was not recorded with', async () => {
    await assert.rejects(
      check([], { versions: { ...VERSIONS, knip: '6.40.0' } }),
      ConfigError,
    )
  })

  it('fails when a tool fails instead of reporting nothing', async () => {
    await assert.rejects(
      check([], {
        knip: () => {
          throw new ToolError('knip failed with exit code 2')
        },
      }),
      ToolError,
    )
  })
})

describe('baseline file', () => {
  it('accepts a canonical baseline and formats it stably', () => {
    const value = listedBaseline()
    assert.equal(parseBaseline(value), value)
    assert.deepEqual(JSON.parse(formatBaseline(value)), value)
    assert.ok(formatBaseline(value).endsWith('}\n'))
  })

  const invalid = {
    'an unsorted list': { knip: ['files src/c.ts', 'exports src/a.ts: alpha'] },
    'a duplicate entry': { knip: ['files src/c.ts', 'files src/c.ts'] },
    'an unknown issue type': { knip: ['cycles src/a.ts: b'] },
    'a finding without a symbol': { knip: ['exports src/a.ts'] },
    'a cycle that does not start at its smallest path': {
      cycles: ['src/y.ts > src/x.ts'],
    },
    'a short source commit': { source: '07cd794e' },
    'missing tool versions': { tools: { knip: '6.39.0' } },
  }
  for (const [label, overrides] of Object.entries(invalid)) {
    it(`rejects ${label}`, () => {
      assert.throws(
        () => parseBaseline({ ...listedBaseline(), ...overrides }),
        ConfigError,
      )
    })
  }

  it('rejects unknown fields', () => {
    assert.throws(
      () => parseBaseline({ ...baseline(), allow: [] }),
      ConfigError,
    )
  })
})

describe('knip runner', () => {
  function fakeSpawn(result) {
    const calls = []
    const spawn = (command, args, options) => {
      calls.push({ command, args, options })
      return { status: 0, stdout: '', stderr: '', ...result }
    }
    return { spawn, calls }
  }

  const run = (spawn) =>
    runKnip({
      root: ROOT,
      knipBin: '/knip/bin/knip.js',
      config: '/knip.json',
      spawn,
    })

  it('runs the JSON reporter from the repository root', () => {
    const { spawn, calls } = fakeSpawn({
      status: 1,
      stdout: JSON.stringify(report()),
    })
    assert.deepEqual(run(spawn), REPORT_IDENTITIES)
    assert.equal(calls[0].command, process.execPath)
    assert.deepEqual(calls[0].args, [
      '/knip/bin/knip.js',
      '--config',
      '/knip.json',
      '--reporter',
      'json',
      '--no-progress',
    ])
    assert.equal(calls[0].options.cwd, ROOT)
  })

  it('accepts a clean run', () => {
    const { spawn } = fakeSpawn({ stdout: '{"issues":[]}' })
    assert.deepEqual(run(spawn), [])
  })

  const failures = {
    'exits with an error': {
      status: 2,
      stderr: 'ERROR: Error loading vite.config.ts',
    },
    'prints no report': { status: 0, stdout: '' },
    'prints a truncated report': { status: 1, stdout: '{"issues":[' },
    'exits with issues but reports none': {
      status: 1,
      stdout: '{"issues":[]}',
    },
    'exits clean but reports issues': {
      status: 0,
      stdout: JSON.stringify(report()),
    },
    'cannot start': { status: null, error: new Error('spawn ENOENT') },
    'is killed': { status: null, signal: 'SIGTERM' },
  }
  for (const [label, result] of Object.entries(failures)) {
    it(`fails when knip ${label}`, () => {
      assert.throws(() => run(fakeSpawn(result).spawn), ToolError)
    })
  }

  it('shows what knip printed on failure', () => {
    const { spawn } = fakeSpawn({
      status: 2,
      stderr: 'ERROR: Error loading vite.config.ts',
    })
    assert.throws(
      () => run(spawn),
      /exit code 2\nERROR: Error loading vite\.config\.ts/,
    )
  })
})

describe('madge runner', () => {
  const scope = {
    roots: ['packages/engine/src', 'src'],
    modules: ['packages/engine/src/index.ts', 'src/a.ts', 'src/b.ts'],
    paths: { '@x/engine': ['./packages/engine/src/index.ts'] },
    known: new Set(['packages/engine/src/index.ts', 'src/a.ts', 'src/b.ts']),
  }

  function fakeMadge({ graph, circular = [], skipped = [], fail } = {}) {
    const calls = []
    const madge = async (paths, config) => {
      calls.push({ paths, config })
      if (fail) throw fail
      return {
        obj: () =>
          graph ?? {
            'packages/engine/src/index.ts': [],
            'src/a.ts': ['src/b.ts'],
            'src/b.ts': ['src/a.ts'],
          },
        circular: () => circular,
        warnings: () => ({ skipped }),
      }
    }
    return { loadMadge: async () => madge, calls }
  }

  const run = (fake, options = {}) =>
    runMadge({
      root: ROOT,
      scope,
      compilerOptions: { moduleResolution: 'bundler' },
      loadMadge: fake.loadMadge,
      ...options,
    })

  it('returns canonical cycles and resolves package specifiers to sources', async () => {
    const fake = fakeMadge({ circular: [['src/b.ts', 'src/a.ts']] })
    assert.deepEqual(await run(fake), {
      modules: 3,
      cycles: ['src/a.ts > src/b.ts'],
    })
    const [{ paths, config }] = fake.calls
    assert.deepEqual(paths, [
      '/repo/packages/engine/src/index.ts',
      '/repo/src/a.ts',
      '/repo/src/b.ts',
    ])
    assert.deepEqual(config.tsConfig.compilerOptions, {
      moduleResolution: 'bundler',
      allowJs: true,
      baseUrl: ROOT,
      paths: scope.paths,
    })
    assert.equal(config.dependencyFilter('/repo/src/b.ts'), true)
    assert.equal(
      config.dependencyFilter('/repo/src/generated-routes.ts'),
      false,
    )
    assert.equal(config.dependencyFilter('/repo/src/styles/app.css'), false)
  })

  it('fails on an import it cannot resolve', async () => {
    await assert.rejects(
      run(fakeMadge({ skipped: ['./missing-module'] })),
      /could not resolve: \.\/missing-module/,
    )
  })

  it('allows only the generated imports knip also ignores', async () => {
    const fake = fakeMadge({ skipped: ['./generated-routes'] })
    assert.deepEqual(
      await run(fake, { allowedUnresolved: ['./generated-routes'] }),
      { modules: 3, cycles: [] },
    )
    await assert.rejects(run(fake), ToolError)
  })

  it('fails when a root yields no module', async () => {
    await assert.rejects(
      run(fakeMadge({ graph: { 'src/a.ts': [] } })),
      /no module under packages\/engine\/src/,
    )
  })

  it('fails when madge throws or has nothing to read', async () => {
    await assert.rejects(
      run(fakeMadge({ fail: new Error('parse error') })),
      /madge failed: parse error/,
    )
    await assert.rejects(
      runMadge({
        root: ROOT,
        scope: { ...scope, modules: [] },
        compilerOptions: {},
        loadMadge: fakeMadge().loadMadge,
      }),
      ToolError,
    )
  })
})

describe('knip configuration coverage', () => {
  const FILES = {
    'package.json': '{"private":true}',
    'src/main.tsx': '',
    'src/pages/raw.tsx': '',
    'packages/engine/package.json': JSON.stringify({
      name: '@x/engine',
      exports: {
        '.': { types: './dist/src/index.d.ts', import: './dist/index.js' },
        './export': {
          types: './dist/src/export/index.d.ts',
          import: './dist/export.js',
        },
      },
    }),
    'packages/engine/tsconfig.json': JSON.stringify({
      compilerOptions: { rootDir: '.', outDir: 'dist' },
    }),
    'packages/engine/vite.config.ts': [
      'export default defineConfig({',
      '  build: {',
      "    outDir: 'dist',",
      '    lib: {',
      '      entry: {',
      "        index: fileURLToPath(new URL('./src/index.ts', import.meta.url)),",
      "        'export': fileURLToPath(",
      "          new URL('./src/export/index.ts', import.meta.url),",
      '        ),',
      '      },',
      '    },',
      "    rollupOptions: { output: { entryFileNames: '[name].js' } },",
      '  },',
      '})',
    ].join('\n'),
    'packages/engine/src/index.ts': '',
    'packages/engine/src/export/index.ts': '',
    'packages/color/package.json': JSON.stringify({
      name: '@x/color',
      exports: { '.': { types: './dist/index.d.ts' } },
    }),
    'packages/color/tsconfig.json': JSON.stringify({
      compilerOptions: { rootDir: 'src', outDir: 'dist' },
    }),
    'packages/color/src/index.ts': '',
    'packages/cli/package.json': JSON.stringify({
      name: '@x/cli',
      private: false,
      bin: { x: './bin/x.mjs' },
      exports: {
        './load': { types: './load.d.mts', import: './load.mjs' },
      },
    }),
    'packages/cli/bin/x.mjs': '',
    'packages/cli/load.d.mts': '',
    'packages/cli/load.mjs': '',
  }
  const files = Object.keys(FILES)
  const workspaces = readWorkspacePackages(files, (path) => FILES[path], ts)

  function config(overrides = {}) {
    return {
      workspaces: {
        '.': {
          entry: ['src/main.tsx', 'src/pages/**/*.tsx'],
          project: ['src/**/*.tsx'],
        },
        'packages/engine': {
          entry: ['src/index.ts', 'src/export/index.ts'],
          project: ['src/**/*.ts'],
        },
        'packages/color': { entry: ['src/index.ts'], project: ['src/**/*.ts'] },
        'packages/cli': { entry: ['bin/*.mjs', 'load.mjs', 'load.d.mts'] },
        ...overrides,
      },
    }
  }

  it('maps published exports and bins back to their sources', () => {
    const fileSet = new Set(files)
    const byDir = (dir) => workspaces.find((workspace) => workspace.dir === dir)
    assert.deepEqual(publishedEntries(byDir('packages/engine'), fileSet), [
      { specifier: '@x/engine', condition: 'types', source: 'src/index.ts' },
      { specifier: '@x/engine', condition: 'import', source: 'src/index.ts' },
      {
        specifier: '@x/engine/export',
        condition: 'types',
        source: 'src/export/index.ts',
      },
      {
        specifier: '@x/engine/export',
        condition: 'import',
        source: 'src/export/index.ts',
      },
    ])
    assert.deepEqual(publishedEntries(byDir('packages/color'), fileSet), [
      { specifier: '@x/color', condition: 'types', source: 'src/index.ts' },
    ])
    // A package without a vite.config.ts is not a Vite build.
    assert.equal(byDir('packages/color').bundle, undefined)
    assert.deepEqual(publishedEntries(byDir('packages/cli'), fileSet), [
      { specifier: '@x/cli/load', condition: 'types', source: 'load.d.mts' },
      { specifier: '@x/cli/load', condition: 'import', source: 'load.mjs' },
      { specifier: 'bin x', source: 'bin/x.mjs' },
    ])
  })

  it('maps every condition on its own, nested ones included', () => {
    const manifest = {
      name: '@x/color',
      exports: {
        '.': {
          types: './dist/index.d.ts',
          node: { import: './dist/node.js', require: './dist/gone.cjs' },
          browser: null,
          worker: ['./dist/index.js'],
          deno: 5,
        },
      },
    }
    const color = {
      dir: 'packages/color',
      manifest,
      compilerOptions: { rootDir: 'src', outDir: 'dist' },
    }
    const fileSet = new Set([
      'packages/color/src/index.ts',
      'packages/color/src/node.ts',
    ])
    assert.deepEqual(publishedEntries(color, fileSet), [
      { specifier: '@x/color', condition: 'types', source: 'src/index.ts' },
      {
        specifier: '@x/color',
        condition: 'node.import',
        source: 'src/node.ts',
      },
      { specifier: '@x/color', condition: 'node.require', source: undefined },
      { specifier: '@x/color', condition: 'worker', source: 'src/index.ts' },
      { specifier: '@x/color', condition: 'deno', source: undefined },
    ])
  })

  it('maps a Vite library output only through its literal entry', () => {
    const fileSet = new Set(files)
    const engine = workspaces.find(({ dir }) => dir === 'packages/engine')
    assert.deepEqual(engine.bundle, {
      outDir: 'dist',
      outputs: {
        'dist/index.js': 'src/index.ts',
        'dist/export.js': 'src/export/index.ts',
      },
    })
    const sources = (bundle, compilerOptions = engine.compilerOptions) =>
      publishedEntries({ ...engine, bundle, compilerOptions }, fileSet).map(
        ({ condition, source, problem }) =>
          `${condition} ${source}${problem ? `: ${problem}` : ''}`,
      )
    // In a package Vite builds, outDir holds no script tsc maps back.
    assert.deepEqual(sources({ outDir: 'dist', outputs: {} }), [
      'types src/index.ts',
      'import undefined',
      'types src/export/index.ts',
      'import undefined',
    ])
    // Nor does the Vite outDir when the tsconfig emits elsewhere.
    assert.deepEqual(
      sources(
        { outDir: 'dist', outputs: {} },
        { rootDir: '.', outDir: 'types' },
      ),
      [
        'types undefined',
        'import undefined',
        'types undefined',
        'import undefined',
      ],
    )
  })

  it('maps no target of a package whose Vite configuration it cannot read', () => {
    const vite = 'packages/engine/vite.config.ts'
    const unread = (text, manifest) => {
      const read = {
        ...FILES,
        [vite]: text,
        'packages/engine/package.json': JSON.stringify(manifest),
      }
      const [engine] = readWorkspacePackages(
        Object.keys(read).filter((path) => path.startsWith('packages/engine/')),
        (path) => read[path],
        ts,
      )
      return publishedEntries(engine, new Set(Object.keys(read)))
    }
    const engine = JSON.parse(FILES['packages/engine/package.json'])
    const notDefineConfig =
      'vite.config.ts default export is not defineConfig({ ... })'
    assert.deepEqual(
      unread(
        "export default { build: { lib: { entry: 'src/index.ts' } } }",
        engine,
      ),
      [{ specifier: '@x/engine', source: undefined, problem: notDefineConfig }],
    )
    // Neither a declaration tsc maps back nor a target that is a source
    // stands in for the build the configuration does not describe.
    const variableOutDir = `const outputDir = 'dist'\n${FILES[vite].replace(
      "outDir: 'dist'",
      'outDir: outputDir',
    )}`
    const outDirProblem = {
      specifier: '@x/engine',
      source: undefined,
      problem: 'vite.config.ts build.outDir is not a string literal',
    }
    for (const rootExport of [
      { types: './dist/index.d.ts' },
      { types: './dist/index.d.ts', import: './src/index.ts' },
    ]) {
      assert.deepEqual(
        unread(variableOutDir, {
          name: '@x/engine',
          exports: { '.': rootExport },
        }),
        [outDirProblem],
      )
    }
    assert.deepEqual(
      unread(variableOutDir, {
        name: '@x/engine',
        bin: { x: './src/index.ts' },
      }),
      [outDirProblem],
    )
  })

  it('maps no target of a package whose exports it cannot read', () => {
    const engine = workspaces.find(({ dir }) => dir === 'packages/engine')
    const entries = (manifest) =>
      publishedEntries({ ...engine, manifest }, new Set(files))
    assert.deepEqual(
      entries({
        name: '@x/engine',
        exports: { '.': './dist/index.js', import: './dist/index.js' },
      }),
      [
        {
          specifier: '@x/engine',
          source: undefined,
          problem: 'package.json exports mixes subpaths and conditions',
        },
      ],
    )
    assert.deepEqual(
      entries({
        name: '@x/engine',
        exports: { '.export': './dist/export.js' },
      }),
      [
        {
          specifier: '@x/engine',
          source: undefined,
          problem: 'package.json exports key .export is not a subpath',
        },
      ],
    )
    assert.deepEqual(entries({ exports: './dist/index.js' }), [
      {
        specifier: 'packages/engine',
        source: undefined,
        problem: 'package.json has no name',
      },
    ])
  })

  it('maps a tsc output back only through the rootDir the tsconfig declares', () => {
    const color = {
      dir: 'packages/color',
      manifest: {
        name: '@x/color',
        exports: {
          '.': { types: './dist/index.d.ts', import: './dist/index.js' },
          './node': { types: './dist/node.d.mts', import: './dist/node.mjs' },
          './view': './dist/view.js',
          './data': './dist/data.json',
        },
      },
    }
    const sources = (compilerOptions, extra = []) =>
      publishedEntries(
        { ...color, compilerOptions },
        new Set([
          'packages/color/src/index.ts',
          'packages/color/src/node.ts',
          'packages/color/src/node.mts',
          ...extra,
        ]),
      ).map(
        ({ specifier, condition, source, problem }) =>
          `${specifier} ${condition} ${source}${problem ? `: ${problem}` : ''}`,
      )
    // Each output comes from the source extension tsc emits it from.
    assert.deepEqual(sources({ rootDir: 'src', outDir: './dist/' }), [
      '@x/color types src/index.ts',
      '@x/color import src/index.ts',
      '@x/color/node types src/node.mts',
      '@x/color/node import src/node.mts',
      '@x/color/view default undefined',
      '@x/color/data default undefined',
    ])
    // tsc derives a missing rootDir from the program, so none is assumed.
    const noRootDir = ': tsconfig.json declares outDir but not rootDir'
    assert.deepEqual(sources({ outDir: 'dist' }), [
      `@x/color types undefined${noRootDir}`,
      `@x/color import undefined${noRootDir}`,
      `@x/color/node types undefined${noRootDir}`,
      `@x/color/node import undefined${noRootDir}`,
      `@x/color/view default undefined${noRootDir}`,
      `@x/color/data default undefined${noRootDir}`,
    ])
    // Without an outDir, a target under dist is a file of its own.
    assert.deepEqual(sources({}), [
      '@x/color types undefined',
      '@x/color import undefined',
      '@x/color/node types undefined',
      '@x/color/node import undefined',
      '@x/color/view default undefined',
      '@x/color/data default undefined',
    ])
    // Two sources tsc could emit the same output from are not guessed at.
    assert.deepEqual(
      sources({ rootDir: 'src', outDir: 'dist' }, [
        'packages/color/src/index.tsx',
      ]),
      [
        '@x/color types undefined: ./dist/index.d.ts can be built from src/index.ts or src/index.tsx',
        '@x/color import undefined: ./dist/index.js can be built from src/index.ts or src/index.tsx',
        '@x/color/node types src/node.mts',
        '@x/color/node import src/node.mts',
        '@x/color/view default undefined',
        '@x/color/data default undefined',
      ],
    )
  })

  it('names the unreadable Vite property of a package it cannot map', () => {
    const vite = 'packages/engine/vite.config.ts'
    const read = {
      ...FILES,
      [vite]: FILES[vite].replace(/entry: \{/, 'entry: { ...shared,'),
    }
    const problems = checkKnipConfig({
      config: config(),
      files,
      workspaces: readWorkspacePackages(files, (path) => read[path], ts),
    })
    const problem = 'vite.config.ts build.lib.entry has a spread element'
    assert.deepEqual(problems, [
      `@x/engine has no source file in packages/engine: ${problem}`,
    ])
  })

  it('reads only a single vite.config.ts', () => {
    const [mts] = readWorkspacePackages(
      ['packages/engine/package.json', 'packages/engine/vite.config.mts'],
      (path) => FILES[path] ?? FILES['packages/engine/vite.config.ts'],
      ts,
    )
    assert.deepEqual(mts.bundle, {
      problem: 'only a single vite.config.ts is read, not vite.config.mts',
    })
    const [both] = readWorkspacePackages(
      [
        'packages/engine/package.json',
        'packages/engine/vite.config.js',
        'packages/engine/vite.config.ts',
      ],
      (path) => FILES[path] ?? FILES['packages/engine/vite.config.ts'],
      ts,
    )
    assert.deepEqual(both.bundle, {
      problem:
        'only a single vite.config.ts is read, not vite.config.js, vite.config.ts',
    })
  })

  it('publishes the entry fields of a package without exports', () => {
    const legacy = {
      dir: 'packages/color',
      manifest: {
        name: '@x/color',
        main: './dist/index.js',
        types: './dist/index.d.ts',
        module: 5,
      },
      compilerOptions: { rootDir: 'src', outDir: 'dist' },
    }
    const fileSet = new Set(['packages/color/src/index.ts'])
    assert.deepEqual(publishedEntries(legacy, fileSet), [
      { specifier: '@x/color', condition: 'main', source: 'src/index.ts' },
      { specifier: '@x/color', condition: 'module', source: undefined },
      { specifier: '@x/color', condition: 'types', source: 'src/index.ts' },
    ])
    const withExports = {
      ...legacy,
      manifest: { ...legacy.manifest, exports: { '.': './dist/index.js' } },
    }
    assert.deepEqual(publishedEntries(withExports, fileSet), [
      { specifier: '@x/color', condition: 'default', source: 'src/index.ts' },
    ])
  })

  it('fails a bin that is neither a path nor a map of paths', () => {
    const cli = {
      dir: 'packages/cli',
      manifest: { name: '@x/cli', bin: ['./bin/x.mjs'] },
      compilerOptions: {},
    }
    assert.deepEqual(
      publishedEntries(cli, new Set(['packages/cli/bin/x.mjs'])),
      [{ specifier: 'bin @x/cli', source: undefined }],
    )
  })

  it('maps nothing for a target that is not a plain ./ path', () => {
    // Node decodes ./dist/%6eode.js to dist/node.js, which Vite builds from
    // the node entry, while the literal output is the %6eode entry.
    const read = {
      ...FILES,
      'packages/engine/vite.config.ts': FILES[
        'packages/engine/vite.config.ts'
      ].replace(
        '      },\n    },',
        [
          "        node: fileURLToPath(new URL('./src/node.ts', import.meta.url)),",
          "        '%6eode': fileURLToPath(new URL('./src/clean.ts', import.meta.url)),",
          '      },',
          '    },',
        ].join('\n'),
      ),
      'packages/engine/package.json': JSON.stringify({
        name: '@x/engine',
        exports: {
          '.': {
            types: './dist/src/index.d.ts',
            node: './dist/%6eode.js',
            import: './dist/index.js',
          },
        },
      }),
      'packages/engine/src/node.ts': '',
      'packages/engine/src/clean.ts': '',
    }
    const readFiles = Object.keys(read)
    const readWorkspaces = readWorkspacePackages(
      readFiles,
      (path) => read[path],
      ts,
    )
    const engine = readWorkspaces.find(({ dir }) => dir === 'packages/engine')
    assert.equal(engine.bundle.outputs['dist/%6eode.js'], 'src/clean.ts')
    assert.equal(engine.bundle.outputs['dist/node.js'], 'src/node.ts')
    const problem =
      'package.json exports . node has an unsupported export target form: "./dist/%6eode.js"'
    assert.deepEqual(publishedEntries(engine, new Set(readFiles)), [
      { specifier: '@x/engine', source: undefined, problem },
    ])
    assert.deepEqual(
      checkKnipConfig({
        config: config(),
        files: readFiles,
        workspaces: readWorkspaces,
      }),
      [`@x/engine has no source file in packages/engine: ${problem}`],
    )

    const color = {
      dir: 'packages/color',
      compilerOptions: { rootDir: 'src', outDir: 'dist' },
    }
    const fileSet = new Set(['packages/color/src/index.ts'])
    const mapped = (manifest) =>
      publishedEntries(
        { ...color, manifest: { name: '@x/color', ...manifest } },
        fileSet,
      )
    for (const target of [
      './dist/%69ndex.js',
      './dist/index.js?x',
      './dist/index.js#x',
      './dist\\index.js',
      './dist/c:index.js',
      './dist/in dex.js',
      './dist/../dist/index.js',
      './dist/./index.js',
      './dist//index.js',
      './dist/*.js',
      'dist/index.js',
      '/dist/index.js',
      'file:///dist/index.js',
    ]) {
      const unsupported = (field) => [
        {
          specifier: '@x/color',
          source: undefined,
          problem: `package.json ${field} has an unsupported export target form: ${JSON.stringify(target)}`,
        },
      ]
      assert.deepEqual(
        mapped({ exports: { './view': { import: target } } }),
        unsupported('exports ./view import'),
        target,
      )
      assert.deepEqual(mapped({ main: target }), unsupported('main'), target)
      // An entry field is not published beside exports, but it is still a
      // target a resolver can read.
      assert.deepEqual(
        mapped({ exports: './dist/index.js', types: target }),
        unsupported('types'),
        target,
      )
      assert.deepEqual(
        mapped({ bin: { x: target } }),
        unsupported('bin x'),
        target,
      )
    }
  })

  it('maps nothing for exports that are null', () => {
    const color = {
      dir: 'packages/color',
      manifest: { name: '@x/color', exports: null, main: './dist/index.js' },
      compilerOptions: { rootDir: 'src', outDir: 'dist' },
    }
    assert.deepEqual(
      publishedEntries(color, new Set(['packages/color/src/index.ts'])),
      [
        {
          specifier: '@x/color',
          source: undefined,
          problem: 'package.json exports is null',
        },
      ],
    )
  })

  it('maps nothing for a public package that publishes no entry', () => {
    const fileSet = new Set(['packages/color/src/index.ts'])
    const entries = (manifest) =>
      publishedEntries(
        { dir: 'packages/color', manifest, compilerOptions: {} },
        fileSet,
      )
    const none = [
      {
        specifier: '@x/color',
        source: undefined,
        problem: 'package.json publishes no entry',
      },
    ]
    assert.deepEqual(entries({ name: '@x/color' }), none)
    assert.deepEqual(entries({ name: '@x/color', private: false }), none)
    assert.deepEqual(
      entries({ name: '@x/color', exports: { '.': null } }),
      none,
    )
    // A private package publishes nothing.
    assert.deepEqual(entries({ name: '@x/color', private: true }), [])
    assert.deepEqual(
      checkKnipConfig({
        config: config({ 'packages/color': { entry: [] } }),
        files,
        workspaces: workspaces.map((workspace) =>
          workspace.dir === 'packages/color'
            ? { ...workspace, manifest: { name: '@x/color' } }
            : workspace,
        ),
      }),
      [
        '@x/color has no source file in packages/color: package.json publishes no entry',
      ],
    )
  })

  it('accepts a configuration that names every published entry', () => {
    assert.deepEqual(
      checkKnipConfig({ config: config(), files, workspaces }),
      [],
    )
  })

  it('reports a published condition without a source', () => {
    const problems = checkKnipConfig({
      config: config({ 'packages/cli': { entry: ['bin/*.mjs', 'load.mjs'] } }),
      files: files.filter((file) => file !== 'packages/cli/load.d.mts'),
      workspaces,
    })
    assert.deepEqual(problems, [
      '@x/cli/load types has no source file in packages/cli',
    ])
  })

  it('reports a published export or bin without a knip entry', () => {
    const problems = checkKnipConfig({
      config: config({
        'packages/engine': {
          entry: ['src/index.ts'],
          project: ['src/**/*.ts'],
        },
        'packages/cli': { entry: ['load.mjs', 'load.d.mts'] },
      }),
      files,
      workspaces,
    })
    assert.deepEqual(problems, [
      '@x/engine/export (packages/engine/src/export/index.ts) is not a knip entry of packages/engine',
      'bin x (packages/cli/bin/x.mjs) is not a knip entry of packages/cli',
    ])
  })

  it('reports workspaces that are missing or unknown', () => {
    const { 'packages/color': _color, ...rest } = config().workspaces
    const problems = checkKnipConfig({
      config: { workspaces: { ...rest, 'packages/gone': { entry: ['a.ts'] } } },
      files,
      workspaces,
    })
    assert.ok(
      problems.includes('workspace packages/color has no knip workspace'),
    )
    assert.ok(
      problems.includes(
        'knip workspace packages/gone is not a workspace package',
      ),
    )
  })

  it('reports a pattern that matches no file', () => {
    const problems = checkKnipConfig({
      config: config({
        '.': {
          entry: ['src/main.tsx', 'src/testing.ts'],
          project: ['lib/**/*.ts'],
        },
      }),
      files,
      workspaces,
    })
    assert.deepEqual(problems, [
      'knip workspace . entry pattern src/testing.ts matches no file',
      'knip workspace . project pattern lib/**/*.ts matches no file',
    ])
  })

  it('points madge at project directories and published sources', () => {
    const scope = madgeScope({
      config: config(),
      files,
      workspaces,
      rootPaths: { '~/*': ['./src/*'] },
    })
    assert.deepEqual(scope.roots, [
      'packages/cli/load.mjs',
      'packages/color/src',
      'packages/engine/src',
      'src',
    ])
    assert.deepEqual(scope.paths, {
      '~/*': ['./src/*'],
      '@x/cli/load': ['./packages/cli/load.mjs'],
      '@x/color': ['./packages/color/src/index.ts'],
      '@x/engine': ['./packages/engine/src/index.ts'],
      '@x/engine/export': ['./packages/engine/src/export/index.ts'],
    })
    assert.ok(!scope.modules.includes('packages/cli/bin/x.mjs'))
    assert.ok(scope.modules.includes('src/pages/raw.tsx'))
  })
})

describe('Vite library entries', () => {
  const entryLine = (name, path) =>
    `      ${name}: fileURLToPath(new URL('${path}', import.meta.url)),`
  /** A package configuration in the form the packages use. */
  function viteConfig({
    before = [],
    entry = [
      entryLine('index', './src/index.ts'),
      entryLine('node', './src/node.ts'),
    ],
    outDir = "'dist'",
    entryFileNames = "'[name].js'",
    after = [],
  } = {}) {
    return [
      "import { fileURLToPath } from 'node:url'",
      "import { defineConfig } from 'vite'",
      "const root = fileURLToPath(new URL('.', import.meta.url))",
      'export default defineConfig({',
      '  root,',
      ...before,
      '  build: {',
      `    outDir: ${outDir},`,
      '    lib: {',
      '      entry: {',
      ...entry,
      '      },',
      "      formats: ['es'],",
      '    },',
      '    rollupOptions: {',
      `      output: { chunkFileNames: '[name].js', entryFileNames: ${entryFileNames} },`,
      '    },',
      '  },',
      '})',
      ...after,
    ].join('\n')
  }
  const MAPPED = {
    outDir: 'dist',
    outputs: { 'dist/index.js': 'src/index.ts', 'dist/node.js': 'src/node.ts' },
  }
  const read = (text) => viteLibraryOutputs(text, ts)
  const problem = (text) =>
    read(text).problem?.replace(/^vite\.config\.ts /, '')

  it('reads the entries of the configuration form the packages use', () => {
    assert.deepEqual(read(viteConfig()), MAPPED)
    assert.deepEqual(
      read(
        viteConfig({
          outDir: "'./out/'",
          entry: [
            entryLine("'export'", './src/export/index.ts'),
            entryLine("'policy/index'", './src/policy/index.ts'),
          ],
        }),
      ),
      {
        outDir: 'out',
        outputs: {
          'out/export.js': 'src/export/index.ts',
          'out/policy/index.js': 'src/policy/index.ts',
        },
      },
    )
  })

  it('reads only a plain ./ entry path and decodes nothing', () => {
    for (const path of [
      // A URL reads these differently from a path.
      './src/%6eode.ts',
      './src/%2e%2e/src/node.ts',
      './src%2Findex.ts',
      './src/a%20b.ts',
      './src/index.ts?raw',
      './src/index.ts#x',
      './src/a b.ts',
      './src\\index.ts',
      './src/c:index.ts',
      // Not inside the package, or not one normalized relative path.
      '../pkg/src/node.ts',
      './src/../src/node.ts',
      './src/./node.ts',
      './src//node.ts',
      './',
      '.',
      'src/node.ts',
      '/packages/pkg/src/index.ts',
      'file:///packages/pkg/src/index.ts',
    ]) {
      const text = viteConfig({
        entry: [
          `      node: fileURLToPath(new URL(${JSON.stringify(path)}, import.meta.url)),`,
        ],
      })
      assert.equal(
        problem(text),
        `build.lib.entry.node path ${JSON.stringify(path)} is not a plain ./ path`,
        path,
      )
      assert.equal(read(text).outputs, undefined)
    }
  })

  it('ignores a commented-out entry beside the real one', () => {
    const entry = [
      entryLine('index', './src/index.ts'),
      entryLine('node', './src/node.ts'),
      `  // ${entryLine('node', './src/index.ts').trim()}`,
      `  /* ${entryLine('index', './src/gone.ts').trim()} */`,
    ]
    assert.deepEqual(read(viteConfig({ entry })), MAPPED)
  })

  it('ignores entry text inside a string or a comment elsewhere', () => {
    const decoy = `entry: { ${entryLine('index', './src/gone.ts').trim()} }`
    assert.deepEqual(
      read(
        viteConfig({
          before: [
            `  define: { banner: ${JSON.stringify(decoy)} },`,
            `  // ${decoy}`,
          ],
          after: [`const unused = { build: { lib: { ${decoy} } } }`],
        }),
      ),
      MAPPED,
    )
  })

  it('maps nothing when the entry block is commented out', () => {
    const text = viteConfig().replace(
      /^ {6}entry: \{\n(?:.*\n)*? {6}\},$/m,
      (block) => block.replace(/^/gm, '// '),
    )
    assert.match(text, /^\/\/ {7}entry: \{$/m)
    assert.equal(problem(text), 'build.lib.entry is missing')
  })

  const rejected = [
    [
      'a duplicate entry key',
      viteConfig({
        entry: [
          entryLine('index', './src/index.ts'),
          entryLine("'index'", './src/gone.ts'),
        ],
      }),
      'build.lib.entry.index is declared twice',
    ],
    [
      'a spread entry',
      viteConfig({
        entry: ['      ...shared,', entryLine('index', './src/index.ts')],
      }),
      'build.lib.entry has a spread element',
    ],
    [
      'a computed entry key',
      viteConfig({ entry: [entryLine('[name]', './src/index.ts')] }),
      'build.lib.entry has a computed or non-literal key',
    ],
    [
      'a numeric entry key',
      viteConfig({ entry: [entryLine('1', './src/index.ts')] }),
      'build.lib.entry has a computed or non-literal key',
    ],
    [
      'a shorthand entry',
      viteConfig({ entry: ['      index,'] }),
      'build.lib.entry.index is not a name: value property',
    ],
    [
      'a method entry',
      viteConfig({ entry: ['      index() {},'] }),
      'build.lib.entry.index is not a name: value property',
    ],
    [
      'an entry that is a variable',
      viteConfig({ entry: ['      index: indexPath,'] }),
      "build.lib.entry.index is not fileURLToPath(new URL('<string literal>', import.meta.url))",
    ],
    [
      'an entry path that is a template literal',
      viteConfig({
        entry: [
          '      index: fileURLToPath(new URL(`./src/index.ts`, import.meta.url)),',
        ],
      }),
      "build.lib.entry.index is not fileURLToPath(new URL('<string literal>', import.meta.url))",
    ],
    [
      'an entry resolved against another base',
      viteConfig({
        entry: ["      index: fileURLToPath(new URL('./src/index.ts', base)),"],
      }),
      "build.lib.entry.index is not fileURLToPath(new URL('<string literal>', import.meta.url))",
    ],
    [
      'an entry built by another function',
      viteConfig({
        entry: [
          "      index: resolve(new URL('./src/index.ts', import.meta.url)),",
        ],
      }),
      "build.lib.entry.index is not fileURLToPath(new URL('<string literal>', import.meta.url))",
    ],
    [
      'an entry name that is a relative path',
      viteConfig({ entry: [entryLine("'../index'", './src/index.ts')] }),
      'build.lib.entry.../index is not an output name inside build.outDir',
    ],
    [
      'an entry name that is not normalized',
      viteConfig({ entry: [entryLine("'a//index'", './src/index.ts')] }),
      'build.lib.entry.a//index is not an output name inside build.outDir',
    ],
    [
      'an empty entry name',
      viteConfig({ entry: [entryLine("''", './src/index.ts')] }),
      'build.lib.entry. is not an output name inside build.outDir',
    ],
    [
      'an empty entry object',
      viteConfig({ entry: [] }),
      'build.lib.entry names no entry',
    ],
    [
      'an entry that is not an object',
      viteConfig().replace(
        /entry: \{[\s\S]*?\n {6}\},/,
        "entry: './src/index.ts',",
      ),
      'build.lib.entry is not an object literal',
    ],
    [
      'a shorthand lib entry',
      viteConfig().replace(/entry: \{[\s\S]*?\n {6}\},/, 'entry,'),
      'build.lib.entry is not a name: value property',
    ],
    [
      'an outDir that is a variable',
      viteConfig({ outDir: 'dist' }),
      'build.outDir is not a string literal',
    ],
    [
      'an outDir that is a template literal',
      viteConfig({ outDir: '`dist`' }),
      'build.outDir is not a string literal',
    ],
    [
      'an outDir outside the package',
      viteConfig({ outDir: "'../dist'" }),
      'build.outDir is not a directory inside the package',
    ],
    [
      'an absolute outDir',
      viteConfig({ outDir: "'/dist'" }),
      'build.outDir is not a directory inside the package',
    ],
    [
      'an outDir that is the package',
      viteConfig({ outDir: "'./'" }),
      'build.outDir is not a directory inside the package',
    ],
    [
      'a missing outDir',
      viteConfig().replace("    outDir: 'dist',\n", ''),
      'build.outDir is missing',
    ],
    [
      'other entry file names',
      viteConfig({ entryFileNames: "'[name].mjs'" }),
      "build.rollupOptions.output.entryFileNames is not the string literal '[name].js'",
    ],
    [
      'entry file names from a function',
      viteConfig({ entryFileNames: "() => '[name].js'" }),
      "build.rollupOptions.output.entryFileNames is not the string literal '[name].js'",
    ],
    [
      'missing entry file names',
      viteConfig().replace(/, entryFileNames: [^ ]+ \}/, ' }'),
      'build.rollupOptions.output.entryFileNames is missing',
    ],
    [
      'output options that are not an object',
      viteConfig().replace(/output: \{.*\},/, 'output: [],'),
      'build.rollupOptions.output is not an object literal',
    ],
    [
      'a spread beside a property it could override',
      viteConfig().replace('  build: {\n', '  build: {\n    ...shared,\n'),
      'build.outDir is unknown beside a spread element',
    ],
    [
      'a computed key beside the build options',
      viteConfig({ before: ['  [key]: {},'] }),
      'build is unknown beside a computed or non-literal key',
    ],
    [
      'a duplicate build property',
      viteConfig({ before: ["  build: { outDir: 'gone' },"] }),
      'build is declared twice',
    ],
    [
      'build options from a variable',
      viteConfig().replace(/ {2}build: \{[\s\S]*\n {2}\},\n/, '  build,\n'),
      'build is not a name: value property',
    ],
    [
      'a second default export',
      viteConfig({ after: ['export { root as default }'] }),
      'has 2 default exports, not one',
    ],
    [
      'a default export declaration',
      `${viteConfig().replace(
        'export default defineConfig(',
        'const config = defineConfig(',
      )}\nexport default function config2() {}`,
      'default export is not defineConfig({ ... })',
    ],
    [
      'no default export',
      viteConfig().replace('export default ', 'const config = '),
      'has 0 default exports, not one',
    ],
    [
      'a default export that is not defineConfig',
      viteConfig().replace('defineConfig({', 'mergeConfig({'),
      'default export is not defineConfig({ ... })',
    ],
    [
      'defineConfig of a variable',
      'const config = {}\nexport default defineConfig(config)\n',
      'default export is not defineConfig({ ... })',
    ],
    [
      'an export assignment',
      viteConfig().replace('export default ', 'export = '),
      'default export is not defineConfig({ ... })',
    ],
    [
      'a syntax error',
      `${viteConfig()}\nconst = 1`,
      'does not parse: Variable declaration expected.',
    ],
  ]
  for (const [label, text, expected] of rejected) {
    it(`maps nothing for ${label}`, () => {
      assert.equal(problem(text), expected)
      assert.equal(read(text).outputs, undefined)
    })
  }

  it('maps the six package configurations exactly', () => {
    const outputs = Object.fromEntries(
      [
        'lmfg-cli',
        'lmfg-mcp',
        'luma-color-runtime',
        'luma-jpeg-runtime',
        'luma-raw-runtime',
        'render-engine',
      ].map((name) => [
        name,
        read(
          readFileSync(`${repoRoot}packages/${name}/vite.config.ts`, 'utf8'),
        ),
      ]),
    )
    assert.deepEqual(outputs, {
      'lmfg-cli': {
        outDir: 'dist',
        outputs: {
          'dist/index.js': 'src/index.ts',
          'dist/candidate-worker.js': 'src/workers/candidate-worker.ts',
        },
      },
      'lmfg-mcp': {
        outDir: 'dist',
        outputs: { 'dist/index.js': 'src/index.ts' },
      },
      'luma-color-runtime': {
        outDir: 'dist',
        outputs: {
          'dist/index.js': 'src/index.ts',
          'dist/wgsl.js': 'src/wgsl.ts',
        },
      },
      'luma-jpeg-runtime': {
        outDir: 'dist',
        outputs: {
          'dist/index.js': 'src/index.ts',
          'dist/node.js': 'src/runtime-node.ts',
        },
      },
      'luma-raw-runtime': {
        outDir: 'dist',
        outputs: {
          'dist/index.js': 'src/index.ts',
          'dist/node.js': 'src/runtime-node.ts',
        },
      },
      'render-engine': {
        outDir: 'dist',
        outputs: {
          'dist/index.js': 'src/index.ts',
          'dist/export.js': 'src/export/index.ts',
          'dist/geometry.js': 'src/geometry/index.ts',
          'dist/manifest.js': 'src/manifest/index.ts',
          'dist/policy.js': 'src/policy/index.ts',
          'dist/preview.js': 'src/preview/index.ts',
        },
      },
    })
    const files = listRepoFiles(repoRoot)
    assert.deepEqual(
      files.filter((file) => /^packages\/[^/]+\/vite\.config\./.test(file)),
      Object.keys(outputs).map((name) => `packages/${name}/vite.config.ts`),
    )
  })
})

describe('the committed configuration', () => {
  it('covers every workspace package and published entry', () => {
    const files = listRepoFiles(repoRoot)
    const config = JSON.parse(
      readFileSync(new URL('knip.json', import.meta.url), 'utf8'),
    )
    const workspaces = readWorkspacePackages(
      files,
      (path) => readFileSync(`${repoRoot}${path}`, 'utf8'),
      ts,
    )
    assert.deepEqual(checkKnipConfig({ config, files, workspaces }), [])
  })

  it('ignores only dependencies whose consumer knip cannot see', async () => {
    const config = JSON.parse(
      readFileSync(new URL('knip.json', import.meta.url), 'utf8'),
    )
    const ignored = Object.fromEntries(
      Object.entries(config.workspaces)
        .filter(([, workspace]) => workspace.ignoreDependencies)
        .map(([dir, workspace]) => [dir, workspace.ignoreDependencies]),
    )
    assert.deepEqual(ignored, {
      '.': ['@iconify-json/mingcute', 'vercel', 'wrangler'],
    })
    assert.equal(config.ignoreDependencies, undefined)

    // The deploy script runs both CLIs as `pnpm exec <bin>` subprocesses.
    const { createPublishCommand } = await import('../deploy/publish.mjs')
    const { createDeployConfig } = await import('../deploy/config.mjs')
    const deployConfig = createDeployConfig('/repo')
    const publishEnv = {
      CLOUDFLARE_ACCOUNT_ID: 'account',
      CLOUDFLARE_API_TOKEN: 'token',
      [deployConfig.cloudflare.projectNameEnv]: 'lumaforge',
      VERCEL_TOKEN: 'token',
      [deployConfig.vercel.orgIdEnv]: 'org',
      [deployConfig.vercel.projectIdEnv]: 'project',
      GITHUB_REF_NAME: 'main',
    }
    for (const [target, bin] of [
      ['cloudflare', 'wrangler'],
      ['vercel', 'vercel'],
    ]) {
      const { command, args } = createPublishCommand(deployConfig, {
        target,
        deployEnv: 'preview',
        env: publishEnv,
      })
      assert.deepEqual([command, ...args.slice(0, 2)], ['pnpm', 'exec', bin])
    }

    // The icons plugin finds installed `@iconify-json/<prefix>` collections
    // by name and builds the `i-mingcute-*` classes from this one.
    const css = readFileSync(`${repoRoot}src/styles/tailwind.css`, 'utf8')
    assert.match(css, /^@plugin ['"]@egoist\/tailwindcss-icons['"];$/m)
    const sources = listRepoFiles(repoRoot).filter((file) =>
      /^src\/.*\.tsx?$/.test(file),
    )
    assert.ok(
      sources.some((file) =>
        /\bi-mingcute-[\w-]+/.test(readFileSync(`${repoRoot}${file}`, 'utf8')),
      ),
      'no source uses an i-mingcute-* icon class',
    )
  })

  it('keeps the baseline canonical and free of exceptions', () => {
    const text = readFileSync(new URL('baseline.json', import.meta.url), 'utf8')
    const value = parseBaseline(JSON.parse(text))
    assert.equal(formatBaseline(value), text.replaceAll('\r\n', '\n'))
    assert.deepEqual(value.knip, [])
    assert.deepEqual(value.cycles, [])
  })

  it('runs the structure check in the quality job after installing tools', () => {
    const workflow = readFileSync(
      `${repoRoot}.github/workflows/build.yml`,
      'utf8',
    ).replaceAll('\r\n', '\n')
    const quality = /^ {2}quality:\n((?: {4}.*\n|\n)*)/m.exec(workflow)?.[1]
    assert.ok(quality, 'the quality job is not defined')
    assert.doesNotMatch(quality, /^ {4}(?:if|needs):/m)
    const test = quality.indexOf(
      'run: node --test scripts/quality/check-structure.test.mjs',
    )
    const install = quality.indexOf('run: pnpm install --frozen-lockfile')
    const run = quality.indexOf('run: pnpm check:structure')
    assert.ok(install >= 0 && test > install && run > install)

    const manifest = JSON.parse(readFileSync(`${repoRoot}package.json`, 'utf8'))
    assert.equal(
      manifest.scripts['check:structure'],
      'node scripts/quality/check-structure.mjs',
    )
    assert.match(manifest.devDependencies.knip, /^\d+\.\d+\.\d+$/)
    assert.match(manifest.devDependencies.madge, /^\d+\.\d+\.\d+$/)
  })
})

describe('quality script entry points', () => {
  // Node loads a symlinked script from its target, so each script must still
  // see itself as the entry point when started through a symlink.
  const scripts = [
    ['check-structure.mjs', ['--unknown'], 2, /Unknown argument --unknown/],
    ['check-agent-paths.mjs', ['--unknown'], 2, /Unknown option --unknown/],
    ['check-retired-api.mjs', ['--unknown'], 2, /Unknown argument --unknown/],
    ['app-aliases.mjs', [], 0, /app aliases: consistent/],
  ]
  for (const [script, args, status, message] of scripts) {
    it(`runs ${script} when started through a symlink`, () => {
      const dir = mkdtempSync(join(tmpdir(), 'lf-quality-main-'))
      try {
        const link = join(dir, script)
        symlinkSync(fileURLToPath(new URL(script, import.meta.url)), link)
        const result = spawnSync(process.execPath, [link, ...args], {
          cwd: repoRoot,
          encoding: 'utf8',
        })
        assert.equal(result.status, status, result.stderr)
        assert.match(`${result.stdout}${result.stderr}`, message)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })
  }

  it('is not the entry point of a script it was not started as', () => {
    const self = fileURLToPath(import.meta.url)
    assert.equal(isMainModule(import.meta.url, self), true)
    assert.equal(
      isMainModule(new URL('knip.json', import.meta.url).href, self),
      false,
    )
    assert.equal(isMainModule(import.meta.url, ''), false)
    assert.equal(isMainModule(import.meta.url, join(tmpdir(), 'gone')), false)
  })
})
