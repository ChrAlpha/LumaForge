// @vitest-environment node
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { ESLint } from 'eslint'

import {
  IMPORT_BOUNDARIES,
  resolveImportTarget,
} from '../../plugins/eslint-import-boundaries.mjs'

// Runs under `node --test` and under the Vitest app gate.
const runner = process.env.VITEST
  ? await import('vitest')
  : await import('node:test')
const { describe, it } = runner
const before = runner.before ?? runner.beforeAll
const after = runner.after ?? runner.afterAll

const repoRoot = fileURLToPath(new URL('../../', import.meta.url))
const RULE = 'lumaforge/import-boundaries'
const RP = 'src/modules/raw-processor'

/** The repository's own ESLint config, reporting only the boundary rule. */
let eslint
before(() => {
  eslint = new ESLint({
    cwd: repoRoot,
    ruleFilter: ({ ruleId }) => ruleId === RULE,
  })
})

/** The boundary names reported for `code` linted as repository file `file`. */
async function boundaryReports(file, code) {
  const [result] = await eslint.lintText(code, {
    filePath: join(repoRoot, file),
  })
  const fatal = result.messages.filter((message) => message.fatal)
  assert.deepEqual(fatal, [], `${file} did not parse`)
  return result.messages
    .filter((message) => message.ruleId === RULE)
    .map((message) => /\(([a-z-]+)\): /.exec(message.message)?.[1])
}

/** A specifier for repository path `target` relative to importer `file`. */
function relativeSpecifier(file, target) {
  const from = file.split('/').slice(0, -1)
  const to = target.split('/')
  let shared = 0
  while (shared < from.length && from[shared] === to[shared]) shared += 1
  const up = from.length - shared
  const rest = to.slice(shared).join('/')
  return up === 0 ? `./${rest}` : `${'../'.repeat(up)}${rest}`
}

function withoutExtension(path) {
  return path.replace(/\.[cm]?[jt]sx?$/, '')
}

/**
 * Every import form the rule reads, as code that imports `specifier`. Each
 * one is a separate mutation: it must be reported once per boundary.
 */
const IMPORT_SYNTAXES = Object.freeze({
  'default import': (s) => `import value from '${s}'\nvoid value\n`,
  'named import': (s) => `import { value } from '${s}'\nvoid value\n`,
  'namespace import': (s) => `import * as ns from '${s}'\nvoid ns\n`,
  'side-effect import': (s) => `import '${s}'\n`,
  'type-only import': (s) =>
    `import type { Value } from '${s}'\nexport type T = Value\n`,
  'inline type import': (s) =>
    `import { type Value } from '${s}'\nexport type T = Value\n`,
  'named re-export': (s) => `export { value } from '${s}'\n`,
  'type re-export': (s) => `export type { Value } from '${s}'\n`,
  'star re-export': (s) => `export * from '${s}'\n`,
  'namespace re-export': (s) => `export * as ns from '${s}'\n`,
  'dynamic import': (s) => `export const load = () => import('${s}')\n`,
  'template dynamic import': (s) =>
    `export const load = () => import(\`${s}\`)\n`,
  'import type query': (s) => `export type T = import('${s}').Value\n`,
  'import equals require': (s) =>
    `import value = require('${s}')\nvoid value\n`,
  'require call': (s) => `export const value = require('${s}')\n`,
  'require resolve': (s) => `export const path = require.resolve('${s}')\n`,
  'vitest module mock': (s) => `vi.mock('${s}')\n`,
  'vitest actual import': (s) =>
    `export const load = () => vi.importActual('${s}')\n`,
  'worker URL': (s) => `export const url = new URL('${s}', import.meta.url)\n`,
  'reference path': (s) => `/// <reference path="${s}" />\nexport {}\n`,
})

/**
 * One fixture per boundary: an importer, a target it must refuse, and a
 * neighbouring target it must allow, so each mutation shows the rule tells
 * them apart rather than refusing everything.
 */
