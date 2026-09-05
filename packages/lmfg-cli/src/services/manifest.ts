import { readFile } from 'node:fs/promises'

import type {
  RawRenderExposure,
  SupportedExportColorGraphDescriptor,
} from '@lumaforge/luma-color-runtime'
import type {
  LutIdentity,
  PolicyChoice,
  RenderEnvironment,
  RenderManifest,
  RenderManifestKind,
  SourceRawIdentity,
} from '@lumaforge/render-engine'
import {
  createRenderManifest,
  verifyManifestSha256,
} from '@lumaforge/render-engine'

import { LmfgError } from '../protocol/errors'
import type { LoadedSource } from '../runtime/source-loader'
import type { RenderParams } from '../schemas/params'
import { toManifestRenderParams } from './color-graph'

export type BuildManifestInput = {
  kind: RenderManifestKind
  source: SourceRawIdentity
  lut: LutIdentity | null
  graph: SupportedExportColorGraphDescriptor
  params: RenderParams
  exposure: RawRenderExposure
  policy: PolicyChoice
  environment: RenderEnvironment
  output: {
    width: number
    height: number
    quality: number
    filename: string
    sha256: string
  }
  parentManifestSha256: string | null
  producedAt?: Date
}

export function qualityToPercent(quality: number): number {
  return Math.round(quality * 100)
}

export function percentToQuality(percent: number): number {
  return percent / 100
}

export function toSourceIdentity(
  source: LoadedSource,
  dims: { width: number; height: number },
): SourceRawIdentity {
  return {
    sha256: source.sha256,
    byte_size: source.byteSize,
    filename: source.filename,
    decoded_dimensions: dims,
  }
}

export function buildRenderManifest(input: BuildManifestInput): RenderManifest {
  return createRenderManifest({
    kind: input.kind,
    source_raw: input.source,
    lut: input.lut,
    graph: input.graph,
    render_params: toManifestRenderParams(input.params, input.exposure),
    policy: input.policy,
    environment: input.environment,
    output: input.output,
    parent_manifest_sha256: input.parentManifestSha256,
    produced_at: input.producedAt?.toISOString(),
  })
}

export type ManifestVerification = {
  valid: boolean
  issues: string[]
  warnings: string[]
  environment_match: boolean | null
  manifest: RenderManifest | null
  raw: Record<string, unknown> | null
}

const REQUIRED_KEYS = [
  'manifest_version',
  'kind',
  'produced_at',
  'parent_manifest_sha256',
  'source_raw',
  'calibration',
  'lut',
  'color_graph',
  'render_params',
  'policy',
  'environment',
  'output',
  'manifest_sha256',
] as const
const KINDS = new Set(['preview', 'candidate', 'export'])

export async function verifyManifestFile(
  path: string,
  options: { environment: RenderEnvironment },
): Promise<ManifestVerification> {
  const issues: string[] = []
  const warnings: string[] = []
  let raw: Record<string, unknown>
  try {
    raw = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new LmfgError('file.not_found', {
        message: `Manifest not found: ${path}`,
      })
    }
    return {
      valid: false,
      issues: ['Manifest is not valid JSON.'],
      warnings,
      environment_match: null,
      manifest: null,
      raw: null,
    }
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return {
      valid: false,
      issues: ['Manifest must be a JSON object.'],
      warnings,
      environment_match: null,
      manifest: null,
      raw: null,
    }
  }
  for (const key of REQUIRED_KEYS) {
    if (!(key in raw)) issues.push(`Missing required field "${key}".`)
  }
  if (!verifyManifestSha256(raw)) {
    issues.push(
      'manifest_sha256 does not match the canonical content (tampered or corrupted).',
    )
  }
  if (raw.manifest_version !== 1) {
    issues.push(
      `Unsupported manifest_version ${String(raw.manifest_version)}; this lmfg reads version 1.`,
    )
  }
  if (!KINDS.has(String(raw.kind)))
    issues.push(`Unknown manifest kind "${String(raw.kind)}".`)

  let environmentMatch: boolean | null = null
  const environment = raw.environment as Partial<RenderEnvironment> | undefined
  if (environment && typeof environment === 'object') {
    environmentMatch = true
    for (const key of [
      'render_engine',
      'luma_color_runtime',
      'luma_raw_runtime',
      'luma_jpeg_runtime',
    ] as const) {
      if (environment[key] !== options.environment[key]) {
        environmentMatch = false
        warnings.push(
          `environment.${key} is ${String(environment[key])}; current runtime is ${options.environment[key]}.`,
        )
      }
    }
    if (
      environment.native_artifacts?.build_id !==
      options.environment.native_artifacts.build_id
    ) {
      environmentMatch = false
      warnings.push(
        `environment.native_artifacts.build_id differs from the current artifacts (${options.environment.native_artifacts.build_id}).`,
      )
    }
  }

  const valid = issues.length === 0
  return {
    valid,
    issues,
    warnings,
    environment_match: environmentMatch,
    manifest: valid ? (raw as unknown as RenderManifest) : null,
    raw,
  }
}

export async function requireVerifiedManifest(
  path: string,
  environment: RenderEnvironment,
): Promise<{ manifest: RenderManifest; warnings: string[] }> {
  const verification = await verifyManifestFile(path, { environment })
  if (!verification.valid || !verification.manifest) {
    throw new LmfgError('manifest.invalid', {
      message: `Manifest ${path} failed verification: ${verification.issues.join(' ')}`,
      details: { issues: verification.issues, warnings: verification.warnings },
    })
  }
  return { manifest: verification.manifest, warnings: verification.warnings }
}
