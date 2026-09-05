// @vitest-environment node
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { detectCapabilities } from '../runtime/capability'
import { createLmfgRuntime } from '../runtime/node-runtime'
import { loadSourceFile } from '../runtime/source-loader'
import { parseRenderParams } from '../schemas/params'
import { renderPreview } from './preview'

const FIXTURE = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../luma-raw-runtime/fixtures/.cache/public/raw-pixls-iphone-se.dng',
)
const ready =
  existsSync(FIXTURE) &&
  detectCapabilities({ memoryProfile: 'desktop' }).render_tiers.cpu_wasm
    .available
const d = ready ? describe : describe.skip

d('renderPreview', () => {
  it('decodes a quick frame, renders through the CPU graph, and encodes a JPEG', async () => {
    const runtime = createLmfgRuntime({ memoryProfile: 'desktop' })
    try {
      const source = await loadSourceFile(FIXTURE, '/')
      const result = await renderPreview({
        runtime,
        source,
        params: parseRenderParams({ contrast: 20 }),
        lut: null,
        maxPixels: 500_000,
        quality: 0.8,
      })
      expect(result.frame.decode).toBe('quick')
      expect(result.frame.width * result.frame.height).toBeLessThanOrEqual(
        500_000,
      )
      expect(result.rendered.jpeg[0]).toBe(0xFF)
      expect(result.rendered.jpeg[1]).toBe(0xD8)
      expect(result.rendered.sha256).toMatch(/^[0-9a-f]{64}$/)
      expect(result.exposure.source).toBe('dng-baseline')
      expect(result.rendered.rgba.length).toBe(
        result.frame.width * result.frame.height * 4,
      )
    } finally {
      runtime.dispose()
    }
  }, 60_000)
})
