import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { afterAll, describe, expect, it } from 'vitest'

import {
  checkPublicSurface,
  checkSupportedReaders,
  scanSources,
} from './check-retired-api.mjs'

const scan = (files) =>
  scanSources({ files: Object.keys(files), readFile: (path) => files[path] })

describe('check-retired-api', () => {
  it('fails retired identifiers and @deprecated tags outside tests', () => {
    expect(
      scan({
        'src/a.ts': 'const x: RenderBudget = 1 // RenderBudgetLike\n',
        'docs/a.md': 'RenderBudget, @deprecated in prose\n',
        'src/b.ts': '/** @deprecated */\n',
        'src/a.test.ts': 'RenderBudget @deprecated\n',
        'packages/x/CHANGELOG.md': 'RenderBudget\n',
      }),
    ).toEqual([
      'src/a.ts:1 names retired RenderBudget',
      'docs/a.md:1 names retired RenderBudget',
      'src/b.ts:1 declares @deprecated; remove the export instead',
    ])
  })

  it('fails a supported device-data reader that is gone', () => {
    const readers = [{ file: 'src/r.ts', data: 'outputs', names: ['readOld'] }]
    const check = (files) =>
      checkSupportedReaders({
        files: Object.keys(files),
        readFile: (path) => files[path],
        readers,
      })
    expect(check({ 'src/r.ts': 'export const readOld = 1' })).toEqual([])
    expect(check({ 'src/r.ts': 'export const readOlder = 1' })).toEqual([
      'src/r.ts no longer has readOld, which reads outputs',
    ])
    expect(check({})).toEqual(['src/r.ts is gone, but it reads outputs'])
  })

  describe('public surface', () => {
    const root = mkdtempSync(join(tmpdir(), 'lf-retired-api-'))
    afterAll(() => rmSync(root, { recursive: true, force: true }))
    const files = {
      'engine/index.ts': "export * from './types'\nexport * from '@x/color'\n",
      'engine/types.ts':
        'export type Params = { tone: number } | { viewMode: 1 }\n',
      'engine/policy.ts':
        "export { Gone } from './gone'\nexport * from './missing'\n",
      'engine/gone.ts': 'export const Gone = 1\n',
      'color/index.ts': 'export interface Intent { tone: number }\n',
    }
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true })
      writeFileSync(join(root, path), text)
    }

    it('fails retired exports and members through re-exports and unions', () => {
      expect(
        checkPublicSurface({
          root,
          entries: {
            '@x/engine': {
              '.': 'engine/index.ts',
              './policy': 'engine/policy.ts',
            },
          },
          paths: { '@x/color': ['./color/index.ts'] },
          retiredExports: { '@x/engine': ['Gone'] },
          retiredMembers: {
            '@x/engine': { Params: ['viewMode'], Intent: ['tone'], Lost: [] },
          },
        }),
      ).toEqual([
        'engine/policy.ts re-exports ./missing, which does not resolve',
        '@x/engine Params has retired member viewMode',
        '@x/engine Intent has retired member tone',
        '@x/engine/policy exports retired Gone',
        '@x/engine exports no Lost; update its retired members',
      ])
    })
  })
})