const BOUNDARY_FIXTURES = Object.freeze([
  {
    boundary: 'domain-logic',
    importer: `${RP}/services/look/probe.ts`,
    refused: `${RP}/hooks/useOnlineLutSources.ts`,
    allowed: `${RP}/model/session.ts`,
  },
  {
    boundary: 'domain-logic',
    importer: `${RP}/services/export/probe.ts`,
    refused: `${RP}/components/Dropzone.tsx`,
    allowed: `${RP}/services/export/export-system.ts`,
  },
  {
    boundary: 'domain-logic',
    importer: `${RP}/services/export/probe.ts`,
    refused: 'src/components/ui/button/Button.tsx',
    allowed: 'src/lib/export/export-plan.ts',
  },
  {
    boundary: 'domain-logic',
    importer: `${RP}/services/look/probe.ts`,
    refused: 'src/hooks/common/useViewport.ts',
    allowed: 'src/lib/webgpu/contract.ts',
  },
  {
    boundary: 'domain-logic',
    importer: 'src/lib/export/probe.ts',
    refused: 'src/components/common/LocaleToggle.tsx',
    allowed: 'src/lib/export/export-plan.ts',
  },
  {
    boundary: 'domain-logic',
    importer: 'src/lib/export/probe.ts',
    refused: 'src/hooks/common/useViewport.ts',
    allowed: 'src/lib/preview/preview-view.ts',
  },
  {
    boundary: 'app-library',
    importer: 'src/lib/preview/probe.ts',
    refused: `${RP}/model/session.ts`,
    allowed: 'src/lib/webgpu/contract.ts',
  },
  {
    boundary: 'package-independence',
    importer: 'packages/render-engine/src/export/probe.ts',
    refused: 'src/lib/preview/preview-view.ts',
    allowed: 'packages/render-engine/src/export/geometry/matrix.ts',
  },
  {
    boundary: 'package-independence',
    importer: 'packages/lmfg-cli/src/services/probe.ts',
    refused: 'src/lib/export/export-plan.ts',
    allowed: 'packages/lmfg-cli/src/protocol/exit-codes.ts',
  },
  {
    boundary: 'mobile-surface',
    importer: `${RP}/components/mobile/Probe.tsx`,
    refused: `${RP}/components/tools/HSLTool.tsx`,
    allowed: `${RP}/components/shared/segmented-chrome.ts`,
  },
  {
    boundary: 'desktop-surface',
    importer: `${RP}/components/tools/lut/Probe.tsx`,
    refused: `${RP}/components/mobile/MobileLabChrome.tsx`,
    allowed: `${RP}/components/shared/slider-tracks.ts`,
  },
  {
    boundary: 'preview-mechanics',
    importer: `${RP}/hooks/preview/probe.ts`,
    refused: `${RP}/components/PreviewCanvas.tsx`,
    allowed: `${RP}/services/preview/preview-canvas-helpers.ts`,
  },
  {
    boundary: 'color-runtime',
    importer: 'packages/luma-color-runtime/src/probe.ts',
    refused: 'packages/luma-raw-runtime/src/index.ts',
    allowed: 'packages/luma-color-runtime/src/types.ts',
  },
  {
    boundary: 'geometry-kernel',
    importer: 'packages/render-engine/src/geometry/index.ts',
    refused: 'packages/render-engine/src/export/geometry/export-geometry.ts',
    allowed: 'packages/render-engine/src/export/geometry/matrix.ts',
  },
])

/** Bare package imports each boundary refuses, and one it allows. */
const PACKAGE_FIXTURES = Object.freeze([
  {
    boundary: 'domain-logic',
    importer: `${RP}/services/export/probe.ts`,
    refused: ['sonner', 'sonner/dist/styles.css'],
    allowed: 'jotai',
  },
  {
    boundary: 'domain-logic',
    importer: 'src/lib/export/probe.ts',
    refused: ['sonner'],
    allowed: '@lumaforge/render-engine/export',
  },
  {
    boundary: 'color-runtime',
    importer: 'packages/luma-color-runtime/src/probe.ts',
    refused: [
      '@lumaforge/luma-raw-runtime',
      '@lumaforge/luma-jpeg-runtime',
      'node:fs',
      'fs',
      'react',
      'react-dom/client',
      'jotai',
    ],
    allowed: './types',
  },
  {
    boundary: 'geometry-kernel',
    importer: 'packages/render-engine/src/export/geometry/matrix.ts',
    refused: ['@lumaforge/luma-color-runtime', 'node:path'],
    allowed: './matrix',
  },
])

