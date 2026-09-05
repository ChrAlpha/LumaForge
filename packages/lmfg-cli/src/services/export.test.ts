// @vitest-environment node
import { Buffer } from 'node:buffer'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { detectCapabilities } from '../runtime/capability'
import { createLmfgRuntime } from '../runtime/node-runtime'
import { loadSourceFile } from '../runtime/source-loader'
import { parseRenderParams } from '../schemas/params'
import { assertJpegBytes, runFullResolutionExport } from './export'

const FIXTURE = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../luma-raw-runtime/fixtures/.cache/public/raw-pixls-iphone-se.dng',
)
const ready =
  existsSync(FIXTURE) &&
  detectCapabilities({ memoryProfile: 'desktop' }).render_tiers.cpu_wasm
    .available
const d = ready ? describe : describe.skip

describe('assertJpegBytes', () => {
  it('accepts SOI..EOI and refuses anything else', () => {
    expect(() =>
      assertJpegBytes(new Uint8Array([0xFF, 0xD8, 0, 0xFF, 0xD9])),
    ).not.toThrow()
    expect(() => assertJpegBytes(new Uint8Array([1, 2, 3]))).toThrow(
      expect.objectContaining({ code: 'export.refused', exitCode: 8 }),
    )
    expect(() => assertJpegBytes(new Uint8Array())).toThrow(
      expect.objectContaining({ code: 'export.refused' }),
    )
  })
})

d('runFullResolutionExport', () => {
  it('exports the full-resolution JPEG with EXIF and progress', async () => {
    const runtime = createLmfgRuntime({ memoryProfile: 'desktop' })
    const progress: number[] = []
    try {
      const source = await loadSourceFile(FIXTURE, '/')
      const result = await runFullResolutionExport({
        runtime,
        source,
        params: parseRenderParams({ exposure_ev: 0.3 }),
        lut: null,
        exposure: null,
        quality: 90,
        preferredRows: 512,
        onProgress: (p) => {
          progress.push(p.progress)
        },
      })
      expect(result.width).toBe(4032)
      expect(result.height).toBe(3024)
      expect(result.jpeg.byteLength).toBeGreaterThan(1_000_000)
      expect(result.sha256).toMatch(/^[0-9a-f]{64}$/)
      expect(result.strips).toBeGreaterThan(1)
      expect(progress.at(-1)).toBe(99)
      expect(result.exposure.source).toBe('dng-baseline')
      const head = Buffer.from(result.jpeg.subarray(0, 64)).toString('latin1')
      expect(head).toContain('Exif')
    } finally {
      runtime.dispose()
    }
  }, 120_000)
})
