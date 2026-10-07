// Structural reader for a parsed `RenderManifest` v1.
//
// A valid `manifest_sha256` only proves the content is what its writer
// sealed; anyone can seal malformed content. Readers that act on a manifest
// first verify the hash over the complete parsed object, then check every
// section they could execute against the v1 shape before treating the object
// as a `RenderManifest`.
//
// Rules:
//   - Nothing is coerced, clamped or defaulted. A string where a number
//     belongs, a non-finite number, a fractional dimension or `null` in an
//     optional field is refused; the manifest is returned exactly as given.
//   - Fields the v1 shape marks optional may be absent, so manifests written
//     before a field existed keep their identity.
//   - Fields this reader does not know are left alone: the hash already
//     covers them.
//   - Value ranges of the user color params are not checked here; replaying
//     readers hold those to their own params schema.

import { invertMatrix, isMatrix3 } from '../export/geometry/matrix'
import { computeManifestSha256 } from './canonicalize'
import type { ColorGraphDescriptor } from './color-graph-descriptor'
import {
  COLOR_GRAPH_DESCRIPTOR_VERSION,
  fingerprintColorGraph,
} from './color-graph-descriptor'
import type { RenderManifest } from './render-manifest'

export interface RenderManifestIssue {
  /** Dotted path of the offending field; `manifest` for the whole value. */
  readonly path: string
  readonly message: string
}

export type ParseRenderManifestResult =
  | { readonly ok: true; readonly manifest: RenderManifest }
  | { readonly ok: false; readonly issues: readonly RenderManifestIssue[] }

type Fields = Readonly<Record<string, unknown>>

const SHA256_HEX = /^[0-9a-f]{64}$/
const ISO_8601_UTC_OR_OFFSET =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/

const MANIFEST_KINDS = ['preview', 'candidate', 'export']
const POLICY_KINDS = [
  'preview-quick',
  'preview-bounded-hq',
  'candidate',
  'export-full',
]
const NATIVE_VARIANTS = ['desktop', 'low-memory']
const LUT_RANGES = ['full', 'legal', 'unknown']
const RAW_RENDER_EXPOSURE_SOURCES = [
  'dng-baseline',
  'image-statistics',
  'identity',
  'user',
]
const ENVIRONMENT_VERSIONS = [
  'render_engine',
  'luma_color_runtime',
  'luma_raw_runtime',
  'luma_jpeg_runtime',
] as const

