import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { RenderEnvironment } from '@lumaforge/render-engine'

import type { RuntimeVersions } from '../schemas/results'

export type MemoryProfile = 'desktop' | 'low-memory'

type PackageJson = { name?: string; version?: string }

function readPackageJson(dir: string): PackageJson | null {
  try {
    return JSON.parse(
      readFileSync(join(dir, 'package.json'), 'utf8'),
    ) as PackageJson
  } catch {
    return null
  }
}

/**
 * Locate an installed package directory by probing the node_modules
 * ancestry of this module. Works with pnpm symlinks (existsSync follows
 * them) and with hoisted installs.
 */
export function resolvePackageDir(
  name: string,
  from: string = import.meta.url,
): string | null {
  const require = createRequire(from)
  for (const dir of require.resolve.paths(name) ?? []) {
    const candidate = join(dir, name)
    if (existsSync(join(candidate, 'package.json'))) return candidate
  }
  return null
}

export function readPackageVersion(name: string): string {
  const dir = resolvePackageDir(name)
  return (dir && readPackageJson(dir)?.version) || 'unknown'
}

function findOwnPackageDir(): string {
  let dir = dirname(fileURLToPath(import.meta.url))
  for (let depth = 0; depth < 5; depth += 1) {
    if (readPackageJson(dir)?.name === '@lumaforge/lmfg-cli') return dir
    dir = dirname(dir)
  }
  throw new Error('LMFG_PACKAGE_ROOT_NOT_FOUND')
}

export const LMFG_PACKAGE_DIR = findOwnPackageDir()
export const LMFG_VERSION =
  readPackageJson(LMFG_PACKAGE_DIR)?.version ?? 'unknown'

type Provenance = { artifacts?: { wasm?: { sha256?: string } } }

export type NativeArtifactStatus = {
  package_dir: string | null
  variant: MemoryProfile
  build_id: string
  raw_wasm: string | null
  jpeg_wasm: string | null
  raw_present: boolean
  jpeg_present: boolean
}

function readProvenance(dir: string, names: string[]): Provenance | null {
  for (const name of names) {
    const file = join(dir, 'native', 'provenance', name)
    if (!existsSync(file)) continue
    try {
      return JSON.parse(readFileSync(file, 'utf8')) as Provenance
    } catch {
      return null
    }
  }
  return null
}

export function resolveNativeArtifacts(
  memoryProfile: MemoryProfile,
): NativeArtifactStatus {
  const dir = resolvePackageDir('@lumaforge/luma-native-artifacts')
  if (!dir) {
    return {
      package_dir: null,
      variant: memoryProfile,
      build_id: 'unknown',
      raw_wasm: null,
      jpeg_wasm: null,
      raw_present: false,
      jpeg_present: false,
    }
  }
  const rawWasm = join(dir, 'native', memoryProfile, 'luma_raw.wasm')
  const jpegWasm = join(dir, 'native', 'luma_jpeg.wasm')
  const raw = readProvenance(dir, [`raw-${memoryProfile}.json`, 'raw.json'])
  const jpeg = readProvenance(dir, ['jpeg.json'])
  const rawSha = raw?.artifacts?.wasm?.sha256
  const jpegSha = jpeg?.artifacts?.wasm?.sha256
  return {
    package_dir: dir,
    variant: memoryProfile,
    build_id:
      rawSha && jpegSha
        ? `raw:${rawSha.slice(0, 12)}+jpeg:${jpegSha.slice(0, 12)}`
        : 'unknown',
    raw_wasm: rawWasm,
    jpeg_wasm: jpegWasm,
    raw_present: existsSync(rawWasm),
    jpeg_present: existsSync(jpegWasm),
  }
}

export function resolveRuntimeVersions(
  memoryProfile: MemoryProfile,
): RuntimeVersions {
  const artifacts = resolveNativeArtifacts(memoryProfile)
  return {
    luma_raw_runtime: readPackageVersion('@lumaforge/luma-raw-runtime'),
    luma_color_runtime: readPackageVersion('@lumaforge/luma-color-runtime'),
    luma_jpeg_runtime: readPackageVersion('@lumaforge/luma-jpeg-runtime'),
    render_engine: readPackageVersion('@lumaforge/render-engine'),
    native_artifacts: {
      build_id: artifacts.build_id,
      variant: artifacts.variant,
    },
  }
}

export function resolveRenderEnvironment(
  memoryProfile: MemoryProfile,
): RenderEnvironment {
  const versions = resolveRuntimeVersions(memoryProfile)
  return {
    render_engine: versions.render_engine,
    luma_color_runtime: versions.luma_color_runtime,
    luma_raw_runtime: versions.luma_raw_runtime,
    luma_jpeg_runtime: versions.luma_jpeg_runtime,
    native_artifacts: versions.native_artifacts,
  }
}