/** Boundaries an importer is subject to beyond the one under test. */
function expectedReports(fixture) {
  // A src/lib importer that reaches a module's components or hooks crosses
  // both lib boundaries at once.
  if (
    fixture.importer.startsWith('src/lib/') &&
    /^src\/modules\/[^/]+\/(?:components|hooks)\//.test(fixture.refused)
  ) {
    return ['domain-logic', 'app-library']
  }
  return [fixture.boundary]
}

describe('import boundary table', () => {
  it('declares every ownership boundary the app and packages rely on', () => {
    assert.deepEqual(
      [...new Set(IMPORT_BOUNDARIES.map((boundary) => boundary.name))].sort(),
      [
        'app-library',
        'color-runtime',
        'desktop-surface',
        'domain-logic',
        'geometry-kernel',
        'mobile-surface',
        'package-independence',
        'preview-mechanics',
      ],
    )
  })

  it('has a refusing fixture for every boundary', () => {
    const covered = new Set(
      BOUNDARY_FIXTURES.map((fixture) => fixture.boundary),
    )
    for (const { name } of IMPORT_BOUNDARIES) assert.ok(covered.has(name), name)
  })
})

describe('target resolution', () => {
  const importer = join(repoRoot, `${RP}/services/look/probe.ts`)

  it('resolves relative, alias, absolute and file URL specifiers to one source file', () => {
    const expected = {
      kind: 'path',
      path: `${RP}/hooks/useOnlineLutSources.ts`,
    }
    for (const specifier of [
      '../../hooks/useOnlineLutSources',
      '../../hooks/useOnlineLutSources.ts',
      '../../hooks/useOnlineLutSources.js',
      '../../services/../hooks/./useOnlineLutSources',
      '~/modules/raw-processor/hooks/useOnlineLutSources',
      join(repoRoot, `${RP}/hooks/useOnlineLutSources`),
      `/${RP}/hooks/useOnlineLutSources`,
      `/@fs${join(repoRoot, `${RP}/hooks/useOnlineLutSources.ts`)}`,
      pathToFileURL(join(repoRoot, `${RP}/hooks/useOnlineLutSources.ts`)).href,
      '../../hooks/useOnlineLutSources?worker&url',
    ]) {
      assert.deepEqual(
        resolveImportTarget(specifier, importer, repoRoot),
        expected,
        specifier,
      )
    }
  })

  it('resolves a root-relative specifier against the Vite root of its importer', () => {
    assert.deepEqual(
      resolveImportTarget(
        '/src/export/geometry/export-geometry',
        join(repoRoot, 'packages/render-engine/src/geometry/index.ts'),
        repoRoot,
      ),
      {
        kind: 'path',
        path: 'packages/render-engine/src/export/geometry/export-geometry.ts',
      },
    )
    assert.deepEqual(
      resolveImportTarget(
        '/src/lib/preview/preview-view',
        join(repoRoot, 'packages/render-engine/src/export/probe.ts'),
        repoRoot,
      ),
      { kind: 'path', path: 'src/lib/preview/preview-view.ts' },
    )
  })

  it('resolves a directory import to its index file', () => {
    assert.deepEqual(
      resolveImportTarget('../../components', importer, repoRoot),
      { kind: 'path', path: `${RP}/components/index.ts` },
    )
  })

  it('names bare packages, scoped packages and Node built-ins', () => {
    assert.deepEqual(resolveImportTarget('sonner', importer, repoRoot), {
      kind: 'package',
      name: 'sonner',
    })
    assert.deepEqual(
      resolveImportTarget('react-dom/client', importer, repoRoot),
      {
        kind: 'package',
        name: 'react-dom',
      },
    )
    assert.deepEqual(
      resolveImportTarget('@scope/pkg/sub', importer, repoRoot),
      {
        kind: 'package',
        name: '@scope/pkg',
      },
    )
    assert.deepEqual(resolveImportTarget('fs/promises', importer, repoRoot), {
      kind: 'package',
      name: 'node:fs/promises',
    })
  })

  it('resolves workspace package aliases to their source', () => {
    assert.deepEqual(
      resolveImportTarget(
        '@lumaforge/render-engine/geometry',
        importer,
        repoRoot,
      ),
      { kind: 'path', path: 'packages/render-engine/src/geometry/index.ts' },
    )
  })
})

