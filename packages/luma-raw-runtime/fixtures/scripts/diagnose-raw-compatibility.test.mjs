import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  defaultReportPath,
  parseArgs,
  preflightCachedFixtures,
  reportPayload,
  requireNativeArtifacts,
} from './diagnose-raw-compatibility.mjs'

describe('diagnose RAW compatibility CLI', () => {
  it('parses default CI-smoke selection', () => {
    expect(parseArgs([])).toEqual({
      all: false,
      purpose: 'ci-smoke',
      profile: 'desktop',
      output: undefined,
    })
  })

  it('parses all local fixture diagnostics', () => {
    expect(
      parseArgs([
        '--all',
        '--profile=low-memory',
        '--output=/tmp/report.json',
      ]),
    ).toEqual({
      all: true,
      purpose: undefined,
      profile: 'low-memory',
      output: '/tmp/report.json',
    })
  })

  it('rejects conflicting fixture selectors', () => {
    expect(() => parseArgs(['--all', '--purpose=ci-smoke'])).toThrow(
      'Use either --all or --purpose=<purpose>, not both.',
    )
  })

  it('uses the ignored reports cache as the default output path', () => {
    expect(defaultReportPath('/repo/packages/luma-raw-runtime/fixtures')).toBe(
      '/repo/packages/luma-raw-runtime/fixtures/.cache/reports/mobile-raw-compatibility.json',
    )
  })

  it('wraps entries in a stable report envelope', () => {
    expect(
      reportPayload({
        generatedAt: '2026-05-03T00:00:00.000Z',
        entries: [{ fixture: { name: 'raw' }, classification: 'supported' }],
      }),
    ).toEqual({
      schemaVersion: 1,
      generatedAt: '2026-05-03T00:00:00.000Z',
      entries: [{ fixture: { name: 'raw' }, classification: 'supported' }],
    })
  })

  it('reports missing cached fixtures before native diagnostics loading', async () => {
    const fixturesDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'luma-raw-fixtures-'),
    )

    await expect(
      preflightCachedFixtures(
        [{ name: 'raw', file: 'raw.dng' }],
        fixturesDir,
      ),
    ).rejects.toThrow(
      `Missing cached fixture raw: ${path.join(
        fixturesDir,
        '.cache',
        'public',
        'raw.dng',
      )}\nRun pnpm --filter @lumaforge/luma-raw-runtime fixtures:fetch-public for CI fixtures or fixtures:fetch-public:all for local compatibility fixtures.`,
    )
  })

  it('reports missing native diagnostics artifacts with build guidance', async () => {
    const packageDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'luma-raw-package-'),
    )
    const expectedPath = path.join(
      packageDir,
      'dist',
      'native',
      'low-memory',
      'luma_raw.js',
    )

    await expect(
      requireNativeArtifacts({ packageDir, profile: 'low-memory' }),
    ).rejects.toThrow(
      `Missing native diagnostics artifact: ${expectedPath}\nRun pnpm --filter @lumaforge/luma-raw-runtime build:native:low-memory and pnpm --filter @lumaforge/luma-raw-runtime build before diagnostics.`,
    )
  })
})