function isFields(value: unknown): value is Fields {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function describeValue(value: unknown): string {
  if (value === undefined) return 'missing'
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'an array'
  if (typeof value === 'string') return `the string ${JSON.stringify(value)}`
  if (typeof value === 'number') return `the number ${String(value)}`
  return `a ${typeof value}`
}

class IssueList {
  readonly issues: RenderManifestIssue[] = []

  add(path: string, message: string): void {
    this.issues.push({ path, message })
  }

  /** The field as an object, or `null` after recording why it is not one. */
  section(parent: Fields, key: string, path: string): Fields | null {
    const value = parent[key]
    if (isFields(value)) return value
    this.add(path, `must be an object, got ${describeValue(value)}.`)
    return null
  }

  /** Like `section`, but `null` reads as recorded-none. */
  nullableSection(parent: Fields, key: string, path: string): Fields | null {
    const value = parent[key]
    if (value === null || isFields(value)) return value
    this.add(path, `must be null or an object, got ${describeValue(value)}.`)
    return null
  }

  /** Like `section`, but an absent field is fine. */
  optionalSection(parent: Fields, key: string, path: string): Fields | null {
    return Object.hasOwn(parent, key) ? this.section(parent, key, path) : null
  }

  string(parent: Fields, key: string, path: string): void {
    const value = parent[key]
    if (typeof value !== 'string') {
      this.add(path, `must be a string, got ${describeValue(value)}.`)
    }
  }

  optionalString(parent: Fields, key: string, path: string): void {
    if (Object.hasOwn(parent, key)) this.string(parent, key, path)
  }

  sha256(parent: Fields, key: string, path: string): void {
    const value = parent[key]
    if (typeof value !== 'string' || !SHA256_HEX.test(value)) {
      this.add(
        path,
        `must be a lowercase hex SHA-256, got ${describeValue(value)}.`,
      )
    }
  }

  oneOf(
    parent: Fields,
    key: string,
    path: string,
    allowed: readonly string[],
  ): boolean {
    const value = parent[key]
    if (typeof value === 'string' && allowed.includes(value)) return true
    this.add(
      path,
      `must be one of ${allowed.map((item) => `"${item}"`).join(', ')}, got ${describeValue(value)}.`,
    )
    return false
  }

  finite(parent: Fields, key: string, path: string): void {
    const value = parent[key]
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      this.add(path, `must be a finite number, got ${describeValue(value)}.`)
    }
  }

  optionalFinite(parent: Fields, key: string, path: string): void {
    if (Object.hasOwn(parent, key)) this.finite(parent, key, path)
  }

  integer(
    parent: Fields,
    key: string,
    path: string,
    min: number,
    max = Number.MAX_SAFE_INTEGER,
  ): void {
    const value = parent[key]
    if (
      typeof value !== 'number' ||
      !Number.isSafeInteger(value) ||
      value < min ||
      value > max
    ) {
      const range =
        max === Number.MAX_SAFE_INTEGER ? `>= ${min}` : `in ${min}..${max}`
      this.add(
        path,
        `must be an integer ${range}, got ${describeValue(value)}.`,
      )
    }
  }

  boolean(parent: Fields, key: string, path: string): void {
    const value = parent[key]
    if (typeof value !== 'boolean') {
      this.add(path, `must be a boolean, got ${describeValue(value)}.`)
    }
  }

  dimensions(parent: Fields, key: string, path: string): void {
    const dims = this.section(parent, key, path)
    if (!dims) return
    this.integer(dims, 'width', `${path}.width`, 1)
    this.integer(dims, 'height', `${path}.height`, 1)
  }
}

function checkSourceRaw(list: IssueList, manifest: Fields): void {
  const source = list.section(manifest, 'source_raw', 'source_raw')
  if (!source) return
  list.sha256(source, 'sha256', 'source_raw.sha256')
  list.integer(source, 'byte_size', 'source_raw.byte_size', 0)
  list.string(source, 'filename', 'source_raw.filename')
  list.dimensions(source, 'decoded_dimensions', 'source_raw.decoded_dimensions')
}

function checkCalibration(list: IssueList, manifest: Fields): void {
  const calibration = list.nullableSection(
    manifest,
    'calibration',
    'calibration',
  )
  if (!calibration) return
  if (!list.oneOf(calibration, 'kind', 'calibration.kind', ['catalog'])) return
  for (const key of ['catalog_id', 'profile_id', 'schema_version']) {
    list.string(calibration, key, `calibration.${key}`)
  }
  list.sha256(calibration, 'dcp_params_sha256', 'calibration.dcp_params_sha256')
  const neutral = calibration.white_neutral
  if (
    !Array.isArray(neutral) ||
    neutral.length !== 3 ||
    !neutral.every(
      (entry) => typeof entry === 'number' && Number.isFinite(entry),
    )
  ) {
    list.add(
      'calibration.white_neutral',
      'must be an array of three finite numbers.',
    )
  }
  list.finite(calibration, 'alpha', 'calibration.alpha')
  list.boolean(calibration, 'converged', 'calibration.converged')
}

function checkLutContract(list: IssueList, lut: Fields, key: string): void {
  const path = `lut.${key}`
  const contract = list.section(lut, key, path)
  if (!contract) return
  list.string(contract, 'gamut', `${path}.gamut`)
  list.string(contract, 'transfer', `${path}.transfer`)
  list.oneOf(contract, 'range', `${path}.range`, LUT_RANGES)
  list.optionalString(contract, 'role', `${path}.role`)
}

function checkLut(list: IssueList, manifest: Fields): void {
  const lut = list.nullableSection(manifest, 'lut', 'lut')
  if (!lut) return
  if (!list.oneOf(lut, 'kind', 'lut.kind', ['catalog', 'local-file'])) return
  if (lut.kind === 'catalog') {
    for (const key of ['catalog_id', 'entry', 'version']) {
      list.string(lut, key, `lut.${key}`)
    }
  } else {
    list.string(lut, 'filename', 'lut.filename')
  }
  list.sha256(lut, 'sha256', 'lut.sha256')
  checkLutContract(list, lut, 'input_contract')
  checkLutContract(list, lut, 'output_contract')
}

