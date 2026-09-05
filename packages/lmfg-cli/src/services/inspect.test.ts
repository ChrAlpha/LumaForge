// @vitest-environment node
import { existsSync } from 'node:fs'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { detectCapabilities } from '../runtime/capability'
import { createLmfgRuntime } from '../runtime/node-runtime'
import { loadSourceFile } from '../runtime/source-loader'
import { inspectSource } from './inspect'

const FIXTURE = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../luma-raw-runtime/fixtures/.cache/public/raw-pixls-iphone-se.dng',
)
const ready =
  existsSync(FIXTURE) &&
  detectCapabilities({ memoryProfile: 'desktop' }).render_tiers.cpu_wasm
    .available
const d = ready ? describe : describe.skip

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'lmfg-inspect-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

d('inspectSource', () => {
  it('reports metadata, capability, exposure, and writes the embedded preview', async () => {
    const runtime = createLmfgRuntime({ memoryProfile: 'desktop' })
    try {
      const source = await loadSourceFile(FIXTURE, dir)
      const previewPath = join(dir, 'embedded-preview.jpg')
      const result = await inspectSource({
        runtime,
        source,
        sessionId: null,
        embeddedPreviewPath: previewPath,
      })
      expect(result.metadata.make).toMatch(/apple/i)
      expect(result.decoded_dimensions).toEqual({ width: 4032, height: 3024 })
      expect(result.export_capability).toMatchObject({
        supported: true,
        strategy: 'libraw-processed-window',
      })
      expect(result.raw_render_exposure.source).toBe('dng-baseline')
      expect(result.embedded_preview?.uri).toMatch(/^file:\/\//)
      expect((await stat(previewPath)).size).toBeGreaterThan(1000)
    } finally {
      runtime.dispose()
    }
  }, 60_000)
})
