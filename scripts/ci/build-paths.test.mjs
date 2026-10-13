// @vitest-environment node
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

// Runs under `node --test` and under the Vitest app gate.
const { describe, it } = process.env.VITEST
  ? await import('vitest')
  : await import('node:test')

// The patterns are read from the committed workflow so the gate selection
// under test is the one CI runs, never a second copy.
const workflow = readFileSync(
  fileURLToPath(new URL('../../.github/workflows/build.yml', import.meta.url)),
  'utf8',
)

function readPatterns() {
  const patterns = new Map()
  for (const [, name, source] of workflow.matchAll(
    /^\s*(force_all|\w+_paths)='([^']*)'\r?$/gm,
  )) {
    // The workflow evaluates these with `grep -E`; outside `\.` escapes and
    // bracket expressions, ERE and JavaScript agree on this syntax.
    assert.doesNotMatch(
      source.replaceAll(String.raw`\.`, ''),
      /[[\\]/,
      `${name} uses syntax whose grep -E meaning differs from JavaScript`,
    )
    patterns.set(name, new RegExp(source))
  }
  return patterns
}

const patterns = readPatterns()
const forceAll = patterns.get('force_all')
const gateRules = Array.from(
  workflow.matchAll(/if matches "\$(\w+)"; then (\w+)=true; fi/g),
  ([, patternName, gate]) => {
    assert.ok(patterns.has(patternName), `${patternName} is not defined`)
    return { gate, pattern: patterns.get(patternName) }
  },
)
const allGates = gateRules.map(({ gate }) => gate)

function selectGates(changedFiles) {
  const matches = (pattern) => changedFiles.some((file) => pattern.test(file))
  if (matches(forceAll)) return [...allGates].sort()
  return gateRules
    .filter(({ pattern }) => matches(pattern))
    .map(({ gate }) => gate)
    .sort()
}

function jobBody(job) {
  const start = workflow.search(new RegExp(String.raw`^  ${job}:\r?$`, 'm'))
  assert.notEqual(start, -1, `${job} is not a job`)
  const rest = workflow.slice(start + 1)
  const end = rest.search(/^ {2}\w[\w-]*:\r?$/m)
  return end === -1 ? rest : rest.slice(0, end)
}

/** The `run:` commands of one job, in workflow order. */
function jobCommands(job) {
  return Array.from(
    jobBody(job).matchAll(/^\s+run: (.+)\r?$/gm),
    ([, run]) => run,
  )
}

/** The always-on quality job plus every gate the change selects. */
function jobsRunFor(file) {
  assert.doesNotMatch(jobBody('quality'), /^ {4}if:/m)
  return ['quality', ...selectGates([file])]
}

describe('build workflow gate selection', () => {
  it('reads every gate from the workflow', () => {
    assert.ok(forceAll, 'force_all is not defined')
    assert.deepEqual([...allGates].sort(), [
      'app',
      'cli',
      'native',
      'runtime',
      'webgpu',
    ])
  })

  const cases = [
    // Render engine sources are aliased into the app bundle.
    ['packages/render-engine/src/export/index.ts', ['app', 'cli', 'runtime']],
    [
      'packages/render-engine/src/preview/preview-render.ts',
      ['app', 'cli', 'runtime', 'webgpu'],
    ],
    // Vite and ESLint configs import the local plugins.
    ['plugins/isolation-headers.ts', ['app']],
    ['scripts/ci/build-paths.test.mjs', ['app']],
    ['src/modules/raw-processor/RawProcessorView.tsx', ['app']],
    ['src/lib/transform/transform-render.ts', ['app']],
    ['src/lib/export/full-res-export.ts', ['app', 'runtime']],
    ['src/lib/webgpu/device.ts', ['app', 'webgpu']],
    ['tests/browser/raw-hsl-smoke.spec.ts', ['app']],
    // Both typecheck projects are app paths.
    ['tsconfig.tooling.json', ['app']],
    ['tests/browser/tsconfig.json', ['app']],
    ['scripts/deploy/check.mjs', ['app']],
    ['vite.config.ts', ['app']],
    [
      'packages/luma-color-runtime/src/index.ts',
      ['app', 'cli', 'runtime', 'webgpu'],
    ],
    [
      'packages/luma-raw-runtime/native/libraw_wrapper.cpp',
      ['app', 'cli', 'native', 'runtime'],
    ],
    [
      'scripts/native-runtime/prepare-native-assets.mjs',
      ['app', 'cli', 'native', 'runtime'],
    ],
    ['packages/luma-native-artifacts/package.json', ['cli']],
    ['packages/lmfg-cli/src/cli.ts', ['cli']],
    ['packages/lmfg-mcp/src/export-detail.ts', ['cli']],
    ['scripts/webgpu/validate.mjs', ['webgpu']],
    ['docs/USER_GUIDE.md', []],
    ['README.md', []],
    ['.github/workflows/deploy.yml', []],
    ['package.json', ['app', 'cli', 'native', 'runtime', 'webgpu']],
    ['pnpm-lock.yaml', ['app', 'cli', 'native', 'runtime', 'webgpu']],
    [
      '.github/workflows/build.yml',
      ['app', 'cli', 'native', 'runtime', 'webgpu'],
    ],
  ]

  for (const [file, expected] of cases) {
    it(`selects [${expected.join(', ')}] for ${file}`, () => {
      assert.deepEqual(selectGates([file]), expected)
    })
  }

  it('unions gates across a mixed change set', () => {
    assert.deepEqual(
      selectGates(['docs/USER_GUIDE.md', 'plugins/isolation-headers.ts']),
      ['app'],
    )
    assert.deepEqual(
      selectGates([
        'packages/lmfg-cli/src/cli.ts',
        'scripts/webgpu/validate.mjs',
      ]),
      ['cli', 'webgpu'],
    )
  })
})

describe('build workflow checks', () => {
  // Never path-selected, so a manifest change in any package fails here even
  // when no app gate runs.
  it('checks the test-project discovery in quality', () => {
    const commands = jobCommands('quality')
    assert.ok(
      commands.includes(
        'node --test scripts/quality/test-project-discovery.test.mjs',
      ),
    )
  })

  // One file per kind of tooling-project entry: top-level and nested scripts,
  // and root configs that no path filter names.
  for (const file of [
    'scripts/benchmarks/jpeg-runtime.ts',
    'playwright.config.ts',
    'vite.config.test.ts',
  ]) {
    it(`typechecks ${file} in a job that runs for it`, () => {
      assert.ok(
        jobsRunFor(file).some((job) =>
          jobCommands(job).includes('pnpm typecheck:tooling'),
        ),
      )
    })
  }

  it('typechecks the browser specs in a job that runs for them', () => {
    assert.ok(
      jobsRunFor('tests/browser/raw-hsl-smoke.spec.ts').some((job) =>
        jobCommands(job).includes('pnpm typecheck:browser'),
      ),
    )
  })
})