function fingerprintOf(descriptor: Fields): string | null {
  try {
    return fingerprintColorGraph(descriptor as ColorGraphDescriptor)
  } catch {
    return null
  }
}

/**
 * The descriptor stays opaque except for its version. A descriptor of the
 * version this engine writes must hash to the recorded fingerprint, so a
 * reader that consults it reads what the fingerprint covers; older versions
 * cannot be recomputed and are left to the fingerprint alone.
 */
function checkColorGraph(list: IssueList, manifest: Fields): void {
  const graph = list.section(manifest, 'color_graph', 'color_graph')
  if (!graph) return
  list.sha256(graph, 'fingerprint', 'color_graph.fingerprint')
  const descriptor = list.section(graph, 'descriptor', 'color_graph.descriptor')
  if (!descriptor || !Object.hasOwn(descriptor, 'descriptor_version')) return
  const before = list.issues.length
  list.integer(
    descriptor,
    'descriptor_version',
    'color_graph.descriptor.descriptor_version',
    1,
  )
  if (
    list.issues.length !== before ||
    descriptor.descriptor_version !== COLOR_GRAPH_DESCRIPTOR_VERSION ||
    typeof graph.fingerprint !== 'string' ||
    !SHA256_HEX.test(graph.fingerprint)
  ) {
    return
  }
  if (fingerprintOf(descriptor) !== graph.fingerprint) {
    list.add(
      'color_graph.fingerprint',
      'does not match the recorded descriptor.',
    )
  }
}

function checkOptionalNumbers(
  list: IssueList,
  params: Fields,
  key: string,
  fields: readonly string[],
): void {
  const path = `render_params.${key}`
  const section = list.optionalSection(params, key, path)
  if (!section) return
  for (const field of fields) {
    list.optionalFinite(section, field, `${path}.${field}`)
  }
}

function checkSelectiveColor(list: IssueList, params: Fields): void {
  const path = 'render_params.selective_color'
  const bands = list.optionalSection(params, 'selective_color', path)
  if (!bands) return
  for (const band of Object.keys(bands)) {
    const shift = list.section(bands, band, `${path}.${band}`)
    if (!shift) continue
    for (const axis of ['hue', 'saturation', 'lightness']) {
      list.finite(shift, axis, `${path}.${band}.${axis}`)
    }
  }
}

function checkGeometry(list: IssueList, params: Fields): void {
  const path = 'render_params.geometry'
  const geometry = list.optionalSection(params, 'geometry', path)
  if (!geometry) return
  if (!isMatrix3(geometry.matrix)) {
    list.add(`${path}.matrix`, 'must be an array of nine finite numbers.')
  } else if (!invertMatrix(geometry.matrix)) {
    list.add(`${path}.matrix`, 'must be invertible.')
  }
  list.boolean(geometry, 'constrain_crop', `${path}.constrain_crop`)
  list.dimensions(geometry, 'output', `${path}.output`)
}

function checkRenderParams(list: IssueList, manifest: Fields): void {
  const params = list.section(manifest, 'render_params', 'render_params')
  if (!params) return
  list.finite(params, 'exposure_ev', 'render_params.exposure_ev')
  checkOptionalNumbers(list, params, 'tone_curve', [
    'highlights',
    'shadows',
    'whites',
    'blacks',
    'contrast',
  ])
  checkOptionalNumbers(list, params, 'color_balance', [
    'temp_k',
    'tint',
    'temperature',
  ])
  checkOptionalNumbers(list, params, 'saturation', ['saturation', 'vibrance'])
  checkSelectiveColor(list, params)
  list.optionalFinite(params, 'intensity', 'render_params.intensity')
  list.optionalFinite(
    params,
    'raw_render_exposure_ev',
    'render_params.raw_render_exposure_ev',
  )
  if (Object.hasOwn(params, 'raw_render_exposure_source')) {
    list.oneOf(
      params,
      'raw_render_exposure_source',
      'render_params.raw_render_exposure_source',
      RAW_RENDER_EXPOSURE_SOURCES,
    )
  }
  checkGeometry(list, params)
}

