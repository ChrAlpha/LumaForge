// @vitest-environment node
import { describe, expect, it } from 'vitest'

import {
  LMFG_VERSION,
  readPackageVersion,
  resolvePackageDir,
  resolveRenderEnvironment,
  resolveRuntimeVersions,
} from './versions'

describe('versions', () => {
  it('resolves workspace package directories', () => {
    expect(resolvePackageDir('@lumaforge/render-engine')).toMatch(
      /render-engine$/,
    )
    expect(resolvePackageDir('@lumaforge/does-not-exist')).toBeNull()
  })

  it('reads semver strings for every runtime dependency', () => {
    const versions = resolveRuntimeVersions('desktop')
    for (const key of [
      'luma_raw_runtime',
      'luma_color_runtime',
      'luma_jpeg_runtime',
      'render_engine',
    ] as const) {
      expect(versions[key]).toMatch(/^\d+\.\d+\.\d+/)
    }
    expect(versions.native_artifacts.variant).toBe('desktop')
    expect(LMFG_VERSION).toMatch(/^\d+\.\d+\.\d+/)
    expect(readPackageVersion('@lumaforge/nope')).toBe('unknown')
  })

  it('derives a stable native build id from provenance hashes', () => {
    const env = resolveRenderEnvironment('low-memory')
    expect(env.native_artifacts.variant).toBe('low-memory')
    expect(env.native_artifacts.build_id).toMatch(
      /^raw:[0-9a-f]{12}\+jpeg:[0-9a-f]{12}$|^unknown$/,
    )
    expect(env.render_engine).toBe(
      resolveRuntimeVersions('low-memory').render_engine,
    )
  })
})
