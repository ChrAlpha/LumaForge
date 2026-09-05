// @vitest-environment node

import { expect, it } from 'vitest'

import { createLmfgRuntime } from '../runtime/node-runtime'
import { loadSourceFile } from '../runtime/source-loader'
import { parseRenderParams } from '../schemas/params'
import {
  describeWithFixture,
  FIXTURE_PATH,
} from '../test-support/describe-with-fixture'
import { renderPreview } from './preview'

describeWithFixture('renderPreview', () => {
  it('decodes a quick frame, renders through the CPU graph, and encodes a JPEG', async () => {
    const runtime = createLmfgRuntime({ memoryProfile: 'desktop' })
    try {
      const source = await loadSourceFile(FIXTURE_PATH, '/')
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
