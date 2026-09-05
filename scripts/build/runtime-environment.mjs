import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import process from 'node:process'

export const RENDER_ENVIRONMENT_VARIANTS = ['desktop', 'low-memory']

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

function packageVersion(rootDir, dir) {
  const version = readJson(join(rootDir, 'packages', dir, 'package.json'))?.version
  return typeof version === 'string' ? version : 'unknown'
}

function provenanceWasmSha(candidates) {
  for (const candidate of candidates) {
    const sha = readJson(candidate)?.artifacts?.wasm?.sha256
    if (typeof sha === 'string' && sha.length > 0) return sha
  }
  return null
}

function artifactsDir(rootDir, env) {
  const explicit = env.LUMAFORGE_NATIVE_ARTIFACTS_DIR?.trim()
  return explicit
    ? resolve(rootDir, explicit)
    : join(rootDir, 'packages', 'luma-native-artifacts')
}

/**
 * Native build id for one memory-profile variant: prebuilt provenance first
 * (`packages/luma-native-artifacts/native/provenance`), then workspace source
 * builds (`packages/luma-*-runtime/dist/native`), else `unknown`.
 */
export function resolveNativeBuildId({ rootDir, variant, env = process.env }) {
  const artifacts = artifactsDir(rootDir, env)
  const rawSha = provenanceWasmSha([
    join(artifacts, 'native', 'provenance', `raw-${variant}.json`),
    join(artifacts, 'native', 'provenance', 'raw.json'),
    join(rootDir, 'packages', 'luma-raw-runtime', 'dist', 'native', variant, 'provenance.json'),
  ])
  const jpegSha = provenanceWasmSha([
    join(artifacts, 'native', 'provenance', 'jpeg.json'),
    join(rootDir, 'packages', 'luma-jpeg-runtime', 'dist', 'native', 'provenance.json'),
  ])
  return rawSha && jpegSha
    ? `raw:${rawSha.slice(0, 12)}+jpeg:${jpegSha.slice(0, 12)}`
    : 'unknown'
}

export function resolveRenderEnvironment({ rootDir, variant, env = process.env }) {
  return {
    render_engine: packageVersion(rootDir, 'render-engine'),
    luma_color_runtime: packageVersion(rootDir, 'luma-color-runtime'),
    luma_raw_runtime: packageVersion(rootDir, 'luma-raw-runtime'),
    luma_jpeg_runtime: packageVersion(rootDir, 'luma-jpeg-runtime'),
    native_artifacts: { build_id: resolveNativeBuildId({ rootDir, variant, env }), variant },
  }
}

/** Both memory-profile variants, keyed by variant, for a build-time `define`. */
export function resolveRenderEnvironments({ rootDir, env = process.env }) {
  return Object.fromEntries(
    RENDER_ENVIRONMENT_VARIANTS.map((variant) => [
      variant,
      resolveRenderEnvironment({ rootDir, variant, env }),
    ]),
  )
}