describe('boundary detection', () => {
  for (const fixture of BOUNDARY_FIXTURES) {
    const { boundary, importer, refused, allowed } = fixture
    describe(`${boundary}: ${importer} -> ${refused}`, () => {
      const specifier = withoutExtension(relativeSpecifier(importer, refused))
      const allowedSpecifier = withoutExtension(
        relativeSpecifier(importer, allowed),
      )

      for (const [syntax, write] of Object.entries(IMPORT_SYNTAXES)) {
        it(`refuses a ${syntax} and allows its neighbour`, async () => {
          assert.deepEqual(
            await boundaryReports(importer, write(specifier)),
            expectedReports(fixture),
          )
          assert.deepEqual(
            await boundaryReports(importer, write(allowedSpecifier)),
            [],
          )
        })
      }

      const bypasses = {
        'a relative detour': specifier.replace(
          /^((?:\.\.\/)+|\.\/)/,
          '$1detour/../',
        ),
        'an absolute path': join(repoRoot, refused),
        'a Vite root-relative path': `/${withoutExtension(refused)}`,
        'a file URL': pathToFileURL(join(repoRoot, refused)).href,
        'a query suffix': `${specifier}?url`,
        'a .js extension': `${specifier}.js`,
      }
      if (refused.startsWith('src/')) {
        bypasses['the ~ alias'] =
          `~/${withoutExtension(refused.slice('src/'.length))}`
      }
      for (const [name, bypass] of Object.entries(bypasses)) {
        it(`refuses ${name} (${bypass})`, async () => {
          assert.deepEqual(
            await boundaryReports(
              importer,
              IMPORT_SYNTAXES['named import'](bypass),
            ),
            expectedReports(fixture),
          )
        })
      }
    })
  }

  for (const { boundary, importer, refused, allowed } of PACKAGE_FIXTURES) {
    describe(`${boundary}: ${importer} -> packages`, () => {
      for (const name of refused) {
        it(`refuses ${name} in every import form`, async () => {
          for (const [syntax, write] of Object.entries(IMPORT_SYNTAXES)) {
            if (syntax === 'reference path') continue
            assert.deepEqual(
              await boundaryReports(importer, write(name)),
              [boundary],
              syntax,
            )
          }
        })
      }

      it(`allows ${allowed}`, async () => {
        assert.deepEqual(
          await boundaryReports(
            importer,
            IMPORT_SYNTAXES['named import'](allowed),
          ),
          [],
        )
      })
    })
  }

  it('refuses a package resolved through node_modules by a relative path', async () => {
    assert.deepEqual(
      await boundaryReports(
        `${RP}/services/export/probe.ts`,
        IMPORT_SYNTAXES['named import']('../../../../../node_modules/sonner'),
      ),
      ['domain-logic'],
    )
  })

  describe('a symlink', () => {
    let linkDir
    before(() => {
      linkDir = mkdtempSync(join(tmpdir(), 'lf-import-boundaries-'))
      symlinkSync(join(repoRoot, `${RP}/hooks`), join(linkDir, 'hooks'))
    })
    after(() => rmSync(linkDir, { recursive: true, force: true }))

    it('cannot rename a boundary away', async () => {
      assert.deepEqual(
        await boundaryReports(
          `${RP}/services/look/probe.ts`,
          IMPORT_SYNTAXES['named import'](
            join(linkDir, 'hooks/useOnlineLutSources'),
          ),
        ),
        ['domain-logic'],
      )
    })
  })

  it('leaves dynamic imports it cannot read statically alone', async () => {
    assert.deepEqual(
      await boundaryReports(
        `${RP}/services/look/probe.ts`,
        [
          'export const load = (name: string) => [',
          '  import(name),',
          // The linted template literal keeps its `${name}` substitution.
          `  import(\`../../hooks/${'$'}{name}\`),`,
          ']',
          '',
        ].join('\n'),
      ),
      [],
    )
  })

  it('applies runtime purity boundaries to runtime files only', async () => {
    assert.deepEqual(
      await boundaryReports(
        'packages/luma-color-runtime/src/probe.test.ts',
        IMPORT_SYNTAXES['named import']('node:fs'),
      ),
      [],
    )
    assert.deepEqual(
      await boundaryReports(
        'packages/luma-color-runtime/src/probe.test.ts',
        IMPORT_SYNTAXES['named import']('~/lib/preview/preview-view'),
      ),
      ['package-independence'],
    )
  })

  it('holds tests to the ownership boundaries of the code they live with', async () => {
    assert.deepEqual(
      await boundaryReports(
        `${RP}/components/mobile/Probe.test.tsx`,
        IMPORT_SYNTAXES['named import']('../tools/transform-feature.fixture'),
      ),
      ['mobile-surface'],
    )
    assert.deepEqual(
      await boundaryReports(
        'src/lib/preview/probe.test.ts',
        IMPORT_SYNTAXES['type-only import'](
          '~/modules/raw-processor/model/session',
        ),
      ),
      ['app-library'],
    )
  })
})

