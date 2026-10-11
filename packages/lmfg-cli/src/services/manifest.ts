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
import { createRenderManifest } from '@lumaforge/render-engine'
import type { RecordedGeometryRefusal } from '@lumaforge/render-engine/manifest'
import {
  checkRecordedExportGeometry,
  parseRenderManifest,
} from '@lumaforge/render-engine/manifest'

import { LmfgError } from '../protocol/errors'
import type { LoadedSource } from '../runtime/source-loader'
import type { RenderParams } from '../schemas/params'
import type { ManifestVerifyResult } from '../schemas/results'
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

type ManifestGeometryRefusal = NonNullable<
  ManifestVerifyResult['geometry_refusal']
>

export type ManifestVerification = {
  /** `structural_valid`, and the geometry is not unexecutable. */
  valid: boolean
  /** The seal over the whole file and the full v1 structure. */
  structural_valid: boolean
  /**
   * Whether the recorded geometry and output dimensions describe an export
   * the engine can produce; null when the manifest is not structurally valid
   * or is a preview or candidate that records no geometry.
   */
  geometry_executable: boolean | null
  /** Set exactly when `geometry_executable` is false. */
  geometry_refusal: ManifestGeometryRefusal | null
  issues: string[]
  warnings: string[]
  environment_match: boolean | null
  /** The structurally verified manifest, whatever its geometry. */
  manifest: RenderManifest | null
  raw: Record<string, unknown> | null
}

function size(value: { width: number; height: number }): string {
  return `${value.width}x${value.height}`
}

/** The protocol form of a geometry refusal and the issue it reports. */
function describeGeometryRefusal(refusal: RecordedGeometryRefusal): {
  refusal: ManifestGeometryRefusal
  issue: string
} {
  switch (refusal.reason) {
    case 'non-export-geometry':
      return {
        refusal: { reason: refusal.reason, kind: refusal.kind },
        issue: `render_params.geometry: a ${refusal.kind} manifest records a geometry; only full-resolution exports apply one.`,
      }
    case 'unplannable-geometry':
      return {
        refusal: {
          reason: refusal.reason,
          source: refusal.source,
          cause: refusal.cause.message,
        },
        issue: `render_params.geometry: cannot be exported from the recorded ${size(refusal.source)} source frame: it folds the frame or retains too little of it.`,
      }
    case 'geometry-output-mismatch':
      return {
        refusal: {
          reason: refusal.reason,
          source: refusal.source,
          recorded: refusal.recorded,
          planned: refusal.planned,
        },
        issue: `render_params.geometry.output: ${size(refusal.recorded)} is not the ${size(refusal.planned)} frame the geometry plans from the recorded ${size(refusal.source)} source.`,
      }
    case 'output-mismatch':
      return {
        refusal: {
          reason: refusal.reason,
          delivered_by: refusal.deliveredBy,
          recorded: refusal.recorded,
          delivered: refusal.delivered,
        },
        issue: `output.dimensions: ${size(refusal.recorded)} is not the ${size(refusal.delivered)} frame the ${refusal.deliveredBy} delivers.`,
      }
  }
}

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
      structural_valid: false,
      geometry_executable: null,
      geometry_refusal: null,
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
      structural_valid: false,
      geometry_executable: null,
      geometry_refusal: null,
      issues: ['Manifest must be a JSON object.'],
      warnings,
      environment_match: null,
      manifest: null,
      raw: null,
    }
  }
  // The hash is checked over the whole object as read, then every section is
  // held to the v1 shape: a manifest can be correctly sealed and still not
  // be safe to execute. Only a structurally valid manifest has its geometry
  // checked, and an unexecutable geometry is reported as its own refusal,
  // never as a seal or structure failure.
  const parsed = parseRenderManifest(raw)
  let geometryExecutable: boolean | null = null
  let geometryRefusal: ManifestGeometryRefusal | null = null
  if (!parsed.ok) {
    for (const issue of parsed.issues) {
      issues.push(`${issue.path}: ${issue.message}`)
    }
  } else {
    const check = checkRecordedExportGeometry(parsed.manifest)
    if (check.ok) {
      geometryExecutable = check.frame ? true : null
    } else {
      const described = describeGeometryRefusal(check.refusal)
      geometryExecutable = false
      geometryRefusal = described.refusal
      issues.push(described.issue)
    }
  }

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

  return {
    valid: parsed.ok && geometryExecutable !== false,
    structural_valid: parsed.ok,
    geometry_executable: geometryExecutable,
    geometry_refusal: geometryRefusal,
    issues,
    warnings,
    environment_match: environmentMatch,
    manifest: parsed.ok ? parsed.manifest : null,
    raw,
  }
}

/**
 * Reads a manifest that passes its seal and the full v1 structure. Its
 * geometry is not held to executability here: replay checks it before any
 * decode with its own refusals, and `manifest verify` reports it.
 */
export async function requireVerifiedManifest(
  path: string,
  environment: RenderEnvironment,
): Promise<{ manifest: RenderManifest; warnings: string[] }> {
  const verification = await verifyManifestFile(path, { environment })
  if (!verification.structural_valid || !verification.manifest) {
    throw new LmfgError('manifest.invalid', {
      message: `Manifest ${path} failed verification: ${verification.issues.join(' ')}`,
      details: { issues: verification.issues, warnings: verification.warnings },
    })
  }
  return { manifest: verification.manifest, warnings: verification.warnings }
}
