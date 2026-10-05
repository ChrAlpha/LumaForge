// @vitest-environment node
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import {
  canonicalCycle,
  checkKnipConfig,
  ConfigError,
  diffFindings,
  formatBaseline,
  KNIP_ISSUE_TYPES,
  listRepoFiles,
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
} from './check-structure.mjs'

// Runs under `node --test` and under the Vitest app gate.
const { describe, it } = process.env.VITEST
  ? await import('vitest')
  : await import('node:test')

const repoRoot = fileURLToPath(new URL('../../', import.meta.url))
const ROOT = '/repo'

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
    knip: [
      'exports src/a.ts: alpha',
      'exports src/b.ts: beta',
      'files src/c.ts',
    ],
    cycles: ['src/x.ts > src/y.ts'],
    ...overrides,
  }
}

function check(current, { cycles = ['src/x.ts > src/y.ts'], ...rest } = {}) {
  return runCheck({
    baseline: baseline(),
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

describe('baseline comparison', () => {
  it('passes when the findings are the baseline', async () => {
    const result = await check(baseline().knip)
    assert.equal(result.ok, true)
    assert.deepEqual(result.errors, [])
  })

  it('fails a new unused symbol even when the total goes down', async () => {
    const result = await check([
      'exports src/a.ts: alpha',
      'exports src/d.ts: delta',
    ])
    assert.equal(result.ok, false)
    assert.deepEqual(result.errors.slice(0, 1), [
      'New knip finding: exports src/d.ts: delta',
    ])
    assert.match(result.errors.at(-1), /^1 new finding\./)
  })

  it('fails a new cycle', async () => {
    const result = await check(baseline().knip, {
      cycles: ['src/a.ts > src/b.ts', 'src/x.ts > src/y.ts'],
    })
    assert.equal(result.ok, false)
    assert.equal(result.errors[0], 'New dependency cycle: src/a.ts > src/b.ts')
  })

  it('passes a removed finding, reports it, and prunes only it', async () => {
    const result = await check(['exports src/a.ts: alpha', 'files src/c.ts'], {
      cycles: [],
    })
    assert.equal(result.ok, true)
    assert.ok(result.output.includes('  exports src/b.ts: beta'))
    assert.ok(result.output.includes('  src/x.ts > src/y.ts'))
    assert.deepEqual(result.pruned.knip, [
      'exports src/a.ts: alpha',
      'files src/c.ts',
    ])
    assert.deepEqual(result.pruned.cycles, [])
  })

  it('never prunes a new finding into the baseline', async () => {
    const result = await check(['exports src/d.ts: delta'])
    assert.equal(result.ok, false)
    assert.deepEqual(result.pruned.knip, [])
  })

  it('passes when only line numbers moved', async () => {
    const before = normalizeKnipReport(report(), { root: ROOT })
    const after = normalizeKnipReport(report(7), { root: ROOT })
    const result = await runCheck({
      baseline: baseline({ knip: before }),
      versions: VERSIONS,
      knip: () => after,
      madge: async () => ({ modules: 10, cycles: baseline().cycles }),
    })
    assert.equal(result.ok, true)
    assert.deepEqual(diffFindings(before, after), { added: [], resolved: [] })
  })

  it('refuses tool versions the baseline was not recorded with', async () => {
    await assert.rejects(
      check(baseline().knip, { versions: { ...VERSIONS, knip: '6.40.0' } }),
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
    const value = baseline()
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
      assert.throws(() => parseBaseline(baseline(overrides)), ConfigError)
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
    'packages/cli/load.mjs': '',
  }
  const files = Object.keys(FILES)
  const workspaces = readWorkspacePackages(files, (path) => FILES[path])

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
        'packages/cli': { entry: ['bin/*.mjs', 'load.mjs'] },
        ...overrides,
      },
    }
  }

  it('maps published exports and bins back to their sources', () => {
    const fileSet = new Set(files)
    const byDir = (dir) => workspaces.find((workspace) => workspace.dir === dir)
    assert.deepEqual(publishedEntries(byDir('packages/engine'), fileSet), [
      { specifier: '@x/engine', source: 'src/index.ts' },
      { specifier: '@x/engine/export', source: 'src/export/index.ts' },
    ])
    assert.deepEqual(publishedEntries(byDir('packages/color'), fileSet), [
      { specifier: '@x/color', source: 'src/index.ts' },
    ])
    assert.deepEqual(publishedEntries(byDir('packages/cli'), fileSet), [
      { specifier: '@x/cli/load', source: 'load.mjs' },
      { specifier: 'bin x', source: 'bin/x.mjs' },
    ])
  })

  it('accepts a configuration that names every published entry', () => {
    assert.deepEqual(
      checkKnipConfig({ config: config(), files, workspaces }),
      [],
    )
  })

  it('reports a published export or bin without a knip entry', () => {
    const problems = checkKnipConfig({
      config: config({
        'packages/engine': {
          entry: ['src/index.ts'],
          project: ['src/**/*.ts'],
        },
        'packages/cli': { entry: ['load.mjs'] },
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

describe('the committed configuration', () => {
  it('covers every workspace package and published entry', () => {
    const files = listRepoFiles(repoRoot)
    const config = JSON.parse(
      readFileSync(new URL('knip.json', import.meta.url), 'utf8'),
    )
    const workspaces = readWorkspacePackages(files, (path) =>
      readFileSync(`${repoRoot}${path}`, 'utf8'),
    )
    assert.deepEqual(checkKnipConfig({ config, files, workspaces }), [])
  })

  it('keeps the baseline canonical', () => {
    const text = readFileSync(new URL('baseline.json', import.meta.url), 'utf8')
    const value = parseBaseline(JSON.parse(text))
    assert.equal(formatBaseline(value), text.replaceAll('\r\n', '\n'))
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
    assert.ok(test >= 0 && install >= 0 && run > install)

    const manifest = JSON.parse(readFileSync(`${repoRoot}package.json`, 'utf8'))
    assert.equal(
      manifest.scripts['check:structure'],
      'node scripts/quality/check-structure.mjs',
    )
    assert.match(manifest.devDependencies.knip, /^\d+\.\d+\.\d+$/)
    assert.match(manifest.devDependencies.madge, /^\d+\.\d+\.\d+$/)
  })
})
