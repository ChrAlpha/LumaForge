/// <reference types="node" />
// @vitest-environment node

// Bundle smoke. If the build output regresses (e.g. vite externalization
// breaks a node:* import, or the subpath exports stop resolving), this test
// catches it before consumers do.

import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DIST_INDEX = join(packageDir, 'dist', 'index.js')
const DIST_MANIFEST = join(packageDir, 'dist', 'manifest.js')
const DIST_POLICY = join(packageDir, 'dist', 'policy.js')

const DIST_AVAILABLE =
  existsSync(DIST_INDEX) && existsSync(DIST_MANIFEST) && existsSync(DIST_POLICY)

const describeWithDist = DIST_AVAILABLE ? describe : describe.skip

describeWithDist(
  'dist bundle smoke — guards against vite externalization or subpath regressions',
  () => {
    it('imports + uses sealRenderManifest from the published bundle', async () => {
      const mod = (await import(DIST_INDEX)) as {
        sealRenderManifest: (m: unknown) => { manifest_sha256: string }
        verifyManifestSha256: (m: unknown) => boolean
      }
      const sealed = mod.sealRenderManifest(buildMinimalManifest() as never)
      expect(sealed.manifest_sha256).toMatch(/^[0-9a-f]{64}$/)
      expect(mod.verifyManifestSha256(sealed)).toBe(true)
    })

    it('@/manifest subpath resolves and exports the hash helpers', async () => {
      const mod = (await import(DIST_MANIFEST)) as {
        sha256Hex: (bytes: Uint8Array) => string
      }
      expect(typeof mod.sha256Hex).toBe('function')
      expect(mod.sha256Hex(new Uint8Array(0))).toBe(
        'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      )
    })

    it('@/policy subpath resolves and ships NODE_DEFAULT_CAPABILITY', async () => {
      const mod = (await import(DIST_POLICY)) as {
        NODE_DEFAULT_CAPABILITY: {
          coi: boolean
          hwConcurrency: number
        }
      }
      expect(mod.NODE_DEFAULT_CAPABILITY.coi).toBe(false)
      expect(mod.NODE_DEFAULT_CAPABILITY.hwConcurrency).toBe(1)
    })
  },
)

if (!DIST_AVAILABLE) {
  describe('dist bundle smoke — SKIPPED', () => {
    it('dist missing; run `pnpm build` first', () => {
      expect(DIST_AVAILABLE).toBe(false)
    })
  })
}

function buildMinimalManifest() {
  return {
    manifest_version: 1,
    kind: 'preview',
    produced_at: '2026-06-13T12:00:00Z',
    parent_manifest_sha256: null,
    source_raw: {
      sha256: '0'.repeat(64),
      byte_size: 1024,
      filename: 'x.raw',
      decoded_dimensions: { width: 1, height: 1 },
    },
    calibration: null,
    lut: null,
    color_graph: { fingerprint: '0'.repeat(64), descriptor: {} },
    render_params: { exposure_ev: 0 },
    output: {
      format: 'jpeg',
      dimensions: { width: 1, height: 1 },
      color_space: 'srgb',
      quality: 80,
      filename: 'out.jpg',
      sha256: '0'.repeat(64),
    },
    policy: { kind: 'preview-quick', row_slice: 64, concurrency: 1 },
    environment: {
      render_engine: '0.1.0',
      luma_color_runtime: '0.1.0',
      luma_raw_runtime: '0.1.0',
      luma_jpeg_runtime: '0.1.0',
      native_artifacts: { build_id: 'test', variant: 'desktop' },
    },
  }
}
