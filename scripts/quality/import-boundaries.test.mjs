import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { ESLint } from 'eslint'
import { describe, expect, it } from 'vitest'

import { IMPORT_BOUNDARIES } from '../../plugins/eslint-import-boundaries.mjs'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const RULE = 'lumaforge/import-boundaries'
const RP = 'src/modules/raw-processor'

const eslint = new ESLint({
  cwd: ROOT,
  ruleFilter: ({ ruleId }) => ruleId === RULE,
})

/** The boundary names reported for `code` linted as repository file `file`. */
async function reports(file, code) {
  const [result] = await eslint.lintText(code, { filePath: join(ROOT, file) })
  expect(result.messages.filter((message) => message.fatal)).toEqual([])
  return result.messages.map(
    (message) => /\(([a-z-]+)\): /.exec(message.message)?.[1],
  )
}

const named = (specifier) =>
  `import { value } from '${specifier}'\nvoid value\n`

/** Every import form the code uses, as code that imports `specifier`. */
const IMPORT_FORMS = {
  'named import': named,
  'type-only import': (s) =>
    `import type { V } from '${s}'\nexport type T = V\n`,
  'side-effect import': (s) => `import '${s}'\n`,
  're-export': (s) => `export { value } from '${s}'\n`,
  'star re-export': (s) => `export * from '${s}'\n`,
  'dynamic import': (s) => `export const load = () => import('${s}')\n`,
  'import type query': (s) => `export type T = typeof import('${s}')\n`,
  'vitest mock': (s) => `vi.mock('${s}')\n`,
  'vitest actual import': (s) => `export const a = vi.importActual('${s}')\n`,
  'worker URL': (s) => `export const u = new URL('${s}', import.meta.url)\n`,
}

/** For each boundary: an importer, a specifier it refuses, and one it allows. */
const FIXTURES = [
  [
    'domain-logic',
    `${RP}/services/look/probe.ts`,
    '../../hooks/useOnlineLutSources',
    '../../model/session',
  ],
  [
    'domain-logic',
    'src/lib/export/probe.ts',
    'sonner',
    '@lumaforge/render-engine/export',
  ],
  [
    'app-library',
    'src/lib/preview/probe.ts',
    '~/modules/raw-processor/model/session',
    '~/lib/webgpu/contract',
  ],
  [
    'package-independence',
    'packages/render-engine/src/export/probe.ts',
    '~/lib/preview/preview-view',
    './geometry/matrix',
  ],
  [
    'mobile-surface',
    `${RP}/components/mobile/Probe.tsx`,
    '../tools/HSLTool',
    '../shared/segmented-chrome',
  ],
  [
    'desktop-surface',
    `${RP}/components/tools/lut/Probe.tsx`,
    '../../mobile/MobileLabChrome',
    '../../shared/slider-tracks',
  ],
  [
    'preview-mechanics',
    `${RP}/hooks/preview/probe.ts`,
    '../../components/PreviewCanvas',
    '../../services/preview/preview-canvas-helpers',
  ],
  [
    'color-runtime',
    'packages/luma-color-runtime/src/probe.ts',
    '@lumaforge/luma-raw-runtime/node',
    './types',
  ],
  [
    'color-runtime',
    'packages/luma-color-runtime/src/probe.ts',
    'node:fs',
    'fast-check',
  ],
  [
    'color-runtime',
    'packages/luma-color-runtime/src/probe.ts',
    'react-dom/client',
    '../src',
  ],
  [
    'geometry-kernel',
    'packages/render-engine/src/geometry/index.ts',
    '../export/geometry/export-geometry',
    '../export/geometry/matrix',
  ],
  [
    'geometry-kernel',
    'packages/render-engine/src/export/geometry/matrix.ts',
    '@lumaforge/luma-color-runtime',
    './matrix',
  ],
]

describe('import boundaries', () => {
  it('has a fixture for every boundary', () => {
    expect(new Set(FIXTURES.map(([boundary]) => boundary))).toEqual(
      new Set(IMPORT_BOUNDARIES.map(({ name }) => name)),
    )
  })

  for (const [boundary, importer, refused, allowed] of FIXTURES) {
    it(`${boundary}: ${importer} refuses ${refused}, allows ${allowed}`, async () => {
      expect(await reports(importer, named(refused))).toEqual([boundary])
      expect(await reports(importer, named(allowed))).toEqual([])
    })
  }

  for (const [form, write] of Object.entries(IMPORT_FORMS)) {
    it(`reads a ${form}`, async () => {
      const importer = `${RP}/components/tools/Probe.tsx`
      expect(
        await reports(importer, write('../mobile/MobileLabChrome?worker')),
      ).toEqual(['desktop-surface'])
      expect(await reports(importer, write('../shared/slider-tracks'))).toEqual(
        [],
      )
    })
  }

  it('reports a src/lib import of module hooks under both lib boundaries', async () => {
    expect(
      await reports(
        'src/lib/export/probe.ts',
        named('~/modules/raw-processor/hooks/useRawToolState'),
      ),
    ).toEqual(['domain-logic', 'app-library'])
  })

  it('leaves runtime purity to runtime files, and ownership to tests too', async () => {
    const test = 'packages/luma-color-runtime/src/probe.test.ts'
    expect(await reports(test, named('node:fs'))).toEqual([])
    expect(await reports(test, named('~/lib/preview/preview-view'))).toEqual([
      'package-independence',
    ])
    expect(
      await reports(
        `${RP}/components/mobile/Probe.test.tsx`,
        named('../tools/HSLTool'),
      ),
    ).toEqual(['mobile-surface'])
  })
})
