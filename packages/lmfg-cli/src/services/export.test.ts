// @vitest-environment node
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, expect, it } from 'vitest'

import { createLmfgRuntime } from '../runtime/node-runtime'
import { loadSourceFile } from '../runtime/source-loader'
import { parseRenderParams } from '../schemas/params'
import {
  describeWithFixture,
  FIXTURE_PATH,
} from '../test-support/describe-with-fixture'
import { runFullResolutionExport } from './export'

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'lmfg-export-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describeWithFixture('runFullResolutionExport', () => {
  it('streams the full-resolution JPEG with EXIF to disk and reports progress', async () => {
    const runtime = createLmfgRuntime({ memoryProfile: 'desktop' })
    const progress: number[] = []
    const outputPath = join(dir, 'exports', 'final.jpg')
    try {
      const source = await loadSourceFile(FIXTURE_PATH, '/')
      const result = await runFullResolutionExport({
        runtime,
        source,
        params: parseRenderParams({ exposure_ev: 0.3 }),
        lut: null,
        exposure: null,
        quality: 90,
        outputPath,
        preferredRows: 512,
        onProgress: (p) => {
          progress.push(p.progress)
        },
      })
      expect(result.path).toBe(outputPath)
      expect(result.width).toBe(4032)
      expect(result.height).toBe(3024)
      expect(result.byteLength).toBeGreaterThan(1_000_000)
      expect(result.sha256).toMatch(/^[0-9a-f]{64}$/)
      expect(result.strips).toBeGreaterThan(1)
      expect(progress.at(-1)).toBe(99)
      expect(result.exposure.source).toBe('dng-baseline')
      expect(result.resource.max_rss_bytes).toBeGreaterThan(0)
      const jpeg = await readFile(outputPath)
      expect(jpeg.byteLength).toBe(result.byteLength)
      expect(createHash('sha256').update(jpeg).digest('hex')).toBe(
        result.sha256,
      )
      expect(Buffer.from(jpeg.subarray(0, 64)).toString('latin1')).toContain(
        'Exif',
      )
      expect(jpeg[jpeg.byteLength - 2]).toBe(0xFF)
      expect(jpeg[jpeg.byteLength - 1]).toBe(0xD9)
      expect(await readdir(join(dir, 'exports'))).toEqual(['final.jpg'])
    } finally {
      runtime.dispose()
    }
  }, 120_000)
})