function checkPolicy(list: IssueList, manifest: Fields): void {
  const policy = list.section(manifest, 'policy', 'policy')
  if (!policy) return
  list.oneOf(policy, 'kind', 'policy.kind', POLICY_KINDS)
  list.integer(policy, 'row_slice', 'policy.row_slice', 1)
  list.integer(policy, 'concurrency', 'policy.concurrency', 1)
  if (Object.hasOwn(policy, 'max_pixels')) {
    list.integer(policy, 'max_pixels', 'policy.max_pixels', 1)
  }
}

function checkEnvironment(list: IssueList, manifest: Fields): void {
  const environment = list.section(manifest, 'environment', 'environment')
  if (!environment) return
  for (const key of ENVIRONMENT_VERSIONS) {
    list.string(environment, key, `environment.${key}`)
  }
  const native = list.section(
    environment,
    'native_artifacts',
    'environment.native_artifacts',
  )
  if (!native) return
  list.string(native, 'build_id', 'environment.native_artifacts.build_id')
  list.oneOf(
    native,
    'variant',
    'environment.native_artifacts.variant',
    NATIVE_VARIANTS,
  )
}

function checkOutput(list: IssueList, manifest: Fields): void {
  const output = list.section(manifest, 'output', 'output')
  if (!output) return
  list.oneOf(output, 'format', 'output.format', ['jpeg'])
  list.dimensions(output, 'dimensions', 'output.dimensions')
  list.oneOf(output, 'color_space', 'output.color_space', ['srgb'])
  list.integer(output, 'quality', 'output.quality', 1, 100)
  list.string(output, 'filename', 'output.filename')
  list.sha256(output, 'sha256', 'output.sha256')
}

function checkHeader(list: IssueList, manifest: Fields): void {
  if (manifest.manifest_version !== 1) {
    list.add(
      'manifest_version',
      `must be 1, got ${describeValue(manifest.manifest_version)}.`,
    )
  }
  list.oneOf(manifest, 'kind', 'kind', MANIFEST_KINDS)
  const producedAt = manifest.produced_at
  if (
    typeof producedAt !== 'string' ||
    !ISO_8601_UTC_OR_OFFSET.test(producedAt) ||
    !Number.isFinite(Date.parse(producedAt))
  ) {
    list.add(
      'produced_at',
      `must be an ISO 8601 timestamp, got ${describeValue(producedAt)}.`,
    )
  }
  if (manifest.parent_manifest_sha256 !== null) {
    list.sha256(manifest, 'parent_manifest_sha256', 'parent_manifest_sha256')
  }
}

function hashMatches(manifest: Fields): boolean {
  const claimed = manifest.manifest_sha256
  if (typeof claimed !== 'string') return false
  try {
    return computeManifestSha256(manifest) === claimed
  } catch {
    // Values JSON cannot represent (NaN, BigInt, ...) cannot be hashed.
    return false
  }
}

/**
 * Verify `manifest_sha256` over the complete object as given, then check the
 * v1 structure. Every issue is reported, the hash mismatch first. On success
 * the input object itself is returned, typed; nothing is copied or
 * normalized.
 */
export function parseRenderManifest(value: unknown): ParseRenderManifestResult {
  if (!isFields(value)) {
    return {
      ok: false,
      issues: [
        {
          path: 'manifest',
          message: `must be a JSON object, got ${describeValue(value)}.`,
        },
      ],
    }
  }
  const list = new IssueList()
  if (!hashMatches(value)) {
    list.add(
      'manifest_sha256',
      'does not match the canonical content (tampered or corrupted).',
    )
  }
  checkHeader(list, value)
  checkSourceRaw(list, value)
  checkCalibration(list, value)
  checkLut(list, value)
  checkColorGraph(list, value)
  checkRenderParams(list, value)
  checkPolicy(list, value)
  checkEnvironment(list, value)
  checkOutput(list, value)
  return list.issues.length === 0
    ? { ok: true, manifest: value as unknown as RenderManifest }
    : { ok: false, issues: list.issues }
}