describe('lint coverage', () => {
  const manifest = JSON.parse(
    readFileSync(join(repoRoot, 'package.json'), 'utf8'),
  )

  it('lints browser specs, benchmarks and package bins with the boundary rule', async () => {
    for (const script of [
      manifest.scripts.lint,
      manifest.scripts['lint:check'],
    ]) {
      assert.match(script, /"tests\/\*\*\/\*\.\{js,mjs,cjs,ts,tsx\}"/)
      assert.match(script, /"packages\/\*\/\{[^}]*\bbin\b[^}]*\}\//)
      assert.match(script, /"packages\/\*\/\{[^}]*\bbenchmarks\b[^}]*\}\//)
      assert.match(script, /"scripts\/\*\*\//)
    }
    for (const file of [
      'tests/browser/raw-p0-safety.spec.ts',
      'packages/luma-raw-runtime/benchmarks/bench-runtime.ts',
      'packages/lmfg-cli/benchmarks/large-file-validation.mjs',
      'packages/lmfg-cli/bin/lmfg.mjs',
      'scripts/benchmarks/jpeg-runtime.ts',
      `${RP}/services/look/lut-entry-progress.test.ts`,
      'packages/render-engine/src/geometry/index.ts',
    ]) {
      const path = join(repoRoot, file)
      assert.equal(await eslint.isPathIgnored(path), false, file)
      const config = await eslint.calculateConfigForFile(path)
      assert.deepEqual([config.rules[RULE]].flat().slice(0, 1), [2], file)
    }
  })

  it('runs the boundary tests and lint on every change in CI', () => {
    const workflow = readFileSync(
      join(repoRoot, '.github/workflows/build.yml'),
      'utf8',
    )
    const start = workflow.search(/^ {2}quality:\r?$/m)
    assert.notEqual(start, -1, 'quality is not a job')
    const rest = workflow.slice(start + 1)
    const end = rest.search(/^ {2}\w[\w-]*:\r?$/m)
    const quality = end === -1 ? rest : rest.slice(0, end)
    // The quality job carries no path gate, so every change reaches it.
    assert.doesNotMatch(quality, /^ {4}if:/m)
    const commands = Array.from(
      quality.matchAll(/^\s+run: (.+)\r?$/gm),
      ([, run]) => run,
    )
    assert.ok(
      commands.includes(
        'node --test scripts/quality/import-boundaries.test.mjs',
      ),
    )
    assert.ok(commands.includes('pnpm lint:check'))
  })
})
