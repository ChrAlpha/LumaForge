// @vitest-environment node
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { resolveNativeBuildId, resolveRenderEnvironments } from './runtime-environment.mjs'

let rootDir
beforeEach(async () => {
  rootDir = await mkdtemp(join(tmpdir(), 'lmfg-env-'))
})
afterEach(async () => {
  await rm(rootDir, { recursive: true, force: true })
})

async function writeJson(path, value) {
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, JSON.stringify(value))
}

describe('runtime environment resolution', () => {
  it('reads package versions and prebuilt provenance hashes', async () => {
    for (const [dir, version] of [
      ['render-engine', '0.1.0'],
      ['luma-color-runtime', '0.1.1'],
      ['luma-raw-runtime', '0.1.1'],
      ['luma-jpeg-runtime', '0.1.1'],
    ]) {
      await writeJson(join(rootDir, 'packages', dir, 'package.json'), { version })
    }
    const provenance = join(rootDir, 'packages', 'luma-native-artifacts', 'native', 'provenance')
    await writeJson(join(provenance, 'raw-desktop.json'), { artifacts: { wasm: { sha256: 'a'.repeat(64) } } })
    await writeJson(join(provenance, 'raw-low-memory.json'), { artifacts: { wasm: { sha256: 'b'.repeat(64) } } })
    await writeJson(join(provenance, 'jpeg.json'), { artifacts: { wasm: { sha256: 'c'.repeat(64) } } })

    const environments = resolveRenderEnvironments({ rootDir, env: {} })
    expect(environments.desktop).toEqual({
      render_engine: '0.1.0',
      luma_color_runtime: '0.1.1',
      luma_raw_runtime: '0.1.1',
      luma_jpeg_runtime: '0.1.1',
      native_artifacts: { build_id: `raw:${'a'.repeat(12)}+jpeg:${'c'.repeat(12)}`, variant: 'desktop' },
    })
    expect(environments['low-memory'].native_artifacts).toEqual({
      build_id: `raw:${'b'.repeat(12)}+jpeg:${'c'.repeat(12)}`,
      variant: 'low-memory',
    })
  })

  it('falls back to source-build provenance, then unknown', async () => {
    await writeJson(join(rootDir, 'packages', 'luma-raw-runtime', 'dist', 'native', 'desktop', 'provenance.json'), {
      artifacts: { wasm: { sha256: 'd'.repeat(64) } },
    })
    await writeJson(join(rootDir, 'packages', 'luma-jpeg-runtime', 'dist', 'native', 'provenance.json'), {
      artifacts: { wasm: { sha256: 'e'.repeat(64) } },
    })
    expect(resolveNativeBuildId({ rootDir, variant: 'desktop', env: {} })).toBe(
      `raw:${'d'.repeat(12)}+jpeg:${'e'.repeat(12)}`,
    )
    expect(resolveNativeBuildId({ rootDir, variant: 'low-memory', env: {} })).toBe('unknown')
    expect(resolveRenderEnvironments({ rootDir, env: {} }).desktop.render_engine).toBe('unknown')
  })
})
