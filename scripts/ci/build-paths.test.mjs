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
    ['plugins/eslint-recursive-sort.js', ['app']],
    ['scripts/ci/build-paths.test.mjs', ['app']],
    ['src/modules/raw-processor/RawProcessorView.tsx', ['app']],
    ['src/modules/transform-demo/transform-render.ts', ['app']],
    ['src/lib/export/full-res-export.ts', ['app', 'runtime']],
    ['src/lib/webgpu/device.ts', ['app', 'webgpu']],
    ['tests/browser/raw-hsl-smoke.spec.ts', ['app']],
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
